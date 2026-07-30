# 勘察实录 — VSCode UX 对齐 Plan 3-6（2026-07-31）

两次只读勘察的结论汇总，供 Plan 3（Git）/ Plan 4（diff 编辑器）/ Plan 5（搜索替换）/ Plan 6（页签+新建会话）撰写时引用。路径相对仓库根。

---

## Part 1：Rust Git 后端现状（Plan 3 依据）

### 1.1 模块 `src-tauri/src/git/`

`git/mod.rs` 仅 `pub mod repository; pub mod types;`。

**`git/repository.rs`** — 6 个函数，**全部同步**，统一 `Result<_, NexError>`，每次调用 `Repository::open` 重开仓库（无缓存）：

| 行 | 签名 |
|---|---|
| 6 | `get_status(repo_path: &Path) -> Result<GitStatus, NexError>` — branch(L9-11) + best-effort ahead/behind via `graph_ahead_behind`(L14-31) + statuses |
| 55 | `get_diff(repo_path, file: &str, staged: bool) -> Result<String, NexError>` — staged 走 `diff_tree_to_index`(L63)，unstaged 走 `diff_index_to_workdir` + `include_untracked`(L66-67)；手动补回 `+/-/空格` origin 前缀(L74-78) |
| 85 | `get_log(repo_path, limit: usize) -> Result<Vec<CommitInfo>, NexError>` — revwalk + `Sort::TIME`，hash 截前 7 位(L96) |
| 106 | `stage_files(repo_path, files: &[String])` — bare repo 显式报错(L108-109)；文件不存在则 `remove_path` 记删除(L113-118) |
| 124 | `unstage_files(repo_path, files: &[String])` — `reset_default` 回 HEAD；unborn HEAD 走 index.remove_path(L132-139) |
| 144 | `commit(repo_path, message: &str) -> Result<String, NexError>` — `repo.signature()`(L149)；unborn HEAD parents 空(L151-154)；返回 oid 全串 |

**零 remote 基础**：`src-tauri/src` 内 `RemoteCallbacks|credentials|Cred|fetch(|push(|clone(` 零命中。credentials 回调、fetch/push/pull/clone 全从零建。

**git2**：`src-tauri/Cargo.toml:34` `git2 = "0.19"`（默认 features，含 https/ssh）。

**`git/types.rs`**（25 行，均 `#[derive(Debug, Clone, Serialize)]`）：
- L3-9 `GitStatus { branch: String, ahead: u32, behind: u32, files: Vec<GitFileChange> }`
- L11-16 `GitFileChange { path: String, status: String /* "modified","added","deleted","untracked" */, staged: bool }`
- L18-24 `CommitInfo { hash: String, message: String, author: String, time: i64 }`

### 1.2 Tauri commands `commands/git_cmds.rs`（35 行）

6 个 command **全部同步**（非 async、无 spawn_blocking），薄封装透传：`git_status / git_diff / git_log / git_stage / git_unstage / git_commit`（L6-34），签名均 `(project_path: String, ...)`。

async 先例仅 agent_cmds（`agent_cmds.rs:19,24,35,44,53,62`，`pub async fn ... State<'_, AppState>`）；`spawn_blocking` 全仓仅 `agent/acp_adapter.rs:191` 一处。**git 调用的 async + spawn_blocking 包装在本仓无先例**——计划需选定模式。

### 1.3 `lib.rs`

- invoke_handler git 六连在 **L45-50**。
- 插件：L23 sql、L24 store、**L25 `tauri_plugin_dialog::init()`**、L26 liquid-glass。
- State（L105-110）：`AppState { db, terminal_manager, agent_manager, watcher_manager }`（定义 `state.rs:7-12`）。**git 模块不挂任何 State**——凭据握手要新增 State（`PendingGitCredentials`）。
- `git-status-changed` **不由 git command 发出**，由 `watcher.rs` debounce 文件监听发：常量 L28，payload `GitStatusChangedPayload { project_path }`(L41-45, camelCase)，emit L87-90，与 `fs-changed` 同批（500ms debounce）。注释 L22-27 强调事件名必须与 `src/bridge/events.ts` 对齐。

### 1.4 前端桥接

**`src/bridge/commands.ts`**：git 段 L27-33（`GIT_STATUS/DIFF/LOG/STAGE/UNSTAGE/COMMIT: "git_*"`）。⚠️ `GIT_LOG`(L30) 已声明**从未消费**——`tauri.ts` 无 `gitLog` 封装，前端零调用。

**`src/bridge/tauri.ts`** git 段 L205-237（camelCase 参数、`gitXxx` 命名）：
- L219 `gitStatus(projectPath): Promise<GitStatus>`
- L223 `gitDiff(projectPath, file, staged): Promise<string>`（**原始 unified-diff 字符串**）
- L227/231 `gitStage/gitUnstage(projectPath, files: string[])`
- L235 `gitCommit(projectPath, message): Promise<string>`
- 接口 L206-217：TS 侧 `GitFileChange.status` 是字面量联合（比 Rust string 严）。
- L307-334 事件封装；L332-334 `onGitStatusChanged(cb): Promise<UnlistenFn>`。

**`src/bridge/events.ts`**：L6 `GIT_STATUS_CHANGED: "git-status-changed"`；L24-26 payload `{ projectPath }`。

### 1.5 `src/stores/git.store.ts`（93 行）

- State L5-10：`status | diff: string|null | diffFile | loading | error`。**单全局槽**，无 per-project、**无 log/commits 字段**。
- Actions L12-16：`refresh / viewDiff / stage / unstage / commit`。全部 try/catch + **共享 `loading` 布尔**（任一操作禁用全部按钮）。
- 错误解包 L19-25 `errorMessage(err)` 读 `{ type, message }`（NexError serde tag），否则 `String(err)`。
- **store 内无事件监听**：`git-status-changed` 监听在 `App.tsx:70-73`——payload.projectPath 与活动项目比对后 `refresh`（注释 L61-64：只渲染活动项目）。

### 1.6 `src/features/git/GitPanel.tsx`（128 行）

- L43-50 Header：`GitBranch` 图标 + `status?.branch` + `↑{ahead} ↓{behind}` 徽章——**分支显示已有**。
- **无刷新按钮**；刷新仅靠 L15-17 useEffect（项目切换）+ 各 handler 后手动 refresh(L21-36)。
- L52-87 文件列表：unstaged("Changes", L54-69) / staged(L70-85) 两段，行点击 → `viewDiff`(L63/79)；每段整段 stage/unstage 的 Plus/Minus ghost 按钮；**无单文件 hover 按钮、无 checkbox**。
- L89-106 Commit 区：Input + Commit 按钮，Enter 提交(L96)。
- L108-124 **内联 diff 窗格**（底部，`max-h-[200px]`，`+`/`-` 染色 L117，二进制特判 L112-113 中文提示）。无关闭按钮。
- **无 History/Log、无分支切换、无远端 UI**。

### 1.7 NexError（`error.rs` L4-19）

`#[serde(tag = "type", content = "message")]` 枚举：`Agent / Git / Terminal / FileSystem / Database / Internal`（均包 String）。From：`git2::Error → Git`(L27-31)、`io → Internal` 等。

消息约定**中英混用**：技术错误英文小写（`repository.rs:109 "cannot stage files in a bare repository"`）；**用户可见校验类中文**（`fs/create.rs:7 "文件已存在: {name}"`）。前端统一经 `errorMessage()` 解包，新变体无需改前端。

### 1.8 dialog 插件 — 全链路就绪

Cargo `Cargo.toml:25` `tauri-plugin-dialog = "2"`；`lib.rs:25` 注册；capabilities `default.json:20` `"dialog:default"`；package.json L49 `@tauri-apps/plugin-dialog ^2.7.2`。现成用例：`ProjectSelector.tsx:2,85` `await open({ directory: true, multiple: false, title: "Open Folder" })`——clone 选目录直接复制。

### 1.9 后端测试约定

集成测试在 **`src-tauri/tests/`**：`db_test.rs`、`fs_test.rs`（**无 git 测试**）。风格：`use nex_lib::fs::...` + `tempfile::tempdir()`（`Cargo.toml:51-52` dev-deps 已有），直调 lib 公开函数（模块均 `pub`）。内联 `mod tests` 仅 2 处（agent/*）。主流约定＝tests/ 目录集成测试。

### 1.10 Plan 3 关键约束

1. **可复用**：`get_log` 后端已完成且已注册——History 只需补前端半条链（tauri.ts `gitLog` + store commits 字段/action + UI）；`COMMANDS.GIT_LOG` 常量已存在。
2. **命名契约四处同步**：新 command 必改 ① `git_cmds.rs` ② `lib.rs` handler ③ `commands.ts` 常量 ④ `tauri.ts` 封装；新事件再同步 `events.ts`。参数一律 camelCase（Tauri 自动转换）。
3. **remote 纯新增**：git2 0.19 已带 https+ssh；credentials/RemoteCallbacks 从零写。阻塞网络调用放同步 command 会占 Tauri 同步线程池——async 模式需计划选定（本仓 async command 先例靠 manager 内部 runtime，无 spawn_blocking 包 git 的先例）。
4. **事件模型**：command 执行后目前**不 emit**（前端手动 refresh 补偿）。push/pull 后要么延续手动 refresh，要么 command 注入 `AppHandle` emit（＝签名破坏性变更，git_cmds 现无 AppHandle/State 参数）。
5. **store 单槽 + 单 loading**：丰富化前宜拆 loading 粒度（`statusLoading / branchesLoading / historyLoading / opRunning` 等）或接受现状。
6. **错误文案**：技术英文、用户校验中文；NexError::Git 变体已够，新消息走既有映射。
7. **测试**：新建 `src-tauri/tests/git_test.rs`，`tempdir()` + `Repository::init`，调 `nex_lib::git::repository::*`（函数均以 `&Path` 起手，天然可测）。
8. **clone 选目录**：零基建，复制 `ProjectSelector.tsx:85`。

---

## Part 2：搜索 / 编辑器页签 / TopBar 现状（Plan 4/5/6 依据）

### 2.1 搜索（Plan 5）

**后端 `src-tauri/src/fs/search.rs`（82 行）**：
- L29 `search(project_path: &Path, query: &str) -> Result<Vec<SearchMatch>, NexError>`——**无 SearchOptions**，纯小写子串（L30/56/70）。
- `SearchMatch`(L9-16, camelCase)：`{ path, name, line: Option<u32>, text }`；`line=None`＝文件名命中，`Some(n)`＝内容命中（1-based）；**无列号/偏移**。
- 常量：`MAX_RESULTS: usize = 200`(L19，名称+内容**合计**)、`MAX_CONTENT_FILE_SIZE: u64 = 1MB`(L21，超限只匹配文件名)、`MAX_LINE_LEN = 200` 字符截断(L23,75)。
- 过滤(L35-39)：`ignore::WalkBuilder` + hidden + git_ignore + git_exclude；仅文件(L50)；非 UTF-8 靠 `read_to_string` 失败跳过(L65)。
- **无测试**（文件内无 `#[cfg(test)]`）。

**`commands/fs_cmds.rs`**：L41-44 `fs_search(project_path, query) -> Result<Vec<SearchMatch>>` 同步；写盘可复用 L26-29 `fs_write_file(file_path, content)` → 底层 `fs/write.rs:10-27` **原子写**（同目录 `.{name}.nex-tmp` + rename，失败清理；仅 UTF-8）。

**前端 `src/features/search/SearchPanel.tsx`（89 行，唯一文件）**：单 Input(L37-47，Enter 即搜) + 扁平结果列表；300ms 防抖 live-search(L7,24-32)，清空 `clearSearch()`。**无分组、无统计条、无高亮**。结果 `<button>`(L65-83)：文件名+`:line` 徽标、路径行、`font-mono truncate` 匹配行。跳转 `onClick={() => void openFile(m.path)}`(L68)——**丢弃 m.line，不定位行**。store 耦合 L18：`searchResults/searching/search/openFile`。

**fs.store 搜索段**：`searchResults/searching`(L56-57)、`search(projectPath, query)`(L425-439，内部 trim，错误写共享 error 槽)、`clearSearch()`(L441-443)。

**桥接**：`tauri.ts` L284-289 `SearchMatch` TS 接口；L291-293 `fsSearch(projectPath, query)`；L276-278 `fsWriteFile(filePath, content)`；`commands.ts:45` `FS_SEARCH: "fs_search"`。

**`fs-changed` 链路**：`watcher.rs` notify-debouncer 500ms(L72-73) 每批 emit `fs-changed` + `git-status-changed`(L83-90)，payload `{projectPath, paths}`(L32-37)；`App.tsx:65-69` onFsChanged → 过滤非活跃项目 → `loadRoot` + `syncExternalChange(paths)`；`syncExternalChange`(fs.store L367-393)：命中的已打开文件 **dirty → `stale=true`（黄条）**，clean → 静默重读。

### 2.2 编辑器页签（Plan 4）

**`fs.store.ts` 页签模型**：
- `EditorFile`(L33-42)：`{ path, content(磁盘快照), isText, size, draft, dirty, stale, pinned }`；`pinned=false`＝预览页签。**无 kind 概念**。
- 状态：`openFiles: EditorFile[]`、`activePath`(L53-54)；按项目 `editorLayoutByProject`（持久化，仅 paths+activePath，L44-45/60-63/530-537，key `"nex-fs"`）+ `editorCacheByProject`（内存）。
- Actions：`openFile(filePath, pin=false)`(L162)、`switchFile`(L227)、`closeFile`(L236，dirty 自动存、失败保留页签；后继选右邻否则左邻 L256-259)、`closeEditor`(L267)、`setDraft`(L286，**首次 dirty 自动 pin** L296-297 + 挂自动保存)、`saveFile`(L340)、`reloadEditor`(L395)、`dismissStale`(L418)。
- 预览机制：未 pin 打开替换第一个 `!pinned` 页签(L184-204)；`openFile` 总是 `setEditorVisible(true)`(L178/201/219)。

**`EditorPanel.tsx`**：
- 标签条**手写 div，未用 ui/Tabs**(L79-121)：active `bg-[var(--glass-2-surface)]`(L85-89)、预览斜体(L93)、dirty `●`(L94)、× 为 `span[role=button]` + mousedown preventDefault/stopPropagation(L95-108)；尾部 flex-1 + 收起按钮(L112-120)。**无双击固定、无中键关闭**。
- 耦合点：selector L45-54；`editorFile = openFiles.find(f => f.path === activePath)`(L47)。
- 条幅先例：error 红条(L122-127)、stale 黄条「重新加载/保留」(L128-134)——diff 操作条样式模板。
- **本组件无内联 diff**；全应用唯一 diff 渲染在 `GitPanel.tsx:108-124`。

**CodeMirror**：扩展组装 L60-63 `[...languageExtensionsForPath(path), ...editorSearchExtensions()]` 按 path memo；`language.ts:16-56` 按扩展名 switch；`editorSearch.tsx:22-35` search({top,createPanel}) + React FindBar + `SEARCH_SYNC_EVENT`；主题全走 CSS 变量(L17-42，含 `.cm-searchMatch`)。
- **先例缺口**：全 src `readOnly|Decoration` 零命中；无 `@codemirror/merge`（仅 lang-*、search 6.7.1、state 6.7.1、view 6.43.6、@uiw/react-codemirror 4.25.11）。只读 diff + 装饰＝绿地（只读可走 `EditorState.readOnly.of(true)` 或 @uiw `editable` prop；必须绕开 `setDraft→dirty→autosave` 链）。
- `key={editorFile.path}` 一文件一 EditorView(L138-140)；`viewRef` + `registerFindBarAccessor`(L58,66-73) 是外部拿 EditorView 的既有通道。

### 2.3 TopBar / 新建会话（Plan 6）

**`src/features/layout/TopBar.tsx`（全应用唯一）**：
- 会话页签 `Tabs/TabsList/TabsTrigger`(L120-165)，`TabsList variant="line"`(L121)。
- TabsTrigger className(L128)：`... data-[state=active]:bg-[var(--glass-2-surface)] data-[state=active]:shadow-[inset_0_-2px_0_0_var(--accent)]`，并**显式关掉** line 变体下划线 `group-data-[variant=line]/tabs-list:data-[state=active]:after:opacity-0`——当前激活指示＝inset box-shadow 而非 after 条。
- 状态点(L130-135，running 脉冲 accent / 否则 warning)、标题 `max-w-[120px] truncate`(L136-138)、× 走 `pendingCloseId` → `CloseTabConfirmDialog`(L147-160,183-202) → `removeSession + closeTab`。
- `+` 按钮(L110-113)：ghost Button 包 `<Plus size={14}>`，`onClick={() => setShowNewConversation(true)}`——**直开模态框**。`NewConversationModal` 挂载 L182。
- `handleCreate`(NewConversationModal.tsx:50-74)：`createConversation(project.id, selected.id)`(conversation.store L167-193：conversationCreate → unshift 会话 → push tab → 立即激活) → **先 `onClose()` 让页签即刻可见** → fire-and-forget `createSession(conv.id, target, project.path)`(agent.store L159-193)；`target` 由 `selected.kind` 映射 `{type:"custom"|"registry", id}`(L60-63)；createConversation 抛错 → `closeTab(conv.id)` 回滚(L70)；createSession 失败写 `agent.store.error`(L66-68)。
- 模态框打开即 `loadServers()`(L39-45)；列表项 name + `v{version}` + description(L112-118)。

**UI 组件件**：
- `ui/tabs.tsx`：`TabsList` cva 变体 `default(bg-muted)` / `line(gap-1 bg-transparent rounded-none)`(L28-41)；`TabsTrigger` 内置 line after 下划线 `bg-[var(--accent)] bottom-[-5px] h-0.5`、激活 `after:opacity-100`(L70)——目前被 TopBar 覆盖。**TabsTrigger 无 variant/size prop，只能 className 覆盖**。
- `ui/dropdown-menu.tsx`：shadcn 全套（Root/Trigger/Content/Group/Label/Item(inset?, variant)/CheckboxItem/Radio*/Separator/Shortcut/Sub*）；Content 已玻璃化 `bg-[var(--glass-3-surface)] backdrop-blur-xl border-[var(--glass-border)]`(L43)——新建会话下拉可直接用。

**`agent.store.ts`**：`servers: ServerDescriptor[]`(L47) + `serversLoading`(L49) + `serversLoadedAt`(L51)。`ServerDescriptor`(tauri.ts L98-105)：`{ id, name, version, description, icon: string|null, kind: "registry"|"custom" }`。加载器 `loadServers()`(L379-398 白名单) / `loadAllServers()`(L400-419) / `refreshRegistry()`(L421-443，刷后回白名单)。错误：**单一共享 `error: string|null`**(L52)，**唯一渲染点 `AgentComposer.tsx:269-278`**——TopBar/模态框无专用错误条（模态框用本地 error state）。`sessions: Record<conversationId, {sessionId, conversationId, status}>`，status ∈ `"starting"|"idle"|"running"|"waiting"`(L33-40)。

**`workbench.newConversation` 命令已注册**（registry.ts:85-95）：标题「新建会话」、类别「会话」、`defaultKey` Cmd/Ctrl+Shift+N（`k("keyn",{primary:true,shift:true})`）、`run` 空函数，注释明示 `Opens the new-conversation dropdown in Plan 6; for now it is a no-op placeholder`——快捷键已预留占用。

### 2.4 三个计划的关键约束

**Plan 5（搜索替换）**：
- `search()` 硬编码子串、仅 `(project_path, query)`——加选项须引入 SearchOptions（Rust struct + 命令参数 + 桥接三端同步）。
- `MAX_RESULTS=200` 是全局合计上限，替换预览计数会被截断——替换场景需另设上限或分文件聚合。
- SearchPanel 纯扁平：分组 + 统计条 + 高亮全新增；点击跳转丢弃 `m.line`——行定位需新增「打开并跳到行」通道（可经 `viewRef`/accessor 同款模式）。
- 替换复用 `fs_write_file`（原子 rename）后 500ms watcher 必回火 `fs-changed` → `syncExternalChange`：干净页签静默刷新、dirty 页签集体弹 stale 黄条。计划必须决定：顺势利用（自动刷新）还是批量替换期间按项目临时抑制。

**Plan 4（diff 编辑器）**：
- `EditorFile` 以 path 为身份、无 kind；持久化 `editorLayoutByProject` 只存 path 数组——diff 页签要么平行存放于 store（推荐：`diffTabs` + `activeDiffId` 与 openFiles 并列，不进持久化），要么扩 EditorFile（须处理 persist 序列化与冷恢复语义）。
- EditorPanel 标签条是手写 div 循环——diff 页签要在同一循环分支渲染。
- CodeMirror 无 Decoration/readOnly 先例、无 merge 依赖——绿地；只读须绕开 `setDraft→dirty→autosave`（onChange 直连 store）。
- 数据源现成：`git.store.viewDiff` 已产原始 unified-diff 字符串，解析即可；操作条抄 stale 黄条模式。

**Plan 6（页签 + 新建会话）**：
- `workbench.newConversation` 已 no-op 预留——下拉必须同时被 `+` 与该命令触发；registry handler 只能 `getState()`，故触发机制＝store 标志位（如 ui.store `newConversationOpen`）或事件，而非组件 state。
- 页签轮廓：现状激活样式＝TopBar inset box-shadow 硬覆盖 + `ui/tabs.tsx:70` after 条被 opacity-0 关掉——改轮廓要同时处理两处，避免双层指示器打架。F5 设计：TopBar className 重写，不动通用 tabs.tsx。
- 服务器数据（servers + kind/version/description + serversLoading/refreshRegistry）已齐，直接喂下拉。
- `handleCreate` 语义（页签即时开、会话后台握手、失败 closeTab 回滚、session 错误落 agent.store 共享 error）须原样搬入下拉路径——该 error 目前只在 AgentComposer 渲染；下拉触发的失败需本地提示（toast/行内），否则用户在远处才看到错误。
