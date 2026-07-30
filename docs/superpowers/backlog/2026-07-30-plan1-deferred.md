# Plan 1 延后事项 backlog（键位骨架 + 设置弹窗）

来源：`docs/superpowers/plans/2026-07-30-plan1-keybinding-spine-settings-dialog.md` 执行期各任务评审 + 最终全分支评审（opus）的延后裁定。分支 `feat/vscode-ux-plan1`，HEAD `7d72728`。全部条目经最终评审 triage 为 OK-TO-DEFER（除已修项）。

## Plan 2 动工前必做

- **补迁移行为测试（最终评审 M-7）**：`editor.save`/`editor.close` 的 run 逻辑直测——双 Esc 节奏（含关面板分支复位）、查找栏让行分支、对话框打开 + 输入框内 Ctrl+S 的优先级用例、`setOverride` 回退默认折叠。Plan 2 的 `scm.commit` when 工作与录制期 Esc 修复都会压这些路径。

## Plan 2 自然随修

- **录制期 Esc 双关**：快捷键录制中按 Esc 会同时取消录制并关闭整个设置弹窗（radix DismissableLayer 挂 document 捕获，先于 React 合成事件，KeyRecorder 的 preventDefault 拦不住）。修法：录制期间挂起对话框的 onEscapeKeyDown。
- **M-3 录制器 mac 分歧**：KeyRecorder 的 `primary = ctrlKey || metaKey` 与 host 的 mac 语义（仅 Cmd＝primary）不一致，录 `⌃K` 存成 `⌘K`（绑定可用、标签正确，但物理动作与存储不符）。随 Esc 修复一并复用 `eventToLogicalCombo`。
- **M-6**：AgentsSection 每次挂载 `loadAllServers()` 往返一次后端，无陈旧守卫。

## 设置界面下次被触及时随修

- **M-5 英文文案**：AgentsSection 残留英文用户文案（"A name and a command are required for a custom server." 及两个 title），违反全中文约束。系从旧 SettingsPanel 原文照搬（当时授权），搬迁是修的时机但被略过。
- **M-9 陈旧注释群**：AgentsSection 挂载说明、TerminalSection "follows in task 8"、各文件顶部 `// src/...` 路径头注释、editorKeybindings.test.ts:12 行内注释与 mock 矛盾、fs.store.editor.test.ts pin 注释措辞。
- **M-10 死状态**：`pendingConflict.id` 只写不读（hint 的 useState 已在最终修复中复用）。
- **M-4**：录制器无 blur 处理（失焦后静默至再次点击）+ `outline-none` 无焦点可视提示。

## 全局/架构 backlog

- **M-2 toggle 名不副实**：`Ctrl+,` 只能开不能关设置弹窗（对话框打开时 host 全让行，view.toggleSettings 不可达）；需要 dialog-local 绑定或改名 open/close。
- **M-11 和弦缓冲**：spec 架构行提及、host 未实现；零种子命令用到。第一个和弦命令需要先定义分发契约。
- **M-1 loaded 近死字段**：keybindings.store 的 `loaded` 仅测试 mock 在用；文档化或删除。
- **M-8 持久化失败静默**：keybindings.store 的 `.catch(() => {})` 与 settings.store 一致，但用户无感知。
- **types.ts labelKey 的 "space" 死分支**（:81）：token 化永不产生 "space"（Space 键的 event.key 是字面空格，token=`" "`），检查并清理其它同类死分支。
- **comboToCanonical 不 toLowerCase(c.key)**：所有组合创建点已小写，仅手改 JSON 能注入大写→死绑定（非错绑定），低优先。
- **detectPlatform 用 deprecated navigator.platform + UA fallback**：Tauri webview 下可靠，UA 兜底已覆盖弃用失效面。
- **预览模式无测试覆盖**（b6cb468 功能提交未带测试；T11 只修陈旧断言）——下次动标签页的计划补。

## 已记录、无需行动（最终评审认定正当）

- `editor.close` = 双 Esc 而非 spec 的 Ctrl+W：计划明文规定，保留既有 UX，Ctrl+W 有关掉 Tauri 窗口的风险。
- `workbench.newConversation` 空实现占位：为 Plan 6 预留 Ctrl+Shift+N。

## 待用户执行

- **Plan 1 手动冒烟**（任务书 Task 11 Step 2 清单，桌面端 `pnpm tauri dev`）：齿轮/Ctrl+, 开弹窗、六页签、Esc/遮罩关；快捷键页签搜索/录制/冲突/重置；改键即时生效与让行；Ctrl+S 输入框内保存、双 Esc 关面板；Ctrl+Shift+F/G/E 与 Ctrl+` 切换；重启后 keybindings.json 持久化。

## 流程注记（供后续会话）

- 本分支执行期遭遇一次环境回滚事故：首轮最终修复的提交与文件整体消失（从未进入 git 对象库），再评审在幻窗口内通过、结论作废；重做后以"提交后同命令 git log + 独立 Bash 复核 cat-file/grep + 控制器亲验门槛 + 评审器起止 rev-parse 指纹"规程落定。后续会话若再遇"报告哈希不存在"，先信 reflog 与 cat-file，再信报告。
- `pnpm tsc --noEmit` 在本仓库（solution-style tsconfig，files:[]）是 no-op；真实类型门槛＝`pnpm build` 的 tsc -b 段。
