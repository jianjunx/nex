# Plan 5 执行前核验报告

核验对象：docs/superpowers/plans/2026-07-31-plan5-search-flags-replace.md（3214 行，T1–T11）
核验时 HEAD：557fb16b539f901ae18db896a65b61c5695b8dfb（分支 feat/vscode-ux-plan3）

> 本文件覆写了上一轮「实现层核验」（针对旧 3182 行版）。上轮 B1/B2/B3/R1 已在现版计划中修复核实：T1 正则用例已改大小写敏感 `Foo\s*=\s*\d`+`opts(true,false,true)`（计划 L147，单命中断言成立）；T6 已改 `utils.rerender`（L1576-1585）；T7 已经 `<mark>` 文本定位行按钮（L2096）；T4 Step 8 已新增 `saveFile` stale 守卫（L1249-1271，与既有 fs.store.editor.test.ts:71-77/118-134 无冲突）。

## 判定

【可直接执行】

计划对代码库的全部事实性假设逐条核验命中，锚点零漂移（多处行号精确吻合），无阻断项。四处命令同步、NexError `{type,message}` 序列化、camelCase→snake_case、JSON null→Option、jsdom docblock/cleanup/radix 交互模式均有仓内先例佐证。门槛基线实测：前端 21 文件 / 108 测试全绿（3.15s）、lint 恰 6 条 warning、Rust fs_test.rs 恰 2 条既有用例——与计划声称一致。仅 2 条风险与 4 条注记，均不阻断。

### 核验矩阵（计划声称 → 磁盘事实）

| 计划声称 | 结论 | 证据 |
|---|---|---|
| search.rs：`search(project_path, query)` 小写子串；SearchMatch{path,name,line,text} camelCase；MAX_RESULTS=200 / 1MB / MAX_LINE_LEN=200；WalkBuilder+hidden+git_ignore+git_exclude；无测试 | ✓ | src-tauri/src/fs/search.rs:29 签名、:11-16 结构体、:19-23 常量、:35-39 过滤、:30/:56/:70 小写子串；全文件无测试，fs_test.rs 仅 tree/write |
| Cargo.toml 无 regex；ignore 行为 T1 插入锚点 | ✓ | src-tauri/Cargo.toml:20-49 无 regex；`ignore = "0.4"` 在 :38 |
| fs_cmds.rs use 行与 fs_search 整块可精确替换 | ✓ | src-tauri/src/commands/fs_cmds.rs:6 use 行、:42-44 fs_search，与 T1 Step 4 锚点逐字一致 |
| fs_write_file → write.rs 原子写（同目录临时文件+rename） | ✓ | fs_cmds.rs:27-29 → src-tauri/src/fs/write.rs:10-27（`.{name}.nex-tmp` + rename，UTF-8 往返） |
| NexError::FileSystem(String)；中文校验先例 fs/create.rs:7 | ✓ | src-tauri/src/error.rs:5 serde tag/content、:13-14 FileSystem(String)；fs/create.rs:7 恰为 `文件已存在: {name}`；Display 前缀 "FileSystem error:" 不破坏 T1 `msg.contains` 断言 |
| lib.rs：fs_search 已注册（T1 免动）；T2 插入锚点 | ✓ | src-tauri/src/lib.rs:42 `commands::fs_cmds::fs_search,` 精确 |
| fs_test.rs 既有 2 条，可扩 | ✓ | src-tauri/tests/fs_test.rs:8/:20 恰两条；:4-5 `use std::fs;`+`tempdir` 覆盖计划追加用例依赖 |
| bridge/tauri.ts fsSearch 在 L291，SearchMatch 接口紧邻其上 | ✓ | src/bridge/tauri.ts:291-293 + :284-289，与 T3「整块替换」锚点精确吻合 |
| AgentComposer.tsx:115 为 fsSearch 第二调用方（两参，须后向兼容） | ✓ | src/features/agent/AgentComposer.tsx:115；全仓第三处仅 fs.store.ts:432；T3 缺省参 `= null` 使两处零改动（T11 差异自检有据） |
| Option/null 桥接与 camelCase→snake_case 先例 | ✓ | 命令侧 Option 形参：terminal_cmds.rs:6、agent_cmds.rs:70、git_cmds.rs:97-98；JS null→Option：tauri.ts:189-191（optionId）；camelCase 映射：tauri.ts:299-301 `parentDir`→`parent_dir` |
| SearchPanel.tsx 89 行、300ms 防抖、扁平列表、openFile 丢弃 m.line | ✓ | src/features/search/SearchPanel.tsx 全文 89 行；:7 DEBOUNCE_MS=300；:68 `openFile(m.path)` |
| fs.store.ts：第 5 行导入、search 写共享 error 槽（EditorPanel 红条）、openFile(pin=false)、loadEditorState 用 openFile(path,true)、partialize 仅 editorLayoutByProject | ✓ | fs.store.ts:5 导入逐字吻合；:425-443 search/clearSearch 与 T4 Step 6 锚点逐字吻合；:69/:162 openFile 签名与实现头；:499 `openFile(path, true)`；:534-536 partialize；红条 EditorPanel.tsx:122-127 |
| openFile 三处成功出口锚点（已打开/预览替换/新推入） | ✓ 逐字 | fs.store.ts:174-180 / :199-203 / :216-219（含 :218 注释，缩进可区分） |
| saveFile stale 守卫锚点 `if (!cur || !cur.dirty) return true;`（T4 Step 8） | ✓ | fs.store.ts:344；守卫与既有用例无冲突（fs.store.editor.test.ts:71-77 保存态 stale=false；:118-134 不在 stale 态保存） |
| fs-changed 链路：watcher 500ms debounce → syncExternalChange（dirty→stale 黄条 / clean→静默重读），计划「不抑制 watcher」 | ✓ | src-tauri/src/watcher.rs:72-73 `Duration::from_millis(500)`、:24 事件名、全文无自写过滤（应用自身写盘必回火——裁定前提属实）；src/App.tsx:65-69 onFsChanged→loadRoot+syncExternalChange；fs.store.ts:367-393 dirty→stale :370-376 / clean 重读 :378-391（:383 `if (!f \|\| f.dirty) return` 二次防护）；黄条 EditorPanel.tsx:128-134 |
| registry.ts search.focus（Ctrl+Shift+F）已注册，run 仅 setSidePanelTab | ✓ | src/commands/registry.ts:56-61，:60 run 与 T9 Step 3 锚点逐字吻合；:59 键位 `k("keyf",{primary,shift})` 不动 |
| registry.test.ts 已断言 primary+shift+keyf | ✓ | src/commands/registry.test.ts:23 |
| KeybindingHost 输入框焦点让行；Ctrl+Alt+Enter 无注册冲突 | ✓ | KeybindingHost.tsx:52 inInput 让行、:49 dialog 打开全让行；registry.ts 全文 grep "enter" 零命中 |
| ui/ 无 alert-dialog；dialog.tsx 用统一包 radix-ui；Button 有 icon-xs/outline/buttonVariants；Input ComponentProps 透传（React 19 ref-as-prop） | ✓ | ls src/components/ui/ 无 alert-dialog.tsx；dialog.tsx:3 `import { Dialog as DialogPrimitive } from "radix-ui"`；button.tsx:29 icon-xs、:15-16 outline、:64 buttonVariants；input.tsx:5 |
| radix-ui 统一包导出 AlertDialog | ✓ | node_modules/radix-ui@1.6.7 dist 类型含 AlertDialog 命名空间导出 |
| 计划引用的全部 lucide 图标存在 | ✓ | node_modules/lucide-react@1.26.0 含 ChevronRight/ChevronsDownUp/ChevronsUpDown/FileCode/RefreshCw/Replace/Search/X/Loader2 |
| relativeToProject(path, projectPath?) 签名 | ✓ | src/features/editor/pathUtils.ts:13-16（第二参 `string \| undefined \| null`，与 T7 `project?.path` 吻合） |
| 测试基建：vite environment=node、未开 globals；store 测试与命令 run 测试先例 | ✓ | vite.config.ts:27-30；fs.store.editor.test.ts:3-13（模块级 vi.fn+工厂，无 docblock）；registry.run.test.ts:1-3 docblock、:8/:36 可变 let、:16-18 ui.store mock 与 T9 锚点逐字吻合 |
| ui.settings.test.ts 存在且用真实 store | ✓ | src/stores/ui.settings.test.ts:1-11（node 环境，persist 对缺 localStorage 容错，基线已绿） |
| ui.store 锚点：settingsOpen 声明/初值、closeSettings、partialize 白名单 | ✓ | ui.store.ts:21/:47/:32/:70（closeSettings 逐字吻合）/:75-83 白名单不含 searchFocusRequest（天然不持久化） |
| EditorPanel 锚点：viewRef、accessor effect、onCreateEditor、hooks 早于早退 | ✓ | EditorPanel.tsx:58/:70-73/:143（onCreateEditor 逐字吻合）；:75 早退在全部 hooks 之后；EditorView 自 @uiw/react-codemirror :2（theme/scrollIntoView 可用）；T5 mock 的 ./editorSearch、./language、../../commands/editorKeybindings 均存在（:11/:10/:4） |
| globals.css 233 行尾部追加；CSS 变量齐备；tw-animate-css 已引入 | ✓ | wc -l=233；:44-46 overlay-hover/ghost/active、:55 accent、:64-65 warning/error、:67-68 radius、:74 glass-2-surface、:76 glass-border；:3 `@import "tw-animate-css"`（dialog.tsx:42 已用 animate-in/fade-in-0） |
| 新标识符无命名冲突 | ✓ | grep 全 src：search-stagger/search-collapse/searchFocusRequest/pendingLine/searchError/replacePreview 零命中 |
| 门槛基线：lint 6 warning、前端测试全绿 | ✓ | `pnpm lint` 实测恰 6 条（App.tsx:29、tabs.tsx:91、button.tsx:64、KeybindingHost.tsx:16、GitPanel.tsx:16、FileTree.tsx:220）；`pnpm test` 实测 21 文件/108 测试全绿 |
| Rust/前端语义推演：T1 六条用例、T2 七条用例、前端各测试文件 | ✓ | 逐条推演 fixture × `(?i)`+escape+`\b(?:…)\b` 合成规则与预算语义皆绿；T1 regex 用例（现版大小写敏感）内容命中恰 1 条；T2 预算测试 200/50 分配与闭包封顶语义一致；radix AlertDialog 在 jsdom 无 computed animationName → Presence 同步卸载，cancel 用例 `queryByRole("alertdialog")` 为 null 成立 |
| 占位符扫描（TBD/TODO/"类似 Task N"/空指令） | ✓ 无 | 全文 grep 零命中；每个 Step 带完整代码块；File Structure 表 23 条目与 T1–T11 逐一对应 |

## B（阻断：不修则任务无法按文执行）

无。

## R（风险：可执行但照文执行会产出缺陷/返工）

### R1: 正则模式下「搜索按行、替换按全文」的语义面不一致
- 计划位置：T1 search() 逐行 `re.is_match(line)`（计划 L297-308）vs T2 `re.find_iter(&content).count()`（L568）/ `re.replace_all(&content, …)`（L629）；计划 L252-254 仅声明「搜索」LINE-based 为 v1 限制，T2 裁定段（L366-371）未提替换面
- 计划声称：「Matching is LINE-based: multiline constructs (`\n`, `(?s)`) cannot span lines — documented v1 limitation」
- 实际：搜索逐行、替换逐全文。正则模式下 `a\nb`、`foo$`（CRLF 文件中 `$` 不匹配行中 \r\n 前）等模式会出现预览计数/写盘命中而搜索结果列表一条不显示（或反向分歧）——用户可见「将修改 N 处」确认后结果视图为空。非正则（子串/全词）模式不受影响，故为边缘面。
- 建议修法：T2 裁定段显式声明该差异为 v1 已知限制；或把 search_replace/apply_replace 亦改为逐行遍历以与搜索同面。

### R2: apply_replace 中途写盘失败 → 部分替换无回滚；只读文件未纳入裁定
- 计划位置：T2 apply_replace（计划 L615-646，`write_file(&path, &replaced)?` 在 L641）；T2 裁定段 L366-371 未列只读/权限/中途失败
- 计划声称：裁定覆盖预览/预算/捕获组/名称命中/非 UTF-8/>1MB，未涉及写盘失败形态
- 实际：write_file 的 io 错误经 `?` 上抛（src-tauri/src/fs/write.rs:20-25），循环中靠前文件已写盘——多文件替换命中只读/被占用文件时停在半途，前端仅得一条 searchError，无「已改 X 个文件后失败」提示或回滚。确认 dialog 文案（L2752）未覆盖该形态。
- 建议修法：apply_replace 改为「收集失败、继续遍历、末尾汇总报错（含已写数）」；若判 v1 可接受则在裁定段明示。

## N（注记：可接受的偏差、行号漂移、风格建议）

- N1（计数表述不一致，不影响执行）：T2 Files 头「+6 测试」（L349）实为 7 条；T2 Step 4「T1 8 条 + 本任务 7 条 + 既有 2 条」（L689）重复计入既有 2 条；T11「含 fs_test.rs 新增 15 条」（L3174）应为「新增 13 / 合计 15」。测试代码自洽，照文跑即绿。
- N2（口径差异）：统计条按 SearchMatch 条数（每命中行一条），替换预览按出现次数（find_iter）——同一行两次命中时「1 个结果」对「共 2 处」。预览↔写盘一致性不受影响（同为次数口径），属展示差异，可接受。
- N3：T5 的 `useEffect(..., [pendingLine, editorFile?.path])`（L1451-1454）引用组件内 applyPendingLine 未入依赖，oxlint exhaustive-deps 大概率新增 1 条 warning（现基线恰 6 条）；计划门槛为「不新增 error」（L15），warning 不破门槛，可顺手 useCallback 规整。
- N4：T9 聚焦 effect `if (searchFocusRequest > 0)`（L3005-3007）——计数用过后恒 >0 且不持久化，SearchPanel 条件挂载（侧栏页签切换即卸载重挂）会因陈旧计数再次抢焦点；轻微，可用 ref 前值比较规避。
- N5（正向记录）：锚点零漂移——fsSearch 恰在 tauri.ts:291、AgentComposer 调用恰在 :115、create.rs 先例恰在 :7、SearchPanel.tsx 恰 89 行、globals.css 恰 233 行、lint 恰 6 warning、fs_test.rs 恰 2 条既有测试、openFile 三处出口与 registry.run.test.ts/ui.store 全部 Edit 锚点逐字命中；上轮核验的 3 个测试手法阻断（正则命中数、二次 render、getByText 跨 mark）在现版已修复核实。计划勘察质量高，执行时可直接按锚点粘贴。
