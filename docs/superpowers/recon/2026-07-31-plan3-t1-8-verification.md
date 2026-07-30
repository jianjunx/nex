# Plan 3 Task 1-8 实现层核验（执行前设计关卡）

**日期**：2026-07-31
**核验对象**：`docs/superpowers/plans/2026-07-31-plan3-git-panel-rich.md` L76-2513（哨兵行 `<!-- PLAN-CONTINUES -->` 为止；Task 9-14 不在范围内）
**方法**：计划锚点 × 磁盘真实源码逐字核对；git2 0.19 / libgit2 1.8.1 / tokio 1.53.1 行为以本机 cargo registry vendored 源码（与 Cargo.lock 版本精确匹配）为权威实证；只读，未改任何文件、未做 git 操作。
**分级**：Blocker（执行必挂）／Risk（能跑但有隐患）／Note（可接受但应知会）。

---

## 维度结论

| # | 维度 | 结论 | 说明 |
|---|------|------|------|
| ① | 编译可行性（Rust） | **失败** | B3：stash 五连对 `&mut self` 方法用了不可变绑定，E0596 ×5。其余 API 全部实证正确（见下）。 |
| ② | 锚点真实性 | **通过** | 全部行号锚点与磁盘逐字吻合。 |
| ③ | 类型一致性 | **失败** | B4：`GitCredentialRequestPayload` 只进 tauri.ts 的 import 未 re-export，Task 8 从 tauri.ts 导入 → TS2305。 |
| ④ | 测试可运行性 | **失败** | B1/B2：两处错误消息映射与 libgit2 1.8.1 实际消息不符，两个 Rust 集成测试的中文断言必红。 |
| ⑤ | 设计漏洞扫描 | **通过** | 无 Blocker；2 个 Risk、5 个 Note，均可在 v1 接受或一行可修。 |

### ① 编译可行性细目（除 B3 外全部正确）

- git2 0.19：`checkout_tree/checkout_index/reset_default/merge_analysis/merge/revparse_ext/branches/find_branch/set_head/graph_ahead_behind` 均为 `&self`（`git2-0.19.0/src/repo.rs`），Task 1/2/5 用法正确；`CheckoutBuilder::new()` 默认 `GIT_CHECKOUT_SAFE`（`build.rs` L329-346、Default 委托 new() L695）——与计划"safe 语义 + 脏工作区冲突报错"预期一致；`RemoteCallbacks::credentials` 签名 `FnMut(&str, Option<&str>, CredentialType) -> Result<Cred, Error> + 'a`（`remote_callbacks.rs` L146-148）、`Cred::ssh_key/ssh_key_from_agent/userpass_plaintext/credential_helper`（`cred.rs` L45/56/98/121）与计划 network.rs 逐字一致。
- tokio 1.53.1：blocking pool 线程执行 `let _enter = rt.enter();`（`pool.rs` L471-474）只设 current handle 不置 `Entered` → broker 的 `spawn_blocking` 内 `Handle::current().block_on(rx + timeout)` 可用且不 panic（`handle.rs` L86-94、L352-376；`context/runtime.rs` enter_runtime L35-74 仅在已 Entered 时 panic）。
- Mutex guard 跨 await：broker request/respond 均为 take-then-await（锁内只取/插 HashMap，await 在锁外），无 guard 跨 await。
- serde / NexError：`NexError` `#[serde(tag = "type", content = "message")]`（`error.rs` L9-18）+ `From<git2::Error>`（L27-31），payload camelCase（`credentials.rs` 计划 L879-882 与 `watcher.rs` L33 先例一致）。
- Tauri command 签名：async fn + `State<'_, AppState>` + `AppHandle` 有先例（`agent_cmds.rs` L19/L24-26）；`AppState` manage（`lib.rs` L105-110）、`use tauri::Manager`（L1）、dialog 插件（L25）均就位；git 六连注册位 `lib.rs` L45-50，`git_commit` 在 L50。
- git_cmds.rs 既有 `use crate::git::types::*;`（通配导入 → 新增 `StashEntry` 自动入作用域，无需改 import）。

### ② 锚点真实性细目（全部吻合）

`lib.rs` L45-50 / L105-110 / L1 / L25；`git_cmds.rs` 导入块；`error.rs` L9-18、L27-31；`Cargo.toml` L30/L33/L34/L52；`watcher.rs` L18/L33；`commands.ts` GIT_COMMIT L33；`events.ts` FS_CHANGED L9、GitStatusChangedPayload L24-26；`tauri.ts` L4 import、git 段 L205-237、gitCommit L235-237、`// --- Terminal ---` L239、onGitStatusChanged L332-334；`git.store.ts` L9 解构 / L21-26 handleCommit / L58 / L74；`App.tsx` L99-100；`dialog.tsx` showCloseButton L50-57；`vite.config.ts` test 块（`environment: "node"`、globals 未开）；`package.json`（radix-ui ^1.6.7、vitest ^4.1.10、jsdom ^30、@testing-library/* 齐备）；`ui/input.tsx`、`ui/label.tsx`（radix Label.Root → 渲染 `<label>`，htmlFor 可用）；KeybindingsEditor.test.tsx 的 docblock + vi.mock 工厂先例。
唯二偏差见 N2（GitPanel L101 实际文本）与计划自身无影响项。

### ③ 类型一致性细目（除 B4 外全部一致）

16 个新命令名在 commands.ts ↔ tauri.ts ↔ store ↔ lib.rs 注册四处逐字一致；camelCase 参数转换一致；`GitCredentialRequestPayload` 字段（requestId/url/usernameHint/kind）在 Rust struct、events.ts、modal 三处逐字对齐；`onGitCredentialRequest`/`gitCredentialRespond` 封装全覆盖。

### ④ 测试可运行性细目（除 B1/B2 外可通过）

- file:// 裸远端构造（init_bare → add_remote("origin", file://…) → push → 本地再 push 触发非快进）步骤完整，`tempfile` dev-dep 就位（Cargo.toml L52）。
- broker 六用例：oneshot + timeout 语义、session 缓存命中、host_of/session_key 纯函数均经 tokio 源码实证可跑。
- git.store 测试：zustand(immer) 同步 set 在首个 await 前，mock 工厂闭包延迟读取，与既有 conversation.store.test.ts 模式同构。
- GitCredentialModal 测试：docblock jsdom 已含（计划 L2238）、afterEach cleanup 模式符合项目约定（计划 L15）、Label htmlFor↔Input id 接线正确（计划 L2450-2463）→ getByLabelText 可用。

---

## 发现列表

### Blocker ×4

**B1 — Task 1：checkout 脏工作区错误消息映射与 libgit2 不符**
- 位置：计划 L275-276（`checkout_branch` 映射 `msg.contains("overwritten") || msg.contains("lost")`）；测试 L167-179（`checkout_refuses_dirty_worktree_on_conflicting_paths`，断言 `contains("无法切换分支")`）。
- 实证：libgit2 1.8.1 safe checkout 遇脏冲突的消息是 `"N conflict(s) prevent checkout"`（`libgit2-sys-0.17.0+1.8.1/libgit2/src/libgit2/checkout.c` L1360-1366），既不含 "overwritten" 也不含 "lost"。
- 失败场景：函数返回原始英文错误 → 测试断言红，`pnpm test` 在 Task 1 即挂。
- 建议：映射条件改为 `msg.contains("conflict") && msg.contains("prevent checkout")`，或直接按 `e.code() == git2::ErrorCode::Conflict` 判定（更稳，不依赖文案）。

**B2 — Task 5：push 非快进错误消息映射与 libgit2 不符**
- 位置：计划 L1090、L1222-1223（匹配 `"non-fast-forward"`/`"failed to write ref"` → 「推送被拒绝」）；测试 L1159-1165（裸远端往返末段断言 `contains("推送被拒绝")`）；store 测试 L1810-1814 依赖同一中文字符串。
- 实证：libgit2 1.8.1 非快进拒绝发生在推送协商层，消息为 `"cannot push non-fastforwardable reference"` + `GIT_ENONFASTFORWARD`（`push.c` L323-349，"non-fastforwardable" 无连字符）；local transport 的 `local_push` 本身返回 0，拒绝走 status 列表（`transports/local.c` L379-497）。计划匹配串是子串也匹配不上（"non-fast-forward" ≠ "non-fastforwardable"）。
- 失败场景：中文映射永不触发 → `push_pull_round_trip_over_local_bare_remote` 末段红，且 store 的 push guard 测试（L1810-1814）虽因 mock 而绿，但真实链路文案为英文。
- 建议：匹配 `"non-fastforwardable"`（可并留 `"non-fast-forward"` 兼容旧 libgit2）；同时考虑匹配 `ErrorCode::NonFastForward`。

**B3 — Task 3：stash 五连对 `&mut self` 方法使用不可变绑定**
- 位置：计划 L659-701（`stash_save`/`stash_list`/`stash_apply`/`stash_pop`/`stash_drop` 均 `let repo = Repository::open(repo_path)?;`）。
- 实证：git2 0.19 中 `stash_save`(repo.rs L2859)、`stash_apply`(L2913)、`stash_foreach`(L2928)、`stash_drop`(L2947)、`stash_pop`(L2955) **全部 `&mut self`**。
- 失败场景：`cargo build` E0596 ×5（cannot borrow `repo` as mutable），Task 3 编译不过。
- 建议：五处一律 `let mut repo = Repository::open(repo_path)?;`（一行修法 ×5）。

**B4 — Task 6→8：`GitCredentialRequestPayload` 未从 tauri.ts re-export**
- 位置：计划 L1569（Task 6 只把 `type GitCredentialRequestPayload` 追加进 tauri.ts L4 的 **import** 列表）；计划 L2331（Task 8 credentialRequest.store.ts 写 `import type { GitCredentialRequestPayload } from "../../bridge/tauri"`）。
- 实证：tauri.ts 现有模式是 import 后在文件内定义封装函数、export 函数而非 re-export 类型；events.ts（L1560 对应计划段）才是该接口的定义处。
- 失败场景：TS2305（Module has no exported member）→ `pnpm build` 在 Task 8 挂。
- 建议：Task 6 在 tauri.ts 追加 `export type { GitCredentialRequestPayload };`，或 Task 8 改从 `"../../bridge/events"` 导入（后者更符合现有分层）。

### Risk ×2

**R1 — Task 5：pull 快进路径无条件覆盖未提交改动**
- 位置：计划 pull_remote 快进后 `checkout_head(force)` 段（L1267 附近）。
- 失败场景：用户有未提交改动且远端快进 → 改动被静默丢弃。注：git2 官方 clone/pull example 同款写法，但作为产品行为危险。
- 建议：快进前检查工作区 dirty，dirty 则改报中文提示「请先提交或存储改动后再拉取」，或先 `stash_save` 自动保护再 checkout、完成后提示。

**R2 — Task 5：push 错误映射为纯字符串匹配**
- 位置：计划 L1222-1223。
- 失败场景：pre-receive hook 拒绝、权限不足、保护分支等其他拒绝原因不命中两个匹配串 → 英文错误透传，中文化覆盖不全。
- 建议：保留兜底分支「推送失败：<原始消息>」做统一中文化包装；非快进可额外按 `ErrorCode::NonFastForward` 判定（与 B2 修复合并）。

### Note ×5

**N1 — Task 4：`app.emit` 失败泄漏一条 pending 表项**
- 位置：broker `request_gui`（先插 pending 后 emit，计划 L939 附近）。
- 说明：emit 实际基本不失败，且 120s timeout 会兜底移除；严格起见可把 insert 移到 emit 成功之后。

**N2 — Task 7：GitPanel L101 实际文本与计划表述不符**
- 位置：计划 Task 7 Step 5.3「三处 `disabled={loading}`（L58、L74、L101）替换为 `disabled={statusLoading || !!opRunning}`」。
- 实证：GitPanel L101 实为 `disabled={loading || !commitMsg.trim()}`，并非纯 `disabled={loading}`。
- 说明：照计划字面执行会丢掉 commitMsg 门控（空消息时按钮可点）；功能无损——计划 Step 5.2 的 `handleCommit` 有 `if (!commitMsg.trim()) return` 前置守卫——但属 UX 弱化。建议 Step 5.3 明确 L101 改为 `disabled={statusLoading || !!opRunning || !commitMsg.trim()}`。

**N3 — Task 4：remember 缓存粒度为 host；ssh 场景缓存的 username 未参与匹配**
- 说明：同 host 不同账号会命中同一缓存条目；计划已明示"会话内内存缓存、v1 可接受"。记录备查。

**N4 — Task 5：clone 无进度回调与取消**
- 说明：大仓库 clone 期间前端只能转圈等待；v1 可接受，后续可挂 `RemoteCallbacks::transfer_progress` + AbortHandle。

**N5 — Task 5：remote 名硬编码 "origin"**
- 说明：多 remote 仓库无法选择；v1 可接受，UI 层已按约定不暴露 remote 选择。

---

## 结论

Task 1-8 在**架构、锚点、类型链、tokio/tauri 语义**层面全部成立；但**不可直接执行**——4 个 Blocker 会让编译（B3）、类型检查（B4）和两个 Rust 集成测试（B1、B2）分别挂掉。四者修法都是一行级（mut 绑定 ×5、re-export/改导入路径 ×1、两条 `contains` 改匹配串）。修完 B1-B4 后，建议一并处理 R1（pull 覆盖改动）再进入执行。
