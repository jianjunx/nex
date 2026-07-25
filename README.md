# Nex

Nex 是一个桌面端 **Agent 集成环境**：通过 [ACP（Agent Client Protocol）](https://github.com/zed-industries/agent-client-protocol) 将 Claude Code、Codex、Cursor CLI、Opencode 等 Agent 开发工具统一接入同一个工作台。功能定位类似 Zed 的 Agent 模式，界面采用苹果液态玻璃（Liquid Glass）设计语言，基于 [Tauri 2](https://tauri.app/) 构建，跨平台。

![界面布局](docs/layout.png)

## 主要功能

- **ACP Agent 集成** — 内置 Claude Code / Codex / Cursor CLI / Opencode 四种 Agent 配置；流式输出、工具调用摘要、权限请求弹窗审批（按会话排队，FIFO）。
- **多项目 × 多会话** — 左上角切换项目；每个项目可创建多个 Agent 对话标签页，多个 Agent 可同时执行任务，切换项目 / 对话不中断正在运行的任务；关闭标签页即终止对应 Agent 进程。
- **Git 集成** — 状态列表（分支、ahead/behind）、文件 diff 查看、暂存 / 取消暂存、提交、历史日志。
- **内置终端** — 多标签页 PTY 终端（xterm.js），随窗口自适应尺寸，支持创建 / 切换 / 终止。
- **文件浏览** — 项目目录树（懒展开）+ 文件预览弹窗（自动识别文本 / 二进制）。
- **外部变更自动刷新** — 文件 / Git 监听器（防抖 500ms）在外部修改后自动刷新目录树与 Git 状态。
- **会话持久化** — 项目与会话列表存入本地 SQLite，重启后可恢复（v1 暂不持久化聊天消息内容）。

## 技术栈

| 层 | 技术 |
|---|---|
| 前端 | React 19 · TypeScript · Vite 8 · Tailwind CSS 4 · Zustand 5 (+ immer) · Framer Motion · xterm.js · lucide-react |
| 后端（Rust） | Tauri 2 · tokio · agent-client-protocol 0.1 · git2 · portable-pty · rusqlite (bundled) · notify (防抖监听) · ignore |
| 存储 | SQLite（rusqlite，位于系统应用数据目录，如 Windows `%APPDATA%\com.nex.app\nex.db`） |

## 项目结构

```
src/                    前端
  features/             按功能划分：agent / files / git / layout / projects / terminal
  stores/               Zustand 状态仓库（project / conversation / agent / fs / git / terminal / ui）
  bridge/               Tauri 命令与事件的类型化封装（COMMANDS / EVENTS 常量与 Rust 一一对应）
  ui/                   液态玻璃基础组件（GlassButton / GlassModal / GlassTab …）
src-tauri/src/          Rust 后端
  acp/                  ACP 会话管理（每会话独立线程 + LocalSet，权限请求往返）
  db/ fs/ git/ terminal/  各功能模块
  watcher.rs            文件 / Git 防抖监听
  commands/             Tauri 命令层
docs/                   PRD 与界面设计（prd.md / layout.png）
```

## 快速开始

### 环境要求

- **Node.js ≥ 20.19**（Vite 8 要求 ^20.19 || ≥22.12）并启用 corepack：`corepack enable`
- **Rust 稳定版工具链**（≥ 1.77.2）
- **Tauri 2 系统依赖**：Windows 10/11 自带 WebView2；Linux / macOS 的依赖见 [Tauri 官方指南](https://tauri.app/start/prerequisites/)
- **至少一个支持 ACP 的 Agent CLI**（按需安装其一即可）：
  - Claude Code（`claude --acp`）· Codex（`codex --acp`）· Cursor CLI（`cursor --acp`）· Opencode（`opencode --acp`）

### 安装与运行

```bash
pnpm install        # 安装前端依赖
pnpm tauri dev      # 开发模式（Vite HMR + Rust 热重载）
pnpm tauri build    # 生产打包（产物在 src-tauri/target/release/bundle/）
```

仅前端：

```bash
pnpm dev            # 浏览器中调试界面（Tauri API 调用不可用）
pnpm build          # 类型检查 + 生产构建
pnpm lint           # oxlint
```

### 测试

```bash
cd src-tauri && cargo test    # Rust 集成测试（数据库 / 文件系统）
pnpm lint                     # 静态检查
```

### 使用流程

1. 左上角 **打开项目**（选择本地文件夹）；
2. 顶栏点击 **+** 新建对话，选择 Agent 后 **Create**（需要对应 CLI 已安装并在 PATH 中）；
3. 在对话区与 Agent 交互；遇到权限请求时在弹窗中选择允许 / 拒绝；
4. 右侧面板切换 **文件 / Git / 搜索**，左下角图标可展开 **终端** 区域。

## 已知限制（v1）

- 聊天消息内容不持久化（重启后恢复会话列表，对话内容为空）。
- 关闭标签页时若 Agent 正处于回合中，进程在回合结束后才被回收。
- Windows Smart App Control 可能间歇性拦截 cargo 构建脚本（os error 4551），重试即可。

## 文档

- [产品需求文档](docs/prd.md)
- [界面布局设计](docs/layout.png)
