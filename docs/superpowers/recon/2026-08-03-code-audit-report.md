# Nex 项目代码审计报告

**日期**：2026-08-03
**分支**：`chore/code-audit-20260803`
**范围**：前端状态层（stores/commands/bridge）、前端 UI 层（features/*）、Rust/Tauri 后端（全部模块 + capabilities）
**方法**：逐文件静态审计，所有条目均经代码核实

**总体结论**：代码整体质量较高（错误处理普遍 Result 化、zip 解压有防遍历、原子写、kill_on_drop 等意识到位），但存在 **约 10 项高危问题**，集中在数据丢失路径、子进程泄漏、安全防御纵深三个方面。

---

## 一、高危问题（建议优先修复）

### 数据丢失/误删类

| # | 位置 | 问题 |
|---|---|---|
| 1 | `src/commands/KeybindingHost.tsx` L12 + `src/commands/registry.ts` L93-184 | `files.delete/copy/cut/paste` 列入输入框白名单且未排除普通 `<input>`：**在搜索框/重命名框按 Delete 会直接删除选中文件**（无确认无撤销），Ctrl+C/X/V 会劫持文本剪贴板变成文件操作 |
| 2 | `src/stores/fs.store.ts` L423-451 | 删除一个打开且有未保存修改的文件时，`closeFile` 先**静默自动保存草稿到磁盘再删除**，用户无任何确认 |
| 3 | `src/stores/fs.store.ts` L457/L501 | 重命名/移动用硬编码反斜杠 `${parent}\\${newName}` 拼接路径，原路径为 `/` 分隔时产生混合分隔符路径，导致 tab/保存/外部变更同步全部路径失配 |
| 4 | `src/stores/agent.store.ts` L356-366 | `createSession` 失败后 `pendingMessagesByConversation` 中排队消息**永久滞留、无声丢失** |
| 5 | `src/stores/agent.store.ts` L446-470 | prompt 发送**失败**时 finally 仍合成"本回合已完成"假助手消息并持久化，把失败伪装成成功 |

### 资源泄漏类

| # | 位置 | 问题 |
|---|---|---|
| 6 | `src/stores/terminal.store.ts` L102-122 | `Promise.race` 的 8s 超时定时器永不 `clearTimeout`（每次创建泄漏一个）；超时后后端 PTY 仍可能稍后创建成功，产生**无前端标签对应的孤儿 PTY 会话** |
| 7 | `src-tauri/src/terminal/pty.rs` | ① 无 `Drop` 实现，**退出应用时不 kill 存活 PTY 子进程**，遗留孤儿 shell；② shell 自然退出后 session 永留 `sessions` 列表不回收 |
| 8 | `src-tauri/src/agent/package_cache.rs` L178-204 + `src-tauri/src/agent/binary.rs` L65-80 + `src-tauri/src/git/network.rs` L19-32 | npm install 未设 `kill_on_drop`（超时后 npm 进程继续跑）；agent 二进制下载、git 网络命令**均无超时**——挂起即永久卡死 |

### 安全类

| # | 位置 | 问题 |
|---|---|---|
| 9 | `src-tauri/src/agent/binary.rs` L31-35/L51-53 | registry 条目 `version` 字段未消毒（`../` 路径遍历可投毒解压），且缺 sha256 时**跳过校验直接执行**下载的二进制 |
| 10 | `src-tauri/src/fs/create.rs` / `src-tauri/src/fs/operations.rs` / `src-tauri/src/git/repository.rs` L322-341 | 新建/重命名的 name 参数、git discard 的 file 参数均未校验 `..`/绝对路径，可**逃逸项目根**创建或 `remove_dir_all` 工作区外路径；`src-tauri/src/git/network.rs` L59-89 git 参数未加 `--` 分隔，存在 `--upload-pack=<cmd>` 命令注入缺口 |

---

## 二、中危问题（约 18 项）

### 前端逻辑

| 位置 | 问题 | 建议 |
|---|---|---|
| `src/features/editor/EditorPanel.tsx` L202-215 | tab 切换用 `key={path}` 整体 remount，**光标/滚动/选区全部丢失** | 单实例 + Compartment 切换文档并缓存选区/滚动偏移 |
| `src/features/search/SearchPanel.tsx` L139-148 | debounce effect 缺项目依赖，**切换项目后不重搜**，残留旧结果且点击指向错误项目 | 依赖加入项目 id，切换时清空并重搜 |
| `src/features/files/TreeContextMenu.tsx` L87-97 | 「复制相对路径」实际只复制了**文件名** | 从 project store 取根路径做 relative 计算 |
| `src/stores/conversation.store.ts` L273-278 | `loadMessages` 翻页无上限防护，且无请求序列号，快速切换会话时旧响应覆盖新数据 | 加最大页数防护 + requestId 校验 |
| `src/stores/conversation.store.ts` L233-247 | `renameConversation`/`autoTitleFromFirstMessage` 未捕获 IPC 失败，产生未处理 Promise rejection | 内部 try/catch |
| `src/commands/types.ts` L30-55 | canonical 用 `+` 拼接，小键盘 `+` 键绑定往返丢失；标点键跨键盘布局 token 不一致导致部分布局下快捷键失效 | 键 token 转义或结构化存储；标点优先用 e.code |
| `src/stores/settings.store.ts` L63-88 | 水合仅做 typeof 校验，不校验数值范围（fontSize=0、超大 scrollback 原样应用） | clamp 到合理区间 |
| `src/stores/ui.store.ts` L131-134 | 面板尺寸水合不校验，被篡改为 0/负数/NaN 时面板不可见且无恢复入口 | merge 时 clamp |
| `src/features/git/GitPanel.tsx` + `src/features/files/FileTree.tsx` 等 | 多处 `useStore()` 无 selector 全量订阅，高频 store 变化触发整体重渲染 | 细粒度 selector |
| `src/stores/git.store.ts` L267-286 | stash apply/pop/drop 用 index 定位，列表漂移会作用于错误条目（pop/drop 具破坏性） | 执行前校验列表一致性或按 ref 重新解析 |
| `src/features/editor/EditorFindBar.tsx` L25-38 | matchStats 每次光标移动全量遍历所有匹配（O(n)），大文档明显卡顿 | 二分查找定位当前匹配索引 |

### Rust 逻辑/跨平台

| 位置 | 问题 | 建议 |
|---|---|---|
| `src-tauri/src/agent/package_cache.rs` L162-165 | npm 参数 `--userconfig /dev/null` 在 **Windows 上无效**（主平台即 Windows） | 按平台选择 `NUL` |
| `src-tauri/src/fs/operations.rs` L45-70 | `copy_dir_recursive` 不处理符号链接，环形链接无限递归栈溢出 | `symlink_metadata` 判断 |
| `src-tauri/src/fs/operations.rs` L98-99 | 跨盘 move 仅 `fs::rename`，无 copy+delete 回退 | `CrossesDevices` 时回退 |
| `src-tauri/capabilities/default.json` L18 | `sql:default` 允许 webview 打开任意 SQLite 库（前端未使用），纯多余攻击面 | 移除该权限及插件注册 |
| `src-tauri/src/db/mod.rs` L13-17 | 未开 `PRAGMA foreign_keys/busy_timeout/WAL`，外键形同虚设且并发写立即 BUSY | 打开连接后执行 PRAGMA |
| `src-tauri/src/db/conversations.rs` L72-95 | `append_message` 三条语句无事务 | `conn.transaction()` 包裹 |
| `src-tauri/src/commands/fs_cmds.rs` 等 | 全部 fs/git 同步命令占用主线程，大项目下 `fs_search`/`git_log` 会**冻结窗口** | 迁移 `async` + `spawn_blocking` |
| `src-tauri/src/lib.rs` L97-99/L106-112 | setup 中 `.expect()` 直接 panic，窗口/数据目录异常时应用无声崩溃 | 返回 Err 让 Tauri 可读退出 |

---

## 三、性能缺陷

| 位置 | 问题 | 建议 |
|---|---|---|
| `src/features/files/FileTree.tsx` L142 | **`TreeNode` 无 selector 全量订阅 store 且递归渲染**——任意 store 变化（含点击选中）导致整棵树全部节点重渲染，大项目卡顿的直接来源（最高优先级性能项） | 细粒度 selector + `memo` |
| `src/features/editor/EditorFindBar.tsx` | 每次光标移动 O(总匹配数) 重算当前索引 | 二分查找 O(log n) |
| `src/features/terminal/TerminalPanel.tsx` L120-122 | ResizeObserver 回调无节流，拖拽面板时每次 pointermove 触发 xterm reflow + PTY resize | rAF 合并或 ~100ms debounce |
| `src/features/files/FileIcon.tsx` L1337 | 每次渲染对 extMap 键排序 | 预计算为模块级常量 |
| `src/stores/fs.store.ts` L73/L725 | `nodesByDir`/`editorCacheByProject` 只增不减，折叠/切换项目不清理 | 裁剪 + LRU 上限 |
| `src/stores/agent.store.ts` L80 等 | `permissionQueues`/`entriesByConversation` 等 Map 会话删除后不回收 | removeSession/terminated 时清理 |
| `src/features/agent/thread/ThreadView.tsx` L24 | 模块级 `measuredHeights` Map 跨会话累积永不清理 | 会话切换时清理或 LRU |
| `src/stores/terminal.store.ts` L126-136 | 会话已死时每次按键失败都触发一次全量 set 重渲染 | 一次性不可用标志 |
| `src-tauri/src/agent/acp_adapter.rs` L407-422 | 每次 agent 调用新建 current-thread runtime | 常驻 worker 线程 + channel |
| `src-tauri/src/terminal/pty.rs` L79-141 | 每 4KB 输出 emit 一次 IPC 事件，高吞吐输出淹没前端 | 8-16ms 合并缓冲 |
| `src-tauri/src/watcher.rs` | 声明永不 unwatch，多项目切换后 watcher 线程/内存只增不减 | 项目关闭时 unwatch |
| `src-tauri/src/fs/search.rs` L199-292 | `apply_replace` 的 paths 过滤为 O(文件数×paths) 线性扫描 | 转 HashSet |
| `src-tauri/src/db/conversations.rs` L141-162 | `replace_thread_entries` 循环内重复 prepare 语句 | prepare 一次循环复用 |

---

## 四、低危问题（摘要，约 30 项）

**前端**
- 多处 useEffect 依赖数组不完整（FileTree L380/L489、GitPanel L19 等，依赖 zustand 稳定引用侥幸正确）
- index 作 key 的列表（EntryView、GitActionsMenu opLog——日志裁剪后 key 错位导致闪动）
- ToolCallCard waiting 状态写入的展开 override 永不清除；组 key 用首条目 id 导致 remount 丢展开态
- ThinkingBlock/PlanBar 折叠态存组件内 useState，虚拟化卸载后丢失
- AgentComposer 用 60×250ms setTimeout 轮询等待会话就绪（busy-wait 反模式）
- 面板拖拽 pointermove/pointerup 监听器仅在 onUp 中移除，组件中途卸载会泄漏
- dragstart 直接操作 DOM classList 与 React 渲染混用
- 关闭会话 tab 激活最右而非相邻标签；`closeFile` 保存失败后 autosave 定时器已清不再重试；预览 tab 异步替换可能丢草稿
- 剪贴板混合条目（cut+copy）整体按移动处理；粘贴目标判定依赖 nodesByDir（未展开目录粘贴到父目录）
- IPC 边界层无返回值 schema 校验；`AgentNotificationPayload` 大量 unknown 透传

**Rust**
- 40+ 处 `Mutex::lock().unwrap()` 锁毒化连锁 panic 风险（临界区短小，概率低）
- `node_runtime.rs` OnceCell 永久缓存瞬时失败（node 下载失败后重启前无法恢复）
- 空仓库 git log 报错而非返回空列表；commit 不检查空暂存区可创建空 commit
- registry `refresh_if_stale` check-then-act 无并发控制，可重复拉取；缓存文件非原子写
- `remove_session` 不清理 `pending_permissions`；`kill()` 只 kill 不 wait（短暂 zombie）
- watcher `new_debouncer` 期间持锁，阻塞其它项目 watch
- 临时文件名固定 `.{name}.nex-tmp`，并发写同文件互相覆盖
- 目录列表单个 entry metadata 失败导致整目录报错

**正面确认**：无 `unsafe`、无跨 await 持锁、文件句柄全 RAII、zip 解压有 `enclosed_name` 防遍历、capabilities 未授予 shell/fs/http 高危权限、HistorySection 有跨项目数据串扰防护。

---

## 五、建议修复顺序

1. **P0（数据安全）**：高危 #1 输入框内 Delete 删文件、#9 agent 二进制供应链校验、#10 路径遍历/参数注入、移除 `sql:default` 权限
2. **P0（资源泄漏）**：#6 孤儿 PTY、#7 TerminalManager 退出时 kill、#8 三处无超时/kill_on_drop
3. **P1（逻辑正确性）**：Windows `/dev/null` 修复、自动保存后删除文件确认、路径拼接规范化、agent 失败消息处理、搜索面板项目切换
4. **P1（性能）**：FileTree 细粒度订阅 + memo（收益最大）、同步命令迁 `spawn_blocking`、编辑器光标位置保留
5. **P2**：其余健壮性与内存增长项随迭代顺手修复
