# 对齐 VSCode 的 UX 增强（设置 / Git / 搜索 / 快捷键 / 页签 / 新建会话）

日期：2026-07-30

## 背景

Nex 当前是一套 Tauri + React 19 + CodeMirror + Zustand + shadcn/radix 的 IDE 外壳。已有：文件树、编辑器多标签、终端、侧栏页签（files/git/search/settings）、Agent 会话标签、基础 Git（status/diff/log/stage/unstage/commit）、大小写不敏感的子串搜索。

本轮把七处体验对齐 VSCode：① 设置改弹窗并用页签分区；② Git 面板丰富化（提交/分支切换/拉取/推送等，仿 VSCode 源代码管理）；③ Git diff/查看改在编辑器面板打开；④ 全局搜索增加匹配规则与替换；⑤ 全局快捷键并可在设置里改键，默认采用 VSCode 键位布局；⑥ 对话页签加轮廓；⑦ 新建会话改成下拉面板、点 Agent 直接创建。

参考源：VSCode 既有交互布局（截图为准）+ 现状代码；不引入新的大型依赖。

## 决策

- 快捷键采用**命令注册表 + 键位服务**架构（方案 A）：集中命令注册表 + 持久化覆盖 + 冲突检测 + 全局捕获分发器，替换现有散落的 `useEffect` 键位监听。理由：唯一能同时满足“VSCode 默认 + 可改键 + 设置编辑器”的方案，且让其余功能的快捷键零成本接入。
- 快捷键支持**运行时改键**，VSCode 默认键位按平台区分（win/mac），用户覆盖持久化。
- Git 做**全套操作**，含网络操作（pull/push/fetch/clone）。
- 网络凭据做 **GUI 密码弹窗**（事件 + oneshot 握手），凭据仅内存、会话级“记住”、绝不落盘；无 keychain 集成。
- 搜索替换做**全项目磁盘替换**（带预览 + 确认），写盘后借现有 `fs-changed` 同步已打开文件。
- diff 在编辑器以**独立只读虚拟标签**呈现，**不**塞进 fs 草稿/保存/autosave 流。
- 设置从侧栏页签**提升为弹窗**，`SidePanelTab` 移除 `"settings"`，入口收敛为齿轮按钮 + 命令 + `Ctrl+,`。
- 新建会话**删除** `NewConversationModal`，改为 `+` 触发的受控下拉，点行即创建。
- 视觉保持 Nex 液态玻璃语言；动效克制（150ms 过渡、stagger 入场、渐隐遮罩、数字/计数微动），不为动效而动效。

## 架构

### 命令与快捷键骨架（地基）

```
commands/registry.ts        // Command { id, title, category, defaultKey:{win,mac}, when?, run }
stores/keybindings.store.ts // overrides: Record<id, KeyCombo|null> (persist) + resolve/setOverride/reset + 冲突检测
commands/KeybindingHost.tsx // 根挂载，window 捕获阶段：chord 缓冲 → 归一化 → 让行规则 → 查命令 → when → run
features/settings/KeybindingsEditor.tsx  // 搜索表 + 录制改键 + 重置 + 冲突角标
```

- 全局分发器在焦点位于 `input/textarea/[contenteditable]` 或打开的 `[role=dialog]` 时**让行**，除非命令在“输入框可用”白名单（如 `Esc`、`Ctrl+S`、提交框 `Ctrl+Enter`）。
- 支持两段式 chord（VSCode 风格）。
- 预置命令（默认键位，win / mac）：`view.toggleSidebar`(`Ctrl+B`)、`search.focus`(`Ctrl+Shift+F`)、`scm.focus`(`Ctrl+Shift+G`)、`terminal.toggle`(`Ctrl+`` ` ``)、`workbench.newConversation`(`Ctrl+Shift+N`)、`editor.save`(`Ctrl+S`)、`scm.commit`(`Ctrl+Enter`, when=提交框聚焦)、`editor.close`(`Ctrl+W`)、`view.toggleSettings`(`Ctrl+,` / `Cmd+,`) 等。`run` 调既有 store，逻辑不搬移。

### 数据流（快捷键 → 功能）

```
keydown → KeybindingHost → resolve(combo) → command.when? → command.run()
  run() → useUiStore / useFsStore / useGitStore / conversation store 的既有动作
settings 改键 → keybindings.setOverride（冲突检测）→ 持久化 → 分发器下次按键即用新绑定
```

## 功能设计

### F1 设置弹窗 + 页签（需求1）

- `ui.store` 增 `settingsOpen` + `openSettings/closeSettings/toggleSettings`。
- 触发：IconBar 齿轮、命令 `view.toggleSettings`、`Ctrl+,`(`Cmd+,`)。
- `SidePanelTab` 去掉 `"settings"`；`SidePanel.tsx` 删对应分支；`IconBar` 齿轮改调 `openSettings()`。
- `SettingsDialog.tsx`（`components/ui/dialog`，`sm:max-w-3xl`，约 70vh）：**左侧竖向 nav + 右侧内容**（自写 nav，对齐 VSCode 观感）。页签：外观 / 编辑器 / 终端 / 智能体 / 快捷键 / 布局。
- 拆分 `SettingsPanel.tsx` 为 `settings/{Appearance,Editor,Terminal,Agents,Layout}Section.tsx` + `KeybindingsEditor.tsx`，逻辑原样搬移。
- 弹窗内不嵌套 dialog（智能体删除等用内联确认）。Esc/遮罩关闭由 Radix 提供。无后端改动。

### F2 Git 面板丰富化（需求2）

面板结构（仿 VSCode 源代码管理）：
- 头部：当前分支（点→分支选择器）、`↑ahead ↓behind`、刷新、`···` 更多菜单。
- 提交区：消息输入（`Ctrl+Enter` 经 `when` 提交）+ “✓ 提交”；按钮旁下拉切“提交并推送/提交并同步”。
- `···` 菜单（分组对齐截图）：以树形式查看、查看和排序；拉取/推送/获取/克隆/签出到…/抓取；提交、更改、拉取推送、分支、远程、存储、标记 子菜单；显示 GIT 输出（v1＝展开临时操作日志，见非目标）。
- 更改 / 暂存的更改 两组：可折叠、整组 stage/unstage/discard；每行 hover 出 暂存/撤销暂存/丢弃/打开diff 图标；状态字母 M/A/D/U 着色。
- 树视图：前端按 `/` 分段渲染（数据不变，仅视图切换）。
- 分支选择器：搜索框 + 本地/远程列表 + 当前打勾 + “新建分支…”。
- 提交历史：底部可折叠，用既有 `git_log`，每条可点看该提交 diff（F3）。
- 破坏性操作（丢弃、删分支）走确认 dialog；操作进行中 spinner/禁用；失败用面板错误条。

凭据握手（GUI 弹窗）：
- 后端 `PendingGitCredentials: Mutex<HashMap<requestId, oneshot::Sender<CredentialAnswer>>>` 挂 tauri State。
- git2 `credentials` 回调顺序尝试：① `git credential` helper；② SSH agent / 无密码 key。都不行 → 生成 `requestId`，`emit("git-credential-request", { requestId, url, usernameHint, kind: "https" | "ssh-passphrase" })`，在该 oneshot 阻塞等待（超时≈5 分钟=取消）。
- 前端根挂载 `features/git/GitCredentialModal.tsx` + 小 store 持有 pending 请求：弹窗显示 host/username（https 用户名可编辑）+ 密码/令牌/口令 + “本次会话记住” + 取消；提交 `invoke("git_credential_respond", { requestId, username?, password?, remember })`，取消 respond `null`。
- `remember=true` 存**仅内存**会话缓存（key=url 或 key 指纹），同 host/key 复用不再弹窗；`null` → git2 鉴权失败。SSH 受密码保护私钥：发 `kind:"ssh-passphrase"`，用口令解密。
- 凭据只在内存、`type=password`、会话结束清空；无 keychain。

后端新增（`git/repository.rs` + `commands/git_cmds.rs` + `bridge/tauri.ts` + `bridge/commands.ts`）：
- 分支：`git_list_branches`、`git_checkout`、`git_create_branch`、`git_delete_branch`。
- 网络：`git_fetch`、`git_pull`、`git_push`、`git_clone`（URL/目标目录用 tauri dialog 插件前端选取后传入）。
- 存储：`git_stash_save`、`git_stash_pop`、`git_stash_apply`、`git_stash_list`、`git_stash_drop`。
- 更改：`git_discard`（工作区还原/删未跟踪）、`git_revert_staged`。
- 凭据：`git_credential_respond` + 事件 `git-credential-request`。
- 类型：`BranchInfo { name, is_head, is_remote, ahead?, behind? }`、`StashEntry { index, message }`；`CommitInfo` 已有。

线程/错误：网络与丢弃等阻塞操作放 `spawn_blocking`/tauri async + `tokio::task::spawn_blocking`；git2 错误映射可读中文（detached HEAD、脏工作区阻止切换、非快进推送等）。

### F3 diff / 查看在编辑器打开（需求3）

- 目标：点 Git 面板任一文件 / 历史提交 → 编辑器面板开**只读 diff 标签**；移除侧栏 200px 内联 `<pre>` 窗格。
- `fs.store` 增独立 `diffTabs: DiffTab[]` + `activeDiffId`，与 `openFiles` 并列；`EditorPanel` 标签条合并渲染、激活互斥。`DiffTab { id, path, title, side: 'working'|'staged'|'commit', baseRef?, diff, loading }`。
- `features/editor/DiffEditor.tsx`：独立只读 CodeMirror（`editable=false`），按行装饰 `+`绿/`-`红/`@@`淡化/上下文普通；可挂只读查找（`Ctrl+F`，复用 `editorSearch` 查找部分，不挂写回）。
- `git.store` 增 `openDiffInEditor(path, side, baseRef?)` → `gitDiff`（提交视图用新增 `git_diff_commit`）→ 写 `diffTabs` 并激活 + `setEditorVisible(true)`。Git 面板 `viewDiff` 改调它；移除 `diff`/`diffFile` 侧栏状态。
- 标签标题：`文件名 (工作区)/(已暂存)/(abcd123)` + diff 图标；可关；不可编辑、无 ●、不参与 autosave/`Ctrl+S`。
- 刷新：快照语义；`git-status-changed`/手动刷新后同类 diff 标签标“已过期”角标 + 重新加载按钮（不自动覆盖，保滚动位置）。
- 二进制/超大：diff 含 `Binary files`/`GIT binary patch` 时占位提示。
- 后端补 `git_diff_commit`（某提交相对父的指定文件 diff）。

### F4 全局搜索：匹配规则 + 全项目替换（需求4）

面板（对齐截图 + 更“活”）：
- 顶工具条：刷新、清除、折叠/展开全部。
- 搜索行：输入框 + `Aa`(大小写) / `ab|`(全词) / `.*`(正则) 三枚带状态开关；正则非法→红框 + 行内错误且不搜。
- 替换行：输入框 + 替换全部；单条/单文件替换在结果里。
- 可选过滤行（v1 可后置）：`files to include/exclude`(glob)。
- 结果区：按文件分组，组头＝图标 + 名称 + 相对路径 + 计数徽标；行＝行号 + 命中片段，**命中高亮**；点行→编辑器打开并定位该行。
- 统计条：“N 结果 / M 文件”，搜索中 spinner。
- 微交互：结果 stagger 渐显、组折叠高度过渡、替换后命中行闪烁移除、计数变化淡入淡出。

匹配语义：默认大小写不敏感子串；`Aa`敏感；`ab|`词边界；`.*`正则；组合生效。

全项目磁盘替换：
- 单条/单文件/全部替换均**写盘**。
- 后端 `fs_search_replace(...)` 服务端替换并**返回每文件改动数预览**（不写盘）；“替换全部”先预览→确认 dialog（“将修改 X 个文件”）→`fs_apply_replace` 写盘。单条/单文件直接写指定范围。
- 与编辑器协同：写盘后 `fs-changed` → 既有 `syncExternalChange`；已打开且干净→静默更新；已打开且有草稿→stale 横幅（行为可预期，面板文案点明）。
- 替换后自动重搜。正则替换支持捕获组回填（`$1`/`${name}`）。

后端（`fs/search.rs` + `commands/fs_cmds.rs` + bridge）：
- `search` 增 `SearchOptions { case_sensitive, whole_word, regex }`；正则用 `regex` crate，非法模式返回 `NexError`。
- 新增 `search_replace`（预览 `Vec<{path,count,preview?}>`）与 `apply_replace`（写盘，沿用 `fs/write.rs`）。
- 仍守 `.gitignore`/隐藏过滤、`MAX_RESULTS`/大小上限（替换同受约束，避免误改二进制/超大）。

快捷键（经骨架）：`search.focus`=`Ctrl+Shift+F`；面板内 `Enter`下一个、`Shift+Enter`上一个、`Ctrl+Alt+Enter`替换全部。

### F5 对话页签轮廓（需求6）

- 现状 `line` 变体（仅底部强调线 + 透明底）→ 改**有边界胶囊页签**。
- 激活态：`bg-[var(--glass-2-surface)]` + `1px` 描边 `border-[color:var(--border-default)]` + 顶部极淡内高光（`inset 0 1px 0`）；去掉底部线，改**整圈描边 + 左侧 2px 强调色边**。
- 非激活态：透明底、**透明占位边框**（hover 时边框透明度 0→1 淡入，避免布局抖动）+ hover `bg-[var(--overlay-hover)]`。
- 形状 `rounded-[var(--radius-md)]`；状态点 + 标题 + × 间距统一。
- 动效：bg/border/color 150ms；非激活 hover `translateY(-1px)`；激活强调边宽度/透明度过渡滑入。
- 溢出：横向滚动 + 左右**渐隐遮罩**（mask），不露滚动条。
- 实现：在 `TopBar` 的 `TabsTrigger` className 重写状态样式，不动通用 `tabs.tsx`。

### F6 新建会话下拉（需求7）

- 删 `NewConversationModal.tsx`；`TopBar` 去其 state/挂载，`+` 改受控下拉（`components/ui/dropdown-menu`，Radix 键盘导航/Esc/焦点陷阱，portal 于拖拽区外）。
- 受控 `open`，使命令 `workbench.newConversation`(`Ctrl+Shift+N`) 也能打开。
- 面板：顶行“选择智能体” + 右侧刷新（旋转态）；Agent 列表每行＝名称 + 版本 + kind 徽标 + 描述一行截断；**点行即创建**（复用现 `handleCreate`：`createConversation` 立即开标签 + `createSession` 后台跑）。底部“管理智能体…”跳设置智能体页签。
- 空态/加载：无 Agent→提示 + 刷新；加载中骨架/转圈。
- 防连点：创建中禁用列表项 + 行内 spinner；成功关下拉；失败关下拉并把错误上抛 agent store 错误条/toast。
- 微交互：列表项 stagger 淡入、hover 高亮带左侧强调色条（与 F5 呼应）。

## 非目标

- keychain / 系统钥匙串集成（凭据仅内存）。
- GUI 之外的交互式 git 提示（rebase 冲突解决器等）。
- 命令面板（`Ctrl+Shift+P` 命令面板 UI）——本轮只做命令注册表 + 键位，不做命令面板浮层（可作为后续）。
- 持久化“GIT 输出”通道/面板——`···` 菜单的“显示 GIT 输出”在 v1 路由到既有错误条 + 轻量临时操作日志（内存环形缓冲，可在设置或面板底部展开查看），不做 VSCode 式 Output 面板。
- 搜索的 `files to include/exclude` glob 过滤（v1 可后置，UI 位预留）。
- diff 的可编辑/三路合并视图。
- 读/写 VSCode `keybindings.json` 文件（仅应用内持久化）。

## 验收

- 设置：齿轮 / `Ctrl+,` 打开弹窗；六个页签可切；改主题/终端/智能体行为与现有一致；侧栏不再含设置页签。
- 快捷键：VSCode 默认键位生效；设置快捷键页签可搜索/录制改键/重置/显示冲突；改键即时生效并持久化；输入框内让行规则正确。
- Git：可提交、切/建分支、pull/push/fetch/clone、stash、丢弃/撤销暂存、树视图、历史查看；网络操作触发 GUI 凭据弹窗，“记住”后同 host 不再弹；错误可读。
- diff：点文件/历史在编辑器开只读 diff 标签，着色正确，二进制占位，过期可重载；侧栏无内联 diff。
- 搜索：大小写/全词/正则开关生效、非法正则报错；全项目替换带预览确认并写盘；已打开文件按 stale/静默规则同步；命中高亮 + 跳转定位。
- 页签：激活有轮廓 + 左侧强调边，hover/激活动效平滑，溢出渐隐遮罩。
- 新建会话：`+` / `Ctrl+Shift+N` 打开下拉，点 Agent 直接创建，无中间选中态；旧 modal 已移除。

## 测试策略

- 前端单测（vitest + testing-library，沿用现有 `*.test.ts` 模式）：
  - `keybindings.store`：resolve 默认/覆盖、冲突检测、reset、平台键归一化。
  - 命令注册表：默认键位无意外重复（除非 when 互斥）、id 唯一。
  - 搜索 options 组合的纯函数（若有前端归一化）。
- 后端单测（Rust，沿用现有）：`search` 的 case/whole-word/regex 分支与非法正则错误；`search_replace` 预览计数与 `apply_replace` 写盘；git 分支/checkout/stash/discard 在临时仓库的happy path。
- 手动/E2E 核对（playwright 可选）：凭据弹窗握手、diff 标签只读与过期重载、替换确认流、键位让行。
