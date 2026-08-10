# NexAgent 上下文优化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 提升 Nex Native Agent 长会话中的上下文质量、prefix cache 命中率和稳定性，同时保持现有 coding workflow（工具调用、archive/history 回溯、session mode、多 provider）不��化。重点不再假设全局 `agent.contextWindow=0` 是主因，而是围绕“模型上下文窗口驱动的预算控制 + tool 输出分层 + 稳定摘要块 + working memory”一起落地优化。

**Architecture:** 现有 Native Agent 采用“session 初始化时注入稳定 system prompt / rules / AGENTS.md，之后 append-only transcript + 近阈值 compact/archive”的架构。此次优化不推翻该方向，而是在现有 `compact.rs`、`.nex-archive/`、`history` tool、`config.context_window_for(model)` 基础上升级为四层：
1. **Hard Budget Layer**：把模型 `context_window` 从“压缩参考值”升级为“请求前硬预算控制”；
2. **Output Tiering Layer**：把大 tool 输出从“原文长期挂在 transcript”改成“在线摘要 + archive/分页回读”；
3. **Stable Summary Layer**：把旧原始 transcript 折叠成结构化 summary message，保留最近 tail 与可回溯 archive；
4. **Working Memory Layer**：把当前任务状态从历史日志中抽离成稳定、小而高价值的 session memory block。

---

## 0. 现状与约束（必须先统一）

- 真实生效窗口来自 `NativeAgentConfig::context_window_for(composite_model_id)`：
  - 优先模型自己的 `model.contextWindow`
  - 没有时 fallback 到 `agent.contextWindow`
- 当前 `context_window` 只驱动 `compact::maybe_compress(...)`，**不是**严格请求预算控制。
- 当前 transcript 是 append-only；`compact.rs` 主要做：
  - snip 旧 tool results
  - fold 旧 assistant prose
  - archive 被改写的原文到 `.nex-archive`
- 当前长输出的 recoverability 已有基础设施：
  - archive 文件
  - `history` tool
  - background jobs output offset
- 优化必须保留以下能力：
  - 精准回溯此前读过/改过的内容
  - 多轮工具调用仍可工作
  - `ask/plan/code/auto` mode 语义不变
  - 三平台一致（macOS/Linux/Windows）
- 本方案优先优化 DeepSeek / OpenAI-compatible provider；不同 provider 的 cache 语义不同，收益预期不能简单等同。

---

## 1. Phase 1 — Hard Budget 控制（最高优先级）

### Why
当前最根本的问题不是有没有 `context_window`，而是**即便有模型窗口，也没有严格保证发给 provider 的 messages 一定落在预算内**。这会导致：
- compact 触发过晚或不够彻底；
- transcript 尾部虽然被部分折叠，但整体仍然过大；
- cache 可复用前缀占比下降；
- 不同 provider/tokenizer 下边界表现不可预测。

### Deliverables
- [ ] 在 Native Agent 请求前引入统一的 `ContextBudget` 计算模块（建议新文件 `src-tauri/src/agent/native/budget.rs`）
- [ ] 把 `context_window_for(model)` 的结果转成“本轮 prompt 可用预算”
- [ ] 将单次 `maybe_compress` 升级为“循环收敛直到低于预算或触及最小可保留上下文”
- [ ] 为 provider 保留响应余量和安全边际，避免 prompt 吃满窗口
- [ ] 在日志/调试信息中记录：原始估算 tokens、压缩后估算 tokens、预算、是否命中 hard budget
- [ ] 为 reasoning-heavy model 与普通模型区分响应预留策略

### Algorithm
预算公式不能只靠固定常数拍脑袋，必须具备 provider-aware 与 model-aware 兜底：

```text
model_window = cfg.context_window_for(model_id)
if model_window == 0 => compression disabled (现状兼容)
else:
  reserved_response = provider_hint_or_default(model_id)
  safety_margin = tokenizer_uncertainty_margin(model_window)
  prompt_budget = model_window - reserved_response - safety_margin
```

### Default Policy（首版建议）
在 provider 还没暴露显式预算前，先采用保守默认：

- 普通模型：
  - `reserved_response = max(4096, model_window * 10%)`
- reasoning-heavy 模型：
  - `reserved_response = max(8192, model_window * 15%)`
- `safety_margin = min(max(2048, model_window * 3%), 8192)`

注意：
- 这些默认值**只作为临时策略**，不是长期真理；
- 预算模块必须允许 provider 后续覆盖；
- 当 `model_window < reserved_response + safety_margin + 1024` 时，应进入“小窗口保守模式”。

### Small-Window Conservative Mode
如果 `prompt_budget <= 0` 或者窗口异常偏小：
- [ ] fallback 为保守固定预算（初版 `4096`）
- [ ] 打 warning 日志并打指标
- [ ] 明确标记这是 degraded path，不应当成为常态

### Compression Loop
将现有：
- `compact::maybe_compress(messages, env.context_window, archive_dir)`

升级为：
- [ ] `for step in 0..MAX_COMPACT_PASSES { ... }`
- [ ] `MAX_COMPACT_PASSES` 初版建议 5
- [ ] 每次迭代后重新估算 tokens
- [ ] 达标就退出
- [ ] 未达标则分级执行：
  1. snip 旧 tool results
  2. compact old assistant prose
  3. force compact
  4. summary replacement（Phase 2 接入后优先于进一步粗暴折叠）
- [ ] 超过最大迭代仍未收敛：
  - 返回带调试数据的软错误，或
  - 进入明确的最后 fallback（例如丢弃最早可折叠消息）
  - 绝不能静默死循环

### Quality Guardrails
- [ ] compact 到 step ≥ 3 时，禁止继续无脑 snip，必须优先 summary
- [ ] 保留最近关键失败/错误消息（如最近 1 个 error tool result）
- [ ] 保留最近关键决策块，避免“模型失忆”

### Files
- `src-tauri/src/agent/native/session.rs`
- `src-tauri/src/agent/native/compact.rs`
- `src-tauri/src/agent/native/config.rs`
- `src-tauri/src/agent/native/provider/mod.rs`
- `src-tauri/src/agent/native/provider/deepseek.rs`
- 新增：`src-tauri/src/agent/native/budget.rs`

### Tests
- [ ] 模型 `context_window` 存在时，预算来自模型而不是全局 fallback
- [ ] `context_window=0` 保持现状（不压缩）
- [ ] 超预算 transcript 会循环 compact 直到低于预算
- [ ] 预算极小/模型元数据异常时 fallback 合理
- [ ] reasoning-heavy model 使用更高响应预留
- [ ] `MAX_COMPACT_PASSES` 生效，避免无限循环

---

## 2. Phase 1 — Tool 输出分层（与 Hard Budget 同级）

### Why
缓存命中率低的更直接原因，是 transcript 长期保留大量原始工具输出：
- `read_file`
- `grep`
- `bash`
- `run_in_background`
- MCP 输出
- subagent 结果

这些内容变化快、体积大、复用率低，应该尽快从“在线推理上下文”中降级出去。

### Deliverables
- [ ] 定义统一的“在线输出上限”策略：短输出直进 transcript，中输出截断，长输出摘要化 + 提示回读
- [ ] 让 `bash` / `jobs` / `history` / `subagent` 等工具共享同一种输出 tiering 规则
- [ ] 为关键大输出提供稳定的回读句式，减少 transcript 中的随机性文本
- [ ] 对 MCP proxy 输出做同样的 tiering
- [ ] 为所有被截断输出增加“你当前看到的是部分内容”的显式信号

### Output Tiers
建议统一成三层：

1. **Inline**（小）
   - 直接进入 transcript
   - 适合：几十行以内、几 KB 内

2. **Preview**（中）
   - 只保留：摘要 + 首尾片段 + 总长度/总命中数/exit code
   - 附带明确回读方式（分页、offset、history ref 等）
   - 必须带上“此结���已截断”的稳定提示

3. **Archived**（大）
   - transcript 中只留稳定摘要
   - 全文写 archive 或工具自身已有引用文件
   - 必须在摘要中明确 archive ref / job_id / offset continuation

### Important Rule
摘要文本要尽量**模板化、稳定**，同时要显式告知模型“当前信息不完整”。例如：

```text
bash output truncated (18432 chars, exit 0).
Full output remains in background job buffer.
Use bash_output(job_id=..., offset=...) to inspect more before concluding.
Preview:
...
```

不要每次用自由文本随意描述，这会降低 prefix 复用率，也会让模型误以为自己已经看到了完整结果。

### Quality Guardrails
- [ ] 对“被截断输出”统一加截断标记
- [ ] 让模型知道继续推理可能基于不完整信息
- [ ] 对高风险工具结果（build/test errors、grep 大命中、MCP 长 JSON）优先保留关键信息而不是机械首尾截断

### Files
- `src-tauri/src/agent/native/tools/bash.rs`
- `src-tauri/src/agent/native/tools/jobs.rs`
- `src-tauri/src/agent/native/tools/fs.rs`
- `src-tauri/src/agent/native/tools/search.rs`
- `src-tauri/src/agent/native/tools/subagent.rs`
- `src-tauri/src/agent/native/mcp.rs`
- 可新增：`src-tauri/src/agent/native/tools/output_tiering.rs`

### Tests
- [ ] 长 `bash` 输出只保留模板化摘要和预览
- [ ] `run_in_background` 输出永远分页，不把整段灌进 transcript
- [ ] 大文件读取/grep 命中数超限时，transcript 里留下稳定格式
- [ ] MCP 长 JSON/文本结果被摘要化而不是完整保留
- [ ] 所有 Preview/Archived 路径都带“当前结果不完整”标记

---

## 3. Phase 2 — 稳定摘要块（Stable Summary Layer）

### Why
当前 compact 更多是“删减原文”，但对长会话最有价值的是：
- 用稳定、结构化的 summary message 替换旧日志流
- 把“已确认事实”留在线上，把“原始轨迹”下沉到 archive

### Deliverables
- [ ] 为旧 transcript 区段生成结构化 summary message
- [ ] summary 进入 `messages` 作为标准 `assistant`（首版建议固定 role，避免误提升 trust level）
- [ ] 被替换区段原文 archive 到 `.nex-archive`
- [ ] `history` 工具继续可搜索被替换原文
- [ ] summary 明确指向 archive ref，而不是泛泛地说“可用 history 搜索”

### Summary Format
建议固定模板，并统一使用与 system prompt 一致的语言（当前仓库默认中文）：

```text
[session summary]
Goal:
- ...

Facts established:
- ...

Files inspected:
- path: why it mattered

Changes made:
- file -> change summary

Open questions:
- ...

Archived details:
- archive ref: ...
- recover with history query if needed
```

### Replacement Strategy
- 永远保留：
  - system prompt
  - rules / AGENTS.md 注入结果
  - 最近 N 条消息（建议 6~10）
- 允许折叠：
  - 更老的 user / assistant / tool 区段
- 折叠触发条件：
  - 第二次及之后仍超预算
  - 或连续多轮 compact 后收益不足
- “收益不足”初版定义：
  - 本轮 compact 后 `estimate_tokens` 降幅 < 5%
  - 且仍高于预算

### Stability Requirement
summary 的生成必须尽量：
- 结构固定
- 字段顺序稳定
- 语言固定
- 避免每轮重写全部 summary
- 优先“增量更新最后一个 summary block”或“按 chunk 追加新的 summary block”

### Archive Recoverability
- [ ] 每个 summary block 必须带 archive ref
- [ ] `history` 搜索必须能检索到 summary 所引用的 archive 内容
- [ ] 验证 summary 不会遮蔽 archive 的真实检索入口

### Prompt-Safety Guardrail
- [ ] summary 内容不能被当成高信任指令
- [ ] 工具输出转 summary 时要做注入降权/清洗
- [ ] summary 角色保持 assistant，不使用 system

### Files
- `src-tauri/src/agent/native/compact.rs`
- 新增：`src-tauri/src/agent/native/summary.rs`
- `src-tauri/src/agent/native/session.rs`
- `src-tauri/src/agent/native/archive.rs`
- `src-tauri/src/agent/native/tools/history.rs`

### Tests
- [ ] summary 替换后总 token 显著下降
- [ ] 最近 tail 不受影响
- [ ] archive 保存了被替换原文
- [ ] 重复 compact 不会反复重写同一个 summary block（避免抖动）
- [ ] `history` 能检索到 summary 指向的 archive 内容

---

## 4. Phase 2 — Working Memory（与 Summary 同级，不再降级为后续可选）

### Why
长会话里模型真正需要的不是全部历史，而是“当前工作状态”。把这部分显式化，能减少它对 transcript 恢复能力的依赖。

### Deliverables
- [ ] 引入 session 级 working memory（首版保持轻量，但不要过度强字段化）
- [ ] memory 记录：
  - 当前目标
  - 已读关键文件
  - 已完成修改
  - 当前计划
  - 未决问题
  - 以及必要的自由文本“软状态”段
- [ ] 每轮在发 provider 前插入稳定 memory block
- [ ] memory 更新规则初期由系统代码维护，不让模型自由重写整块历史

### Initial Placement
建议先把 memory block 放在：
- system prompt 之后
- rules/AGENTS 注入之后
- transcript 之前

这样它是“稳定高优先级上下文”，比埋在旧 history 深处更好用。

### Memory Shape
首版不要完全硬字段化。建议结构为：
- 固定字段：Goal / Files / Changes / Open Questions
- 额外自由文本段：`State Notes`

原因：
- 纯硬字段化会丢掉复杂任务里的“软状态”
- 完全自由文本又会失控
- 混合结构更稳妥

### Stability Requirement
- [ ] memory 只在关键状态变化时更新
- [ ] 更新要做抖动抑制（内容基本不变则不重写）
- [ ] memory 语言固定，与 summary/system prompt 一致
- [ ] memory block 不得每轮大幅改写，否则会破坏前缀 cache

### Prompt-Safety Guardrail
- [ ] memory block 不提升为 system 权限
- [ ] memory 中记录的是状态，不是执行命令
- [ ] 从工具输出或用户输入提取 memory 时要避免注入式复制

### Files
- 新增：`src-tauri/src/agent/native/memory.rs`
- `src-tauri/src/agent/native/mod.rs`
- `src-tauri/src/agent/native/session.rs`

### Tests
- [ ] memory block 只在关键状态变化时更新
- [ ] 普通 turn 不会无意义重写 memory（避免 cache 抖动）
- [ ] long session 中 memory 覆盖关键状态，history 大量压缩后仍能继续工作
- [ ] 自由文本 State Notes 能承载硬字段装不下的状态

---

## 5. Phase 3 — 自动检索 archive（可选，高收益深改）

### Why
当前 archive 只能等模型主动调用 `history` 搜。更理想的是：
- 在发请求前，自动把最相关的 archive 摘要回灌少量上下文
- 让 transcript 可以更 aggressively 压缩

### Deliverables
- [ ] 抽取 archive 文档索引接口
- [ ] 在 prompt 前基于当前 user turn 做轻量检索
- [ ] 限制检索条数、总字节数，避免反向膨胀
- [ ] 只注入高分摘要，不直接注入原始 archive 文本

### Caveat
这个阶段必须严格控量，否则会把“压缩收益”重新吃回去。

---

## 6. 观测与指标（没有指标就不要上线）

### 需要新增的 runtime 指标
- [ ] `prompt_tokens`
- [ ] `cache_hit_tokens`
- [ ] `cache_hit_ratio = cache_hit_tokens / prompt_tokens`
- [ ] `pre_compact_estimated_tokens`
- [ ] `post_compact_estimated_tokens`
- [ ] `summary_blocks_count`
- [ ] `archived_message_count`
- [ ] `tool_output_tier_counts`（inline/preview/archived）
- [ ] `memory_block_updates`
- [ ] `memory_block_bytes`
- [ ] `degraded_budget_fallback_count`
- [ ] `summary_recoverability_failures`

### 推荐验证维度
- 短会话（1~3 turn）
- 中等 coding 会话（10~20 turn）
- 长 tool-heavy 会话（30+ turn，含多次 read_file/grep/bash）
- MCP-heavy 会话
- subagent-heavy 会话
- reasoning-heavy model 会话

### 成功判据（建议）
- [ ] 长会话 `cache_hit_ratio` 中位数明显提升
- [ ] 平均 prompt token 降低
- [ ] 不增加关键任务失败率
- [ ] `history` 回溯成功率不下降
- [ ] summary / memory 引入后，长会话连续推理稳定性提升
- [ ] reasoning-heavy model 的回答完整度不下降

---

## 7. 兼容性与风险控制

### 必须避免的退化
- [ ] 压缩过度导致模型忘记已修改文件/已验证结论
- [ ] transcript 变短但关键 tool 结果无法回读
- [ ] 不同平台 shell/path 行为被上下文优化误伤
- [ ] summary 文本抖动过大反而降低 cache
- [ ] memory block 高频重写，反而破坏稳定前缀
- [ ] 模型在看到截断输出后仍误以为自己拥有完整信息

### 风险缓解
- [ ] 每个阶段都加 feature flag 或 config gate
- [ ] 先默认启用 Phase 1（hard budget + output tiering）
- [ ] Phase 2 的 summary/memory 先 behind flag，再按指标灰度
- [ ] 提供 verbose debug logging，便于观察压缩与摘要/记忆更新决策
- [ ] provider 差异通过 `budget.rs` / provider trait 逐步显式化，而不是写死在通用逻辑里

---

## 8. 推荐实施顺序（Tracer Bullet）

### Ticket 1 — Hard Budget 骨架
- [ ] 新建 `budget.rs`
- [ ] 计算 `prompt_budget`
- [ ] 接到 `run_turn` 发送前
- [ ] 打调试日志
- [ ] 区分 reasoning-heavy 与普通模型默认预留
- [ ] 把默认 `agent.contextWindow` 调整为合理初始值（作为 Phase 1 起效前置）
- [ ] 抽出 `compact::step(messages, level)` 与现有 `maybe_compress` 解耦，供循环调用

### Ticket 2 — Compact 循环收敛
- [ ] 将单次 `maybe_compress` 升级为有上限的循环
- [ ] 增加 force compact 分级
- [ ] 为预算不足提供可观测错误
- [ ] 接近 force compact 时优先 summary
- [ ] Subagent 也走相同的 compact 循环（继承父 session context_window）

### Ticket 3 — Output Tiering
- [ ] 抽公共 tiering helper（只提供 marker / 判定）
- [ ] 升级 `truncate_output` 为带稳定提示的截断
- [ ] 先接入 `bash` / `jobs`
- [ ] 再接 `fs` / `search` / `subagent` / MCP
- [ ] 所有 truncation 都输出稳定“不完整信息”提示

### Ticket 4 — Stable Summary Prototype
- [ ] 新建 `summary.rs`
- [ ] 只对旧 assistant/tool-heavy 区段生成 summary
- [ ] archive 原文
- [ ] summary 中加入 archive ref（包含 session_id）
- [ ] archive 路径加入 session_id 子目录
- [ ] `history` 工具增加 `archive_ref` 参数
- [ ] `replace_prefix_with_summary` 保持 pairing invariant
- [ ] behind flag

### Ticket 5 — Working Memory Prototype
- [ ] 新建 `memory.rs`
- [ ] 先维护最小字段集（Goal / Files / Changes / Open Questions）
- [ ] 加入 `State Notes` 自由文本段
- [ ] 第一版采用“系统驱动”更新（文件变更 / 工具错误 / 任务轮转）
- [ ] 模型不直接覆写 memory
- [ ] 注入到 prompt 组装链路
- [ ] behind flag

### Ticket 6 — Metrics & Evaluation
- [ ] 抽象 `ContextStats` 数据结构
- [ ] 记录缓存/压缩/summary/memory 指标
- [ ] 通过 `prompt` response meta 透出
- [ ] 与 sessions archive 一并落盘
- [ ] 对比优化前后长会话表现
- [ ] 单独验证 reasoning-heavy model 质量不下降

---

## 8.5. Answer Quality 风险与对策

### 风险 A：模型基于截断输出继续推理
- 触发条件：tool 输出被 Preview/Archived，但模型未回读
- 对策：
  - 所有截断输出加稳定提示
  - 在高风险结果中保留关键信息
  - 增加指标统计模型后续是否继续回读

### 风险 B：summary 替换掉原始 debug 细节
- 触发条件：旧 transcript 被压成 summary，原始错误只留 archive
- 对策：
  - summary 明确 archive ref
  - history 必须能检索 archive
  - 最近关键 error/tool result 不可过早折叠

### 风险 C：memory 过度结构化，丢掉软状态
- 触发条件：复杂设计/调试状态无法装进固定字段
- 对策：
  - 引入 `State Notes`
  - 保持混合结构而非纯 schema

### 风险 D：reasoning-heavy model 回答被压短
- 触发条件：响应预留不足
- 对策：
  - 为 reasoning-heavy model 提高 `reserved_response`
  - 将其纳入质量回归验证

### 风险 E：summary / memory 变成 prompt injection 新入口
- 触发条件：tool 输出被不加处理地复制到 summary/memory
- 对策：
  - 不提升为 system 权限
  - 做清洗/降权
  - 明确它们是状态描述，不是执行指令

---

## 8.6. 可执行性审查发现（Implementation Readiness Review）

本节是在阅读现有代码后补充的“实际会踩到的点”，避免 Phase 1/2 落地时发现范围估计不足。

### 实施风险 1：`maybe_compress` 不是循环，方案里要补重构
- 现状：`compact::maybe_compress(messages, window, archive_dir)` 单次只跑一个 tier。
- 方案里“循环直到达标”在不重构现有函数下无法直接生效。
- 补充工作：
  - [ ] 把 `decide()` 与执行拆开
  - [ ] 提供 tier-step 算子供 orchestrator 调用
  - [ ] 保留现有的 snip 幂等性
  - [ ] 在循环每步重新 `estimate_tokens` 并记录指标

### 实施风险 2：默认 `context_window=0` 会让 Phase 1 不生效
- 现状：默认 `agent.contextWindow = 0`，`context_window_for` 返回 0 → 压缩完全跳过。
- 补充工作：
  - [ ] 把默认 `agent.contextWindow` 调整为合理初始值（例如 32k）并写明这是“Phase 1 起效的前置条件”
  - [ ] 旧会话升级策略（不能直接覆盖用户已配的 0）

### 实施风险 3：Subagent 走独立 `context_window = 0` 路径
- 现状：`session.rs::run_subagent` 构造 `TurnEnv` 时硬编码 `context_window: 0`。
- 影响：主会话压完后，subagent 仍会原样膨胀，最后又被主会话接收，Phase 1 收益被部分抵消。
- 补充工作：
  - [ ] `SubagentHarness` 增加 `context_window` 字段
  - [ ] 父 session 创建 harness 时透传 `cfg.context_window_for(model)`
  - [ ] 在 tests 里覆盖 subagent 也会被 compact

### 实施风险 4：Tool 输出形态不一致，公共 helper 不能替代 truncate
- 现状：`bash` / `jobs` / `subagent` / `MCP` 输出字符串形态各不相同。
- 补充工作：
  - [ ] `output_tiering.rs` 只放统一 marker 与判定，不替代各工具自己的截断
  - [ ] 在 `bash.rs` 升级 `truncate_output` 或替换它：带“输出已被截断”提示与回读指引
  - [ ] 在 `jobs.rs` 的 `bash_output` 路径保留稳定提示

### 实施风险 5：`history` 工具当前没有 archive_ref 参数
- 现状：`History::schema()` 只有 `query` / `max_results`。
- 影响：summary 写出来的 archive ref，模型没办法精确按 ref 检索，只能靠 BM25 猜。
- 补充工作：
  - [ ] `history` 增加 `archive_ref` 参数
  - [ ] schema 描述里写出用法
  - [ ] 实现里优先按 ref 过滤再 BM25

### 实施风险 6：archive 路径按 cwd hash 分桶，跨 session 串扰
- 现状：`archive_dir_for(cwd)` 用 cwd 的 DefaultHasher digest 作为子目录名。
- 影响：同 cwd 下不同 session_id 共用 archive；summary 里的 archive ref 不能跨 session 安全指向。
- 补充工作：
  - [ ] archive 路径加入 `session_id`，例如 `cwd-hash/session-id/*.jsonl`
  - [ ] summary 中引用必须包含 session_id
  - [ ] history 工具检索时支持限定 session_id

### 实施风险 7：messages splice 要保证 pairing invariant
- 现状：`compact::compact(messages, ...)` 已经严格保留 assistant↔tool pairing。
- 影响：插入 summary block 必须不破坏 pairing，否则 model/tool_call_id 解析会出问题。
- 补充工作：
  - [ ] 抽出 `replace_prefix_with_summary(messages, summary_block)`
  - [ ] 复用 `KEEP_TAIL_MESSAGES` 边界计算
  - [ ] 新增测试：splice 后所有 tool message 的 `tool_call_id` 都能在之前找到对应 assistant

### 实施风险 8：memory 谁有权改写要明确
- 现状：system prompt 没有 memory 写入工具；模型没有受控入口。
- 影响：如果 Phase 2 让模型自由改写 memory，会同时破坏 cache 稳定性与 prompt 安全。
- 补充工作：
  - [ ] 第一版采用“系统驱动”更新：
    - file change → files 列表
    - tool error → open questions 追加
    - 任务轮转 → goal 重置
  - [ ] 模型**不**直接改写 memory block
  - [ ] 评估后再考虑模型辅助更新

### 实施风险 9：BM25 检索成本随 archive 增长
- 现状：`history` 每次重新读整个 archive 目录所有文件并分词。
- 影响：长会话下 archive 持续增长，单次 history 查询成本线性上升。
- 补充工作：
  - [ ] Phase 3 之前不能假设当前 `history` 直接接自动 retrieval
  - [ ] 引入最小索引层（最近 N 个 jsonl + 增量缓存）
  - [ ] 设置每次 history 查询的时间上限与成本上限

### 实施风险 10：指标基础设施还没接入
- 现状：现有 `Usage` 只在 deepseek 流里解析 usage 字段，缺少统一的上下文侧 metrics。
- 补充工作：
  - [ ] 抽象 `ContextStats { pre/post, cache_hit_ratio, compactions, tier_counts }`
  - [ ] 通过现有 `prompt` response meta 透出（已经有 `_meta.hadMutations`）
  - [ ] 与 sessions archive 一并落盘，供后续诊断

---

## 9. 我对当前仓库最合适的落地建议

**建议把 Phase 1 和 Phase 2 一起立项，但分批交付。**

理由：
- 现有代码已经有 `compact.rs` / `archive` / `history` 这套基础设施；
- 只做 Phase 1，能解决“上下文太大”，但不能很好解决“压缩后该保留什么”；
- `summary + memory` 与 hard budget / output tiering 是互补关系，不是替代关系；
- 如果没有 summary / memory，长会话仍然会过度依赖原始 transcript 恢复任务状态；
- 最稳妥的做法不是一次性全量上线，而是：
  - 先交付 Phase 1 的 hard budget + output tiering
  - 紧接着交付 Phase 2 的 summary + 轻量 working memory
  - Phase 3 的自动 archive retrieval 继续作为后续增强

### 可执行性层面的额外提醒
- Phase 1 表面上是“单层”，但代码层涉及 `compact.rs` 重构、subagent 路径、`agent.contextWindow` 默认值变更，不只是加一个 `budget.rs`。
- Phase 2 表面上是“加 summary 和 memory”，但要求 archive 路径重构、`history` 工具扩 schema、pairing invariant 测试，范围会跳一档。
- 实际人工判断：Phase 1 中等成本，Phase 2 中高成本，Phase 3 高成本。
- 因此建议采取“能随时只交一部分”的设计：每个 ticket 都要可独立开关，不被下一个 ticket 硬依赖。

---

## 10. 最终建议（拍板版）

### 立即立项范围
- [ ] Phase 1: Hard Budget（含 compact 重构、subagent 路径、默认 contextWindow 调整）
- [ ] Phase 1: Output Tiering（含 `truncate_output` 升级）
- [ ] Phase 2: Stable Summary Layer（含 archive 路径重构、`history` schema 扩参）
- [ ] Phase 2: Working Memory（系统驱动版）
- [ ] Metrics & Evaluation

### 建议交付顺序
- [ ] 第一批：Hard Budget + Output Tiering + Metrics
- [ ] 第二批：Stable Summary Layer + 轻量 Working Memory
- [ ] 第三批：按数据决定是否推进自动 archive retrieval

如果只允许优先做两件事：

> **先把模型 `context_window` 变成真正的请求前硬预算控制。**
> **然后尽快补上稳定 summary 和轻量 working memory。**

第一件事解决“上下文装多少”，第二件事解决“上下文里该留下什么”。
