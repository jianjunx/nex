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

### 前端界面风格（Apple / macOS Pro，后续默认按此实现）

Nex 的界面标准是 **macOS Pro 风格的深色材质工作台**，不是 VS Code
式纯平工具壳，也不是 iOS / iPadOS 式夸张液态玻璃。目标是：
**高信息密度 + 清晰层级 + 即时反馈 + 克制动效**。

#### 1. 先用共享 seam，不要散落写样式

- **优先复用 `src/styles/globals.css` 里的语义 token / recipe class**，不要
  在业务组件里重复发明一套新的玻璃、阴影、边框、hover 规则。
- 优先用这些共享层：
  - `--material-toolbar` / `--material-sidebar` / `--material-panel` /
    `--material-floating` / `--material-elevated`
  - `--hairline-soft` / `--hairline-strong`
  - `--edge-highlight-soft` / `--edge-highlight-bright`
  - `nex-material-toolbar` / `nex-material-sidebar` /
    `nex-material-panel` / `nex-material-floating`
  - `nex-interactive-chrome` / `nex-pressable`
- **新 UI 先想 seam 再想 caller**：共享原语（dialog / dropdown / context menu /
  shell recipe）能改的，就不要只在单个 feature 上打补丁。

#### 2. 材质层级

- **Toolbar / 顶部 chrome** 用 `nex-material-toolbar`。
- **Sidebar / 辅助工作区** 用 `nex-material-sidebar`。
- **普通面板 / 嵌入工作面** 用 `nex-material-panel`。
- **菜单 / popover / toast / modal / 悬浮说明层** 用
  `nex-material-floating` 或 `--material-elevated`。
- 层级主要靠：
  - 半透明材质
  - hairline 边界
  - 顶部内高光
  - 柔和阴影
  不要靠粗边框或大块纯色对比。
- **不要把轻玻璃叠在轻玻璃上**。若某层已经是浮层，下层应更稳、更重，
  否则可读性会塌。

#### 3. 交互反馈

- **反馈从 pointer-down 开始**。按钮、tab、chip、icon control 的按下态必须
  立即出现，不要等 click 结束。
- 用 `nex-interactive-chrome` 统一 hover / focus / active 的节奏；
  用 `nex-pressable` 提供按下缩放。
- **不要再写到处都是各自不同的 `transition-colors duration-150`。**
  统一交给共享 chrome 语法，除非确实有独特需求。
- hover 的目标是**更像系统 chrome 被点亮**，不是网页卡片“漂起来”。
  少用明显 `translateY`，优先用 tint / border / inner highlight。

#### 4. 动效

- 默认动效应该 **短、稳、可打断、低存在感**。
- 对话框、菜单、popover 这类浮层：
  - 以 opacity + scale 为主；
  - 从来源方向 / 来源关系上保持空间一致；
  - 不做花哨弹跳。
- 手势驱动或会被持续抓取的交互，优先遵守 Apple 的 fluid 规则：
  从当前呈现值出发、不中断输入、保留速度连续性。
- **`prefers-reduced-motion` / `prefers-reduced-transparency` /
  `prefers-contrast` 必须继续有效。** 新样式不要绕过这些媒体查询。

#### 5. 文本与层次

- 默认继续使用系统字体栈。
- 标题、工具栏标签、分组标签的层次，优先靠：
  - 字重
  - tracking
  - 对比度
  - 间距
  不要只靠加大字号。
- 小标签 / 分组标题倾向更紧凑、更高对比，但不要做成刺眼的全亮文本。
- 高密度工作面板里，正文可读性优先于“玻璃感”。

#### 6. 组件级设计规则

- **项目选择器 / 下拉 / 右键菜单 / popover / 对话框** 都属于同一浮层家族；
  新增一个，就按同一 material 语法写。
- **会话线程卡片 / tool cards / pending bars / plan bars** 属于嵌入式工作面：
  应该像工作台上的轻浮层，而不是纯平 `div` 或重型卡片。
- **设置页、文件树、Git、搜索、终端** 这类高密度工作面板必须克制；
  优先清晰、可扫读，不要为了 Apple 风格把它们做成过亮、过糊、过厚重。

#### 7. 禁止项

- 不要引入新的“第二套”命名（例如再造一组 `frost-*` / `liquid-*` token）
  与当前 material 体系并存。
- 不要回到旧的 `glass-* + border-subtle + hover:bg-[var(--overlay-hover)]`
  杂糅写法作为默认新标准；若旧代码尚未迁移，可保留，但**新代码按现在的
  material 体系写**。
- 不要把 Apple 风格理解成：更亮、更多 blur、更多阴影。标准是
  **层次清楚、反馈直接、视觉克制**。

#### 8. 做新界面时的默认顺序

1. 先判断它属于 toolbar / sidebar / panel / floating 哪个层级。
2. 先选共享 recipe，再补局部 class。
3. 先保证 pointer-down / hover / focus 的一致反馈。
4. 再补充细节（标签、状态徽标、分隔线、空态、错误态）。
5. 最后检查 reduced-motion / reduced-transparency / contrast 是否仍成立。


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