# CLAUDE.md

Nex 是个 Tauri 2 桌面应用，把多个 AI 编程 agent（Claude Code、Codex、
Cursor CLI 等）塞进同一个 GUI 工作区。后端是 Rust，前端是 React +
TypeScript + CodeMirror + xterm.js。

## 构建 & 运行

```bash
# 安装（一次性）
pnpm install

# Dev 模式（带 GUI）
pnpm tauri dev
# 或：pnpm dev:app

# 前端测试
pnpm test                           # vitest run

# 后端测试
cd src-tauri && cargo test

# Lint
pnpm lint                           # oxlint（前端）
cd src-tauri && cargo clippy --tests

# 生产打包（.dmg / .msi / .AppImage）
pnpm tauri build
```

## 架构

### 后端（`src-tauri/src/`）

- `agent/` — agent 插件编排（应用核心）
  - `registry.rs` — 拉取开放的 ACP registry
    （`https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json`）
  - `node_runtime.rs` — 自管 Node.js 运行时。三种实现：
    `SystemNodeRuntime`（`which_in` 找系统的）、
    `ManagedNodeRuntime`（从 `nodejs.org/dist/index.json` 下载最新 LTS，
    校验 v8/npm/openssl 楼层）、`UnavailableNodeRuntime`。
    版本运行时发现 —— **不要硬编码 Node 版本**。
  - `package_cache.rs` — 每个 agent 的 npm install 缓存，路径在
    `<app_data>/agent-packages/<id>/<spec>/`。查实际
    `node_modules/<pkg>` 用 `package_name_from_spec`（不是 `sanitize`）；
    LRU 淘汰，每个 agent 只保留最近 3 个版本。
  - `launch.rs` — `resolve_registry` 返回 `LaunchSpec`，格式是
    `<node> <bin> <args>`（绝不调 `npx`）。`LaunchSpec` 只传给
    `spawn_agent`；ACP adapter 只看日志不解析内部。
  - `shell_env.rs` — 抓用户登录 shell 的 PATH。Unix 跑
    `$SHELL -ilc 'env -0'`；Windows 跑 `cmd /U /C set`（UTF-16LE 解码）。
  - `acp_adapter.rs` — ACP-over-stdio 传输；`HANDSHAKE_TIMEOUT`
    **120s**（首次 install + bootstrap 可能慢）。
  - `server.rs` — facade；`AgentSessionManager` 是唯一入口。
- `commands/` — 暴露给前端的 Tauri 命令处理函数。
- `db/`、`git/`、`terminal/`、`watcher.rs`、`fs/` — DB / git /
  PTY / 文件系统服务。
- `error.rs` — `NexError` 枚举；`AgentNotInstalled { what, hint }`
  variant 给用户能采取行动的安装失败提示。

### 前端（`src/`）

- `bridge/tauri.ts` — Rust 类型的 TS 镜像 + 命令函数。
- `stores/` — Zustand stores（agent / conversation / project / ui）。
- `features/` — 按特性分目录：`agent/`、`editor/`、`files/`、
  `git/`、`layout/`、`projects/`、`search/`、`settings/`、
  `terminal/`。
- `commands/` — TS 侧命令调用。
- `components/ui/` — shadcn 风格原语组件。

## 约定

- Commit 消息用 Conventional Commits：`feat:`、`fix:`、
  `refactor:`、`style:`。主题行不超过 ~80 字符。每条 commit 末尾
  加 `Co-Authored-By: Claude <noreply@anthropic.com>`。
- 所有 commit author 用 `JJ.Xie <jj.xie@outlook.com>`（per-repo
  设 `git config user.{name,email}`，**不要** global —— 公司
  邮箱 `ztn.com` 绝不能出现在本项目历史里）。
- 后端全程用 `std::sync::Mutex`（匹配现有风格）；
  `tokio::sync::Mutex` 只允许在 `PackageCache` 里用（飞行中
  install 去重 map）。
- 前端测试在文件旁边（`X.test.tsx` / `X.test.ts`）；后端测试
  在同文件底部 `#[cfg(test)] mod tests` 里。

### 多平台兼容（强制）

Nex 在 macOS、Linux、Windows 上跑。**新加的功能必须三个平台都
可用，不能在某个平台能跑、另一个平台直接报错**。具体规则：

- `#[cfg(target_os = "...")]` 或 `cfg!(windows)` 用之前先想：
  是不是能在所有平台做。如果只在某平台有意义，把分支里要做
  的事**降级**到其他平台（用 process PATH 兜底、用
  `tokio::sync::watch` 而非 shell 进程……），而不是直接返回
  "platform not supported" 错误。
- 平台特异的命名要映射：Node release 用 `win-x64` /
  `win-arm64`，不要拼出 `windows-x86_64`；`index.json` 的
  `files` 项是 artifact-specific 名（`osx-arm64-tar`、
  `win-x64-zip`），不是 release 名。两份映射都在
  `node_runtime.rs`。
- 路径一律用 `Path` / `PathBuf`，不要写死 `/` 或 `\`。
  Windows 上 260 字符路径限制默认不触线，无需 `\\?\` 前缀。
- shell 调用要带平台分支（参考 `shell_env.rs`：Unix
  `env -0` / Windows `cmd /U /C set` + UTF-16LE 解码）。
- PR 描述里要列"在三个平台都验证过的证据"（cargo test 矩阵、
  CI runner 截图等）。如果某个平台没法在本地测，至少要列
  出来。

## 工作时容易踩的坑

- **永远不要调 `npx`。** Agent 都是 `<node> <bin>` 直接拉起
  （macOS / Windows GUI 进程看不到 PATH 是这套机制存在的
  全部理由）。
- **永远不要硬编码 Node 版本。** `ManagedNodeRuntime` 运行时
  从 `nodejs.org/dist/index.json` 发现最新 LTS。
- **Windows URL 命名**：Node 发布用 `win-x64` / `win-arm64`
  （不是 `windows-x86_64`）。`files` 项用 artifact-specific
  名：`osx-arm64-tar`、`win-x64-zip` 等。两份映射都在
  `node_runtime.rs`。
- **registry JSON 跟 Zed 共享。** 别 fork schema 或加 Zed
  ACP adapter 不认识的字段。
- **ACP 包名扁平化到 `node_modules/<pkg>`**，不是 sanitized
  名。查目录用 `package_name_from_spec`；`sanitize` 只用于
  cache-key 子目录。
- **最低 Node 版本是 `>=22.0.0`**（在 `MIN_NODE_VERSION`）。
  `SystemNodeRuntime::new` 强制检查；discover 流程也会过滤。
- **Tauri 的 `setup` 钩子是同步的。** 后台任务用
  `tauri::async_runtime::spawn`，不要用裸 `tokio::spawn`。
- **Tauri 命令返回的 future 必须是 `Send`。** ACP adapter 用
  `async_trait(?Send)` 是因为上游 `agent-client-protocol` API
  不是 `Send`；每个 session 的工作跑在专用 current-thread
  runtime 里（`std::thread::Builder` 启动）。

## 性能要求

由于支持多项目、多Agent、多会话任务同时工作，所以对性能的要求需要非常高，在实现功能时应该充分考虑对性能的影响和内存的占用。