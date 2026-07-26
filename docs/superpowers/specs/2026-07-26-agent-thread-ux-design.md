# Agent 会话 UX 对齐 Zed（Thread + Composer）

日期：2026-07-26

## 背景

Nex 后端已移植 Zed 的 ACP registry / launch / binary；前端仍是「消息气泡 + 工具摘要 Chip + 纯文本输入」。本阶段将会话展示与 Composer 对齐 Zed `acp_thread` / `agent_ui` 的信息架构，视觉保持 Nex 液态玻璃。

## 决策

- 参考源：Zed 公开源码行为 + ACP 协议；不读本机 Zed 仓
- 范围：全量一期 — 消息流（thinking / tool / plan / ask）+ Composer（mode / config / `/` / `@文件`）+ 三工具白名单
- 架构：Thread Entry 模型（对齐 Zed `AgentThreadEntry`），不用扁平 `Message` 打补丁
- `@`：仅文件提及
- 工具卡：可展开文本 / unified diff；不做内嵌 multibuffer 或 tool terminal
- 权限：主路径挂在工具卡；`PermissionModal` 作兜底
- Agent 白名单（新建对话下拉）：`claude-acp`、`codex-acp`、`cursor`；设置页仍可管理 custom，本阶段新建对话不展示非白名单项

## 架构

```
Agent ACP stdio
  → acp_adapter / AgentSessionManager
  → Tauri events (agent-notification | agent-permission-request)
  → agent.store.applySessionUpdate
  → entriesByConversation + sessionMeta
  → ThreadView + AgentComposer
```

会话展示真相源是 `ThreadEntry[]`，不是旧的 `Message[]`。

## 数据模型

### ThreadEntry

- `user_message` — 用户文本（乐观插入；忽略 agent 回显的 `user_message_chunk`）
- `assistant_message` — chunks：`message` | `thought`
- `tool_call` — id / title / kind / status / content / 可选权限 options
- `completed_plan` — 计划全部完成后的快照条目

### 会话级 live 状态（非 entry）

- `plan` — composer 上方活动条
- `availableCommands` — `/` 补全
- `modes` / `currentModeId` — Mode 选择器
- `configOptions` — model / effort 等动态配置
- `status`: `idle` | `running` | `waiting`

### SessionUpdate 处理

| sessionUpdate | 行为 |
|---|---|
| `agent_message_chunk` | 追加 assistant message chunk |
| `agent_thought_chunk` | 追加 thought chunk |
| `tool_call` / `tool_call_update` | upsert 工具卡 |
| `plan` | 更新 live plan；全完成可 snapshot |
| `available_commands_update` | 更新斜杠命令 |
| `current_mode_update` | 更新当前 mode |
| `config_option_update` | 更新 config options |
| `user_message_chunk` | 忽略（已有乐观用户消息） |

### 权限

- `request_permission` 到达 → 对应 `tool_call` 标为 `waiting_for_confirmation` 并挂 options；`status → waiting`
- 用户在工具卡上选择 → `respondPermission`
- 无关联 tool / 视口外 → `PermissionModal` 兜底
- resolve / cancel → 清除 waiting，恢复 status

## UI

### ThreadView

- Thinking：可折叠「Thinking」块
- Assistant：流式 markdown
- Tool 卡：kind + title + status；展开 content/diff；waiting 时卡内选项
- Completed plan：线程内卡片
- 活动 Plan：composer 上方

### AgentComposer

- 输入区 + `@` 文件 chips
- 底栏：Mode、Config options（有则显示）、Send/Cancel
- `/`：基于 `availableCommands` 补全
- `@`：`fs_search` / `fs_read_file`；发送组装 `ContentBlock[]`

## 后端

- `send_prompt` 接收 `ContentBlock[]`
- `agent_set_session_mode` / `agent_set_session_config_option`
- `new_session` 初始 modes / config 交给前端
- permission 事件附带 `toolCallId`（若协议有）
- `list_servers` 默认过滤白名单三 id

## 非目标

- 内嵌 multibuffer / tool terminal
- 全量 `@` mention（符号、diagnostics、git diff 等）
- MCP elicitation UI
- 消息磁盘持久化
- 读 Zed `settings.json`
- 开放全部 registry agents

## 验收

- 新建对话仅显示 Claude Code / Codex / Cursor
- 会话中可见：assistant 文本、thinking、tool 卡（含更新）、plan、权限选项
- Composer 在 agent 提供能力时显示 mode/config；`/` 与 `@文件` 可用
- 切 tab/项目不杀进程；关 tab teardown；waiting 指示正确
