# Nex 设计文档

**日期**: 2026-07-24  
**状态**: 已批准  
**版本**: v1 (MVP 全功能骨架)

---

## 1. 项目概述

Nex 是一个基于 Tauri 2.x 的跨平台桌面应用，作为 Agent 集成环境工具。它通过 ACP（Agent Client Protocol）协议集成多种 Agent 开发工具（Claude Code、Codex、Cursor CLI、Opencode 等），提供类似 Zed Agent 模式的体验。

### 核心功能

1. **ACP 集成**：通过官方 Rust SDK 管理多个 Agent 子进程，支持并发会话
2. **Git 集成**：基于 git2-rs 的完整 git 操作（status、diff、commit、branch）
3. **终端**：基于 portable-pty + xterm.js 的嵌入式终端
4. **文件系统**：文件树浏览 + 文件内容预览（v1 不含编辑器）
5. **多项目多会话**：切换项目/对话时 Agent 任务不中断
6. **液态玻璃 UI**：Apple Liquid Glass 设计语言，4 级分层材质系统

### 技术选型

| 层 | 技术 |
|---|---|
| 前端框架 | React + TypeScript |
| 桌面框架 | Tauri 2.x |
| 状态管理 | Zustand + immer |
| 样式 | Tailwind CSS + CSS Variables |
| 动画 | Framer Motion |
| 终端 | @xterm/xterm |
| Rust 异步运行时 | Tokio |
| ACP 协议 | agent-client-protocol (官方 SDK) |
| Git | git2-rs |
| 终端 PTY | portable-pty |
| 文件扫描 | ignore crate (ripgrep 核心) |
| 文件监听 | notify + notify-debouncer-full |
| 数据库 | SQLite (rusqlite via tauri-plugin-sql) |
| 设置存储 | tauri-plugin-store (JSON key-value) |

---

## 2. 整体架构

```
┌─────────────────────────────────────────────────────────────────┐
│                        Tauri Window                             │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │                    React Frontend                         │  │
│  │  ┌─────────┐  ┌──────────  ┌─────────┐  ┌───────────┐  │  │
│  │  │ Projects │  │  Agent   │  │  Git    │  │ Terminal  │  │  │
│  │  │ Feature  │  │ Feature  │  │ Feature │  │ Feature   │  │  │
│  │  └────┬────┘  └────┬─────┘  └────┬────┘  └─────┬─────┘  │  │
│  │       │             │             │              │         │  │
│  │  ┌────▼─────────────▼─────────────▼──────────────▼─────┐  │  │
│  │  │              Zustand Stores                         │  │  │
│  │  └────────────────────────┬────────────────────────────┘  │  │
│  │                           │ invoke / listen               │  │
│  │  ┌────────────────────────▼────────────────────────────┐  │  │
│  │  │              Bridge Layer (typed)                   │  │  │
│  │  └────────────────────────┬────────────────────────────┘  │  │
│  └───────────────────────────┼───────────────────────────────┘  │
│                              │ Tauri IPC                        │
│  ┌───────────────────────────▼───────────────────────────────┐  │
│  │                    Rust Backend                            │  │
│  │  ┌──────── ┌────── ┌────────┐ ────┐ ┌────┐ ┌───────┐  │  │
│  │  │  ACP   │ │ Git  │ │Terminal│ │ FS │ │ DB │ │ Store │  │  │
│  │  │Manager │ │(git2)│ │ (pty)  │ │    │ │(sql)│ │(json)│  │  │
│  │  └───┬────┘ └──┬───┘ └───────┘ └─┬──┘ └─┬──┘ └───┬───┘  │  │
│  │      │         │         │        │      │        │       │  │
│  │  ┌───▼─────────▼─────────▼────────▼──────▼────────▼────┐  │  │
│  │  │            Tokio Async Runtime                       │  │  │
│  │  └──────────────────────────────────────────────────────┘  │  │
│  └────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
         │ stdio JSON-RPC              │ PTY
         ▼                             ▼
   ┌───────────┐                ┌──────────────┐
   │ Agent Proc│ (claude/codex) │ System Shell │
   └───────────┘                └──────────────┘
```

### 设计原则

1. **进程生命周期独立于视图**：Agent 子进程由 Rust AcpManager 统一管理，前端切换 tab/项目只是切换 event 订阅过滤条件
2. **事件驱动推送**：Rust → React 实时数据流走 Tauri event；React → Rust 请求走 Tauri command (invoke)
3. **Feature 隔离**：每个功能模块前后端对应切片，通过 Bridge 层类型接口通信
4. **Tokio 单运行时**：所有异步 I/O 共享 Tauri 管理的 tokio runtime

---

## 3. Rust 后端模块

### 目录结构

```
src-tauri/src/
├── main.rs                 # Tauri 入口，注册 commands + plugins
├── lib.rs                  # 模块声明 + app setup hook
├── state.rs                # 全局 AppState
│
├── acp/
│   ├── mod.rs
│   ├── manager.rs          # SessionManager: 多并发 ACP Client 连接
│   ├── bridge.rs           # SDK notification/request → Tauri event
│   └── types.rs            # 前端 DTO 类型
│
├── git/
│   ├── mod.rs
│   ├── repository.rs       # git2 封装
│   ├── watcher.rs          # .git/ 目录监听 → 自动刷新
│   └── types.rs
│
├── terminal/
│   ├── mod.rs
│   ├── pty.rs              # portable-pty 管理
│   ├── session.rs          # 读写流 + 历史缓冲
│   └── types.rs
│
├── fs/
│   ├── mod.rs
│   ├── tree.rs             # ignore crate 懒加载扫描
│   ├── read.rs             # 文件读取 + 二进制检测
│   └── watcher.rs          # notify 文件变更事件
│
├── db/
│   ├── mod.rs
│   ├── schema.rs           # SQL migration
│   ├── conversations.rs    # 对话 + 消息 CRUD
│   └── projects.rs         # 项目 CRUD
│
├── store/
│   └── mod.rs              # tauri-plugin-store 封装
│
└── commands/
    ├── mod.rs
    ├── acp_cmds.rs
    ├── git_cmds.rs
    ├── terminal_cmds.rs
    ├── fs_cmds.rs
    └── project_cmds.rs
```

### ACP 模块（基于官方 SDK）

使用 `agent-client-protocol` crate 的 Client 角色，不自行实现协议解析和传输层。

```rust
pub struct SessionManager {
    sessions: HashMap<SessionId, AgentConnection>,
}

// 创建会话
pub async fn create_session(&self, agent_command: &str, cwd: PathBuf) -> Result<SessionId> {
    let agent = AcpAgent::from_str(agent_command)?;
    // SDK 自动 spawn 子进程 + stdio 传输
    // 注册 notification handler → app.emit("acp-notification", ...)
    // 注册 permission handler → app.emit("acp-permission-request", ...)
    // 调用 InitializeRequest → NewSessionRequest
    // 返回 session_id
}

// 发送 prompt
pub async fn send_prompt(&self, session_id: &SessionId, content: Vec<ContentBlock>) -> Result<()> {
    // connection.send_request(PromptRequest::new(session_id, content))
}

// 响应权限请求
pub async fn respond_permission(&self, request_id: &str, outcome: PermissionOutcome) -> Result<()> {
    // responder.respond(...)
}
```

### Git 模块

- `git2-rs` 封装：status, diff, log, stage, unstage, commit, branch_list, checkout
- `notify` 监听 `.git/` 目录 → debounce 300ms → emit `git-status-changed`

### Terminal 模块

- `portable-pty` 创建跨平台 PTY
- PTY stdout → tokio read task → emit `terminal-output` event
- 前端 xterm.js 输入 → invoke `terminal_write` → PTY stdin
- 支持 resize、多实例、kill

### FS 模块

- `ignore` crate (WalkBuilder) 做懒加载文件树扫描，自动尊重 .gitignore
- `read_tree(path, depth=1)` 返回一层子节点
- `expand_dir(path)` 展开指定目录
- `read_file(path)` 返回文本内容或二进制元信息（content_inspector 检测）
- `notify` + debouncer 监听文件变更 → emit `fs-changed`

---

## 4. 前端架构

### 目录结构

```
src/
├── main.tsx
├── App.tsx                     # 根布局
├── bridge/
│   ├── tauri.ts                # invoke/listen 类型安全封装
│   ├── events.ts               # event 名称常量 + payload 类型
│   └── commands.ts             # command 名称 + 参数/返回类型
│
├── stores/
│   ├── project.store.ts
│   ├── conversation.store.ts
│   ├── agent.store.ts
│   ├── git.store.ts
│   ├── terminal.store.ts
│   ├── fs.store.ts
│   └── ui.store.ts
│
├── features/
│   ├── layout/                 # TopBar, MainArea, SidePanel, IconBar
│   ├── projects/               # 项目切换器
│   ├── agent/                  # 对话区 + 消息流 + 输入框 + 权限弹窗
│   ├── git/                    # git 面板
│   ├── terminal/               # xterm.js 封装
│   ├── files/                  # 文件树 + 文件预览弹窗
│   └── settings/               # 设置页
│
├── ui/                         # 液态玻璃组件库
│   ├── tokens/                 # 材质 CSS variables + TS 常量
│   ├── Glass.tsx
│   ├── GlassButton.tsx
│   ├── GlassInput.tsx
│   ├── GlassPanel.tsx
│   ├── GlassModal.tsx
│   ├── GlassTab.tsx
│   ├── GlassScrollbar.tsx
│   └── animations.ts           # framer-motion 预设
│
└── styles/
    ├── globals.css
    └── vibrancy.css
```

### 状态管理原则

1. **Rust 是 source of truth**：写操作通过 invoke 到 Rust，Rust 通过 event 推送新状态
2. **乐观更新仅限 UI 状态**：面板展开/折叠等纯 UI 操作直接修改前端 store
3. **消息流 append-only**：Agent 消息通过 event 逐条 append，使用 immer 保证不可变

### 关键技术库

| 需求 | 库 |
|---|---|
| 状态管理 | zustand + immer middleware |
| 动画 | framer-motion |
| 终端 | @xterm/xterm + @xterm/addon-fit |
| Markdown | react-markdown + rehype-highlight |
| 虚拟列表 | @tanstack/react-virtual |
| 图标 | lucide-react |

---

## 5. 液态玻璃设计系统

### 材质层级

| 层级 | Token | blur | 背景透明度 | 边框 | 用途 |
|---|---|---|---|---|---|
| L0 · Base | `--glass-base` | 40px | `rgba(255,255,255,0.03)` | 无 | 窗口底色 |
| L1 · Elevated | `--glass-elevated` | 24px | `rgba(255,255,255,0.06)` | `1px solid rgba(255,255,255,0.08)` | 侧面板 |
| L2 · Interactive | `--glass-interactive` | 16px | `rgba(255,255,255,0.10)` | `1px solid rgba(255,255,255,0.12)` | 对话气泡、输入框 |
| L3 · Overlay | `--glass-overlay` | 12px | `rgba(255,255,255,0.15)` | `1px solid rgba(255,255,255,0.18)` | 弹窗、下拉 |

暗色模式默认。亮色模式透明度反转为 `rgba(0,0,0,0.0x)` 系列。

### 高光与折射

- 顶部高光线：`linear-gradient(180deg, rgba(255,255,255,0.12) 0%, transparent 40%)`
- 动态折射光斑：跟随鼠标的 `radial-gradient` 微光效果

### macOS Vibrancy 集成

- macOS：Tauri `set_vibrancy(UnderWindowBackground)` 做 L0 底层，CSS 层叠加 L1-L3
- Windows/Linux：fallback 到纯 CSS `backdrop-filter: blur()` 实现

### 色彩系统

```css
:root {
  --text-primary: rgba(255, 255, 255, 0.92);
  --text-secondary: rgba(255, 255, 255, 0.60);
  --text-tertiary: rgba(255, 255, 255, 0.38);
  --accent: #7C8AFF;
  --accent-hover: #9BA6FF;
  --accent-glow: rgba(124, 138, 255, 0.20);
  --success: #34D399;
  --warning: #FBBF24;
  --error: #F87171;
  --radius-sm: 8px;
  --radius-md: 12px;
  --radius-lg: 16px;
  --radius-xl: 24px;
}
```

### 动画原则

- Spring 物理：stiffness 300, damping 30
- 布局动画：framer-motion `layout` + `layoutId`
- 进入/退出：opacity + translateY 8px，150ms
- 克制：每个动画服务于空间关系或状态反馈

---

## 6. 数据模型与持久化

### SQLite Schema

```sql
CREATE TABLE projects (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    path        TEXT NOT NULL UNIQUE,
    created_at  INTEGER NOT NULL,
    last_opened INTEGER NOT NULL
);

CREATE TABLE conversations (
    id          TEXT PRIMARY KEY,
    project_id  TEXT NOT NULL REFERENCES projects(id),
    title       TEXT NOT NULL DEFAULT 'New Chat',
    agent_type  TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'idle',
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
);

CREATE TABLE messages (
    id              TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id),
    role            TEXT NOT NULL,
    content         TEXT NOT NULL,
    tool_summary    TEXT,
    timestamp       INTEGER NOT NULL,
    sequence        INTEGER NOT NULL
);

CREATE INDEX idx_conv_project ON conversations(project_id);
CREATE INDEX idx_conv_updated ON conversations(updated_at DESC);
CREATE INDEX idx_msg_conv_seq ON messages(conversation_id, sequence);
```

### 存储策略

- **本地存全量展示内容**（跟随 Zed 策略），不存原始协议 payload
- Agent 自身的历史归 Agent 管（上下文续接），Nex 的历史归 Nex 管（UI 展示和浏览）
- messages 表存渲染用 markdown + tool 调用摘要，不存 thinking/reasoning 原文

### Tauri Store (settings.json)

```jsonc
{
  "theme": "dark",
  "accentColor": "#7C8AFF",
  "defaultAgent": "claude-code",
  "agents": {
    "claude-code": { "command": "claude", "args": ["--acp"] },
    "codex": { "command": "codex", "args": ["--acp"] },
    "cursor-cli": { "command": "cursor", "args": ["--acp"] },
    "opencode": { "command": "opencode", "args": ["--acp"] }
  },
  "terminal": { "shell": null, "fontSize": 13, "fontFamily": "JetBrains Mono" },
  "layout": { "sidePanelWidth": 320, "terminalHeight": 200, "sidePanelVisible": true, "terminalVisible": false }
}
```

### 存储位置

- macOS: `~/Library/Application Support/com.nex.app/`
- Linux: `~/.config/com.nex.app/`
- Windows: `%APPDATA%/com.nex.app/`

---

## 7. 多项目 & 多会话管理

### 切换行为

| 用户操作 | UI 变化 | Agent 进程 | Event 订阅 |
|---|---|---|---|
| 切换对话 tab | 渲染新对话 | 不变 | 切换 sessionId 过滤 |
| 切换项目 | 列表刷新 | 不变 | 切换 projectId 过滤 |
| 关闭对话 tab | tab 消失 | cancel + kill | 移除 |
| 关闭项目 | 项目移除 | 所有 session kill | 移除 |

### Tab 活动指示器

- `●` 脉冲动画：Agent 正在执行
- `○` 静态：空闲
- `⚠` 黄色：等待权限审批

切换项目/对话时指示器持续更新，用户可见后台任务状态。

### 新建对话流程

1. 用户点击 [+]
2. 弹出 Agent 选择器 (GlassModal)
3. 选择 Agent 类型
4. invoke `acp_create_session` → Rust 启动进程 + 初始化
5. 前端创建 conversation 记录 + 打开新 tab

---

## 8. 错误处理

### 统一错误类型

```rust
#[derive(Debug, thiserror::Error, serde::Serialize)]
#[serde(tag = "type", content = "message")]
pub enum NexError {
    Agent(String),
    Git(String),
    Terminal(String),
    FileSystem(String),
    Database(String),
    Internal(String),
}
```

### 前端错误展示

| 错误类型 | 展示方式 |
|---|---|
| Agent 崩溃 | 对话区 inline 错误卡片 + tab 变红 |
| 权限超时 | 对话区 warning 提示 |
| Git 失败 | 面板 inline 错误 + toast |
| Shell 不存在 | 终端 inline 提示 + fallback /bin/sh |
| 文件读取失败 | 预览弹窗内提示 |
| DB 错误 | 全局 toast |

### 进程健壮性

- 子进程意外退出 → emit `acp-session-terminated` → 前端标记「已结束」
- 不自动重启，用户手动「重连」
- App 退出时 SIGTERM → 3s → SIGKILL

---

## 9. 测试策略

| 层级 | 工具 | 覆盖 |
|---|---|---|
| Rust 单元测试 | cargo test | ACP 解析、git 逻辑、FS 过滤、DB CRUD |
| Rust 集成测试 | cargo test + mock agent | AcpManager 全流程 |
| 前端单元测试 | vitest + @testing-library/react | Store 逻辑、组件渲染 |
| 组件快照 | vitest + storybook (可选) | 液态玻璃视觉回归 |
| E2E | tauri-driver (v2) | 完整流程 |

### v1 优先级

1. **必须**：Rust acp/ + db/ 单元测试
2. **应该**：Rust git/ + fs/ 单元测试 (tempdir)
3. **应该**：前端 store 逻辑测试
4. **可选**：组件快照
5. **v2**：E2E

---

## 10. 开发工具链

| 层 | 工具 |
|---|---|
| Rust | cargo + tokio + serde + thiserror + git2 + portable-pty + notify + ignore + rusqlite + agent-client-protocol |
| 前端 | vite + react + typescript + tailwindcss + zustand + framer-motion + @xterm/xterm + vitest |
| 桌面 | tauri 2.x + tauri-plugin-sql + tauri-plugin-store + tauri-plugin-dialog |
| 构建 | pnpm + cargo tauri dev / build |
| Lint | clippy + eslint + prettier |

---

## 11. UI 布局参考

基于 `docs/layout.png`：

```
┌─────────────────────────────────────────────────────────────┐
│ [Projects ▾] [+] [对话Tab1] [对话Tab2]              [□]    │ ← TopBar
├──────────────────────────────────────┬──────────────────────┤
│                                      │  ┌──────────────┐    │
│                                      │  │  文件树/git/  │    │
│         Agent 对话区                  │  │  搜索面板     │    │
│                                      │  │              │    │
│                                      │  └──────────────┘    │
│                                      │  ┌──────────────┐    │
│                                      │  │  终端        │    │
│                                      │  │ (默认折叠)   │    │
│  ┌────────────────────────────────┐  │  └──────────────┘    │
│  │         对话输入框              │  │                      │
│  └────────────────────────────────┘  │              [文件]  │
│                                      │              [git]   │
│                                      │              [搜索]  │
│                                      │              [设置]  │
└──────────────────────────────────────┴──────────────────────┘
```

---

## 附录：关键依赖版本参考

| Crate / Package | 版本要求 |
|---|---|
| tauri | ^2.x |
| agent-client-protocol | latest (crates.io) |
| tokio | ^1 (full features) |
| git2 | ^0.19 |
| portable-pty | ^0.8 |
| notify | ^7 |
| ignore | ^0.4 |
| rusqlite | ^0.32 |
| react | ^18 or ^19 |
| zustand | ^5 |
| framer-motion | ^11 |
| @xterm/xterm | ^5 |
| tailwindcss | ^4 |
| vite | ^6 |
