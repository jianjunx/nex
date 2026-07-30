# Plan 5 实现层核验（执行前设计关卡）

**日期**：2026-07-31
**核验对象**：`docs/superpowers/plans/2026-07-31-plan5-search-flags-replace.md`（3182 行，T1–T11 全量）
**方法**：计划锚点 × 磁盘真实源码逐字核对（Read/Grep）；radix-ui 1.6.7 / lucide-react / regex-crate 语义以本机 node_modules 与 crate 契约为实证；只读，未改任何文件、未做 git 操作。方法先例与分级格式照 Plan 3 T1–8 核验报告。
**分级**：Blocker（执行必挂）／Risk（能跑但有隐患）／Note（可接受但应知会）。

---

## 维度结论

| # | 维度 | 结论 | 说明 |
|---|------|------|------|
| ① | 编译可行性（Rust） | **通过** | regex 依赖缺失已在 T1 Step 2 显式补（Cargo.toml 现无 regex，核实属实）；`compile_pattern`/`search`/`search_replace`/`apply_replace` 全部 API 用法合法（含 `replace_all` 闭包 Replacer、`Cow<str>` → `&str` deref 强转写盘）；`Option<SearchOptions>` command 参数 + Tauri 2 camelCase 自动映射有现网先例。 |
| ② | 锚点真实性 | **通过** | 全部锚点与磁盘逐字吻合（细目见下），含 fs.store openFile 三处成功出口的缩进级 old_string、registry.run.test.ts 的 ui.store mock 块、radix-ui 统一包 AlertDialog 命名空间导出。 |
| ③ | 类型一致性 | **通过** | 命令名四处同步链（fs_cmds.rs → lib.rs → commands.ts → tauri.ts）逐字对齐；Rust serde camelCase 字段 ↔ TS 接口 ↔ store ↔ 组件消费链全链一致；`fsSearch` 缺省参后向兼容覆盖 AgentComposer.tsx:115 两参调用。 |
| ④ | 测试可运行性 | **失败** | B1：T1 Rust 用例 `test_search_regex_mode` 断言 1 命中、实际 2 命中，必红；B2：T6「切开关重搜」测试二次 `render()` 建新根、mock store 无订阅，旧实例不重渲，断言必红；B3：T7 行点击测试 `getByText("const ")` 因 `<mark>` 切割文本必抛。其余用例（Rust 13 条 + 前端各文件）核过可编译可跑。 |
| ⑤ | 设计漏洞扫描 | **通过** | 无 Blocker；1 Risk（autosave 与替换写盘的竞态回滚）、5 Note，均 v1 可接受或一行级规避。fs-changed 链路脏/净语义经 fs.store.ts:367-393 核实与计划声称一致。 |

### ① 编译可行性细目

- `src-tauri/Cargo.toml` 现状 `[dependencies]` 无 regex（L20-49 全段核实），`ignore = "0.4"` 在 L38——计划 T1 Step 2「ignore 行之后插 `regex = "1"`」锚点正确；`tempfile = "3"` dev-dep 在 L52，T1/T2 tempdir 用例可用。
- `regex::Regex` + `Replacer` 闭包：`impl<F, T: AsRef<str>> Replacer for F where F: FnMut(&Captures) -> T`——T2 `apply_replace` 闭包两分支均返回 `String` ✓；`caps.expand(replacement, &mut dst)` 签名 `(&self, &str, &mut String)` ✓；`replace_all` 返回 `Cow<str>`，`write_file(&path, &replaced)` 经 deref 强转（`Cow: Deref<Target=str>`）匹配 `write_file(path: &Path, content: &str)`（`fs/write.rs:10`）✓。
- 写盘路径：复用 `fs/write.rs::write_file` 原子写（同目录 `.{name}.nex-tmp` + rename，UTF-8 only）——替换经 `read_to_string`（非 UTF-8 跳过）→ 仅匹配区间改动 → CRLF/BOM 原样往返，编码与行尾保持语义成立；`fs/mod.rs:3` `pub mod write;` 公开，search.rs 内 `use crate::fs::write::write_file;` 合法。
- `NexError::FileSystem(format!("无效的正则表达式: {query}"))`：`error.rs:13-14` FileSystem(String) 变体存在；`#[error("FileSystem error: {0}")]` Display 保留原文，T1 测试 `msg.contains("无效的正则表达式") && msg.contains("[unclosed")` 可满足。
- Tauri command 参数：`Option<SearchOptions>`/`Option<Vec<String>>`/`Option<usize>` 对 JSON null→None 有现网先例（tauri.ts `terminalCreate(projectPath, shell?)` 传 undefined 键）；camelCase→snake_case 自动映射由 `projectPath → project_path`（fs_cmds.rs:12 ← tauri.ts:265）等全量现网调用实证，`limitPerFile → limit_per_file` 同理。
- SearchOptions `#[derive(Debug, Clone, Copy, Default, Deserialize)]` + `#[serde(rename_all = "camelCase")]` + 字段 `#[serde(default)]`——缺字段/全缺对象皆容错 ✓。

### ② 锚点真实性细目（全部吻合）

- `src-tauri/src/fs/search.rs` 现状 82 行：`search(project_path, query)` L29、`SearchMatch` L9-16 camelCase、`MAX_RESULTS=200` L19、`MAX_CONTENT_FILE_SIZE` L21、`MAX_LINE_LEN=200` L23、WalkBuilder 三过滤 L35-39、无测试——与计划「既有事实」逐字一致。
- `fs_cmds.rs`：`use crate::fs::search::{SearchMatch, search};` L6（T1/T2 改导入锚点 ✓）；`fs_search` L39-44（T1 整块替换 ✓）；`fs_write_file` L26-29。
- `lib.rs`：`commands::fs_cmds::fs_search,` L42（T2 其后插两行注册 ✓）；invoke_handler 全表 L27-68。
- `commands.ts`：`FS_SEARCH: "fs_search",` L45（T3 其后插两常量 ✓）。
- `tauri.ts`：`SearchMatch` 接口 L284-289 + `fsSearch` L291-293 为连续块（T3「整块替换」✓）；`fsWriteFile` L276-278。
- `fs.store.ts`：L5 导入行（T4 Step 2 替换 ✓）；接口 `searching: boolean;` L57、`openFile: (filePath: string, pin?: boolean)` L69、`clearSearch: () => void;` L84、`clearError` L85（插入位 ✓）；`EditorCache` 类型 L48（类型插入位 ✓）；初始值 `searchResults: [],` L114；openFile 实现头 L162；三处成功出口 L174-180 / L199-203 / L205-219（old_string 缩进逐字吻合，14 空格 vs 10 空格可区分）；search/clearSearch L425-443（old_string 逐字 ✓）；`syncExternalChange` L367-393（dirty→stale=true L370-376、clean→静默 fsReadFile 重读 L378-391）；persist partialize 仅 `editorLayoutByProject` L534-536。
- `EditorPanel.tsx`：`EditorView` 具名导入 L2、`registerFindBarAccessor` L4、`editorFile` L47、`viewRef` L58（T5 订阅插入位 ✓）、accessor effect L70-73（T5 新 effect 插入位 ✓，均早于 L75 早退 ✓ hooks 顺序安全）、`onCreateEditor={(view) => { viewRef.current = view; }}` L143（old_string ✓）。
- `App.tsx` L65-69：onFsChanged → 过滤活跃项目 → `loadRoot` + `syncExternalChange(paths)` ✓；`fsWatchStart` 调用点 App.tsx:50 + ProjectSelector.tsx:97/158（切换项目亦起 watcher，替换写盘回火链对活跃项目成立）。
- `watcher.rs`：500ms debounce L73、emit `fs-changed` + `git-status-changed` L83-90、payload camelCase L32-37、**无自写过滤**（应用自身写盘必回火——计划「不抑制 watcher」裁定的前提属实）。
- `registry.ts`：`search.focus` L56-61，run `setSidePanelTab("search")` L60（T9 old_string ✓），`defaultKey k("keyf",{primary:true,shift:true})` L59 不动；`registry.test.ts:23` 断言 `primary+shift+keyf`（键位回归保护 ✓）。
- `KeybindingHost.tsx`：`ALLOW_IN_INPUT` 仅 editor.save/editor.close（L12），输入框焦点下 search.focus 让行（L51-52）；Ctrl+Alt+Enter 无注册命令不吞键；dialogOpen() 全让行 L49——面板本地快捷键零冲突声称属实。
- `registry.run.test.ts`：模块级 `let setEditorVisible` L8（T9 插入 requestSearchFocus 声明位 ✓）、ui.store mock L16-18（old_string 逐字 ✓）、beforeEach `setEditorVisible = vi.fn();` L36（插入位 ✓）。
- `ui.store.ts`：`settingsOpen: boolean;` L21、`closeSettings: () => void;` L32、初始 `settingsOpen: false,` L47、实现 L70（T9 四处插入位 ✓）；partialize 白名单 L75-83 不含 searchFocusRequest（天然不持久化 ✓）。
- `ui.settings.test.ts`：真实 store、无 docblock（node 环境，persist 对缺 localStorage 容错——既有文件现网可跑），尾部追加 describe 兼容。
- `package.json`：`radix-ui ^1.6.7` L36；node_modules 实证 `node_modules/radix-ui/dist/index.d.mts:5-6` `export { reactAlertDialog as AlertDialog }`（`AlertDialogPrimitive.Root/Trigger/Portal/Overlay/Content/Title/Description/Action/Cancel` 全部可用，与 dialog.tsx:3 `import { Dialog as DialogPrimitive } from "radix-ui"` 同构）；lucide `replace.mjs`/`chevrons-down-up.mjs`/`chevrons-up-down.mjs`/`loader-2.mjs` 均在 `dist/esm/icons/`。
- `dialog.tsx`：玻璃语言模板（L42 overlay `bg-black/20 backdrop-blur-[2px]`、L64 content `backdrop-blur-xl bg-background/90`）——T8 alert-dialog 镜像有据。
- `button.tsx`：`size "icon-xs"` L29、`buttonVariants` 导出 L64（AlertDialogAction/Cancel 引用 ✓）；`input.tsx` `React.ComponentProps<"input">`（React 19 ref-as-prop，`Input ref=` 合法）。
- `pathUtils.ts`：`relativeToProject` L13-29——`("/proj/src/a.ts","/proj") → "src/a.ts"`，T7 分组测试期望吻合。
- `vite.config.ts`：test `environment: "node"`、未开 globals、include `src/**/*.test.ts(x)` L27-30——计划 docblock 约定与文件落位合规。
- `globals.css` 233 行（尾部追加 ✓）；`--overlay-hover/ghost/active` L44-46+L113-115、`--warning` L64、`--error` L65 均定义；tsconfig.app.json:12-14 `@/* → ./src/*` 别名有效。
- `AgentComposer.tsx:12` import + `:115` `void fsSearch(project.path, atQuery)`——全仓 fsSearch 仅 3 消费点（store/面板/Composer），缺省参后向兼容声称属实。
- `SidePanel.tsx:16` `{sidePanelTab === "search" && <SearchPanel />}`——条件挂载（N2 依据）。

### ③ 类型一致性细目

- 命令名四处同步：`fs_search_replace`/`fs_apply_replace` 在 fs_cmds.rs（T2 Step 3）→ lib.rs invoke_handler（T2 Step 3）→ commands.ts 常量（T3 Step 1）→ tauri.ts `invoke(COMMANDS.…)`（T3 Step 2）逐字一致。
- Rust↔TS 结构体逐字对齐：`ReplaceFilePreview{path,count}`、`ReplacePreview{files,total,truncated}`、`ReplaceResult{filesChanged,replacements}`、`SearchOptions{caseSensitive,wholeWord,regex}`（serde camelCase ↔ TS 接口 ↔ store 测试断言三处同形）。
- store 契约链：T4 `previewReplace/applyReplace/clearReplacePreview/consumePendingLine/setSearchOptions/pendingLine/searchError` ↔ T5（consumePendingLine/pendingLine）↔ T6（searchOptions/searchError/setSearchOptions）↔ T7（openFile {line}）↔ T8（replacePreview/replacing/previewReplace/applyReplace）↔ T9（ui.store searchFocusRequest/requestSearchFocus → registry run → SearchPanel effect）无未定义符号。
- `openFile(filePath, opts?: boolean | OpenFileOptions)` 联合签名：loadEditorState `openFile(path, true)`（fs.store.ts:499）与 SearchPanel `openFile(m.path)` 两参/单参旧调用皆兼容；T4 回归测试指定跑 `fs.store.editor.test.ts`（其 L61 正是 `openFile("/p/a.ts", true)` 布尔形态先例）。
- T9 SearchPanel.test.tsx 的 fsState mock 仅补 previewReplace/applyReplace、未补 replacePreview/replacing——运行时选择器读到 `undefined` 安全（`disabled={replacing || …}`、`replacePreview?.…`），tsc 按真实模块类型检查 mock 不可见，无 TS 错误。

### ④ 测试可运行性细目（除 B1/B2/B3 外可通过）

- Rust：T1 其余 5 条用例（default/case/whole-word/combine/invalid）按 fixture 与 `(?i)`+escape+`\b(?:…)\b` 合成规则逐条推演皆绿；T2 全 7 条（预览不写盘/全量写/单文件 scope/limit=1/捕获组 `$2/$1`/200 预算截断/非法正则）推演皆绿——`find_iter().count()` 预算与 `replace_all` 闭包封顶共用 MAX_RESULTS，预览/写盘同序同预算一致；`fs_test.rs` 既有 `use std::fs;` + `tempdir()` 覆盖新增用例全部依赖，文件中段追加 `use nex_lib::fs::search::…` 为合法 item 级导入。
- 前端模式先例对齐：jsdom 文件第 1 行 docblock（registry.run.test.ts:1-3 先例）、`afterEach(() => cleanup())`、模块级可变 let + vi.mock 闭包延迟读取（registry.run.test.ts:8-24）、fs.store 测试的桥接 mock 工厂 + 模块级 vi.fn（fs.store.editor.test.ts:3-26）——T4/T5/T6/T7/T8/T9 测试文件全部同构；T4 桥接 mock 覆盖 fs.store.ts 改造后全部 9 个运行时导入符号（类型导入擦除不计）。
- searchHighlight.test.ts 为 node 环境纯函数（无需 docblock）；零长匹配 `re.lastIndex++` 终止 + 1000 次 guard，无效正则返回 null 的静默回落分支有用例（T7 Step 1 "returns null for an invalid regex"）。
- radix AlertDialog 在 jsdom：受控 `open` + Portal 挂 body 可行；动画类在 jsdom 无 computed animationName → Presence 同步卸载，cancel 用例 `queryByRole("alertdialog")` 为 null 成立。

### ⑤ 设计漏洞扫描细目

- **fs-changed 协同（核心裁定复核）**：apply_replace 经 write_file 写盘 → notify 无自写过滤（watcher.rs 全文无过滤逻辑）→ 500ms debounce → fs-changed(paths) → App.tsx:65-69 → syncExternalChange：dirty 页签仅置 stale=true 保留草稿（fs.store.ts:370-376），clean 页签静默重读且 `if (!f || f.dirty) return` 二次防护（L383）——**脏标签正确 stale、不静默覆盖用户未存输入**，与计划声称一致。
- **预览/写盘一致性**：二者同遍历序（replace_candidates 同一 WalkBuilder）、同 MAX_RESULTS 预算、同 per-file min(full, budget) 语义——「预览截断＝实际写入量」成立（文件系统中途变更除外，N4）。
- **limit_per_file 与预览**：预览仅用于「替换全部」（paths=null 无 limit），单文件/单条走直写不经过 dialog，计数口径无冲突。
- **searchFocusRequest 竞态**：计数自增在单 set 内（T9 Step 2 immer 原子），重复 Ctrl+Shift+F 仅累加；重复 Enter 为面板本地 state 游标，无全局交互。唯一边界见 N2。
- **ReDoS**：Rust `regex` crate 为有界自动机（线性时间保证），后端天然免疫；前端 `matchRanges` 仅作用于 ≤200 字符（MAX_LINE_LEN）行文本，`new RegExp` 预校验只编译不执行——攻击面可忽略（N3）。

---

## 发现列表

### Blocker ×3

**B1 — Task 1：`test_search_regex_mode` 命中数断言与 fixture 矛盾，必红**
- 位置：计划 L142-150（`search(dir.path(), r"(Foo|foo)\s*=\s*\d", Some(opts(false, false, true)))`，断言 `texts.len() == 1`）；fixture L103 `src/app.ts = "const Foo = 1;\nlet foo = 2;\nlet food = 3;\n"`。
- 实证：合成模式 `(?i)(Foo|foo)\s*=\s*\d` 对第 2 行 `"let foo = 2;"`：`foo` + `\s*`(空格) + `=` + `\s*`(空格) + `\d`(2) **同样命中**（第 3 行 `food` 因 `foo` 后紧跟 `d` 不命中）。实际内容命中 2 条。
- 失败场景：`cargo test --test fs_test` 在 T1 Step 5 即红（`assertion failed: texts.len() == 1`，左 2 右 1），TDD 跑绿步骤过不去。
- 建议：query 改 `r"Foo\s*=\s*\d"` 且 `opts(true, false, true)`（大小写敏感 → 仅第 1 行命中，保持「单命中」断言意图）；或把断言改为 2 并追加第 2 行校验。一行级修法。

**B2 — Task 6：「切开关触发重搜」测试用二次 `render()` 建第二组件根，断言必红**
- 位置：计划 L1550-1560（`fsState.searchOptions = {…}` 后 `render(<SearchPanel />)` 再推进 300ms，期望 `fsSearch` 被调）。
- 实证：T6 测试的 `useFsStore` 是裸函数 mock（计划 L1485-1490），无订阅通知机制；RTL 每次 `render()` 新建容器与 React root——实例 1 永不再渲染（deps 闭包持旧 searchOptions 对象），实例 2 挂载时自带 `query=""` 走 `clearSearch()` 分支不搜索。`mockClear()` 之后无任何实例调用 `search`。
- 失败场景：T6 Step 3 跑绿红：`expect(fsState.search).toHaveBeenCalled()` 失败。
- 建议：改 `const utils = render(<SearchPanel />); …; utils.rerender(<SearchPanel />);`——同一 root 重渲使 selector 读到新 fsState、deps 变更触发新防抖。两行级修法。

**B3 — Task 7：行点击测试 `getByText("const ")` 因 `<mark>` 切割文本必抛**
- 位置：计划 L2068-2072（`fireEvent.click(screen.getByText("const ").closest("button")!)`）；高亮实现 L2100-2116 将 `"const foo = 1;"` 切为 text(`"const "`) + `<mark>foo</mark>` + text(`" = 1;"`)。
- 实证：Testing Library `getByText` 默认取**直接文本节点拼接**（`getNodeText`）后归一化——外层 span 的直接文本为 `"const "` + `" = 1;"` → 归一化 `"const = 1;"`；查询串 `"const "` 归一化为 `"const"`，精确匹配失败（mark 内 `"foo"` 亦不匹配），无任何元素命中 → 抛 "Unable to find an element with the text"。
- 失败场景：T7 Step 5 跑绿红于该用例查询阶段。
- 建议：改经 mark 定位——`screen.getAllByText("foo")[0].closest("button")!`（三行各一个 "foo" mark，[0] 即第 1 行）；或函数匹配器 `(c, el) => el?.tagName === "SPAN" && el?.textContent === "const foo = 1;"`。一行级修法。

### Risk ×1

**R1 — Task 2/8：替换写盘与 autosave 定时器竞态，可静默回滚替换结果**
- 位置：`fs.store.ts:19-25`（scheduleAutoSave 1500ms 挂表）+ `saveFile` L340-365（仅校验 dirty，**不检查 stale**）；计划替换流 T8 经 write_file 写盘后经 watcher 置 stale（fs.store.ts:370-376）。
- 失败场景：用户对文件 A 有脏草稿（autosave 开启、定时器在途）→ 面板替换全部命中 A → 磁盘被替换 → 500ms 后 stale 黄条出现 → 但若 1500ms autosave 先于用户决策触发，`saveFile` 把**基于旧内容的草稿**写回磁盘，静默抹掉 A 上的替换结果（stale 标志甚至不会被 saveFile 清除，横幅残留但内容已回滚）。
- 说明：此为既有语义类（任何外部变更 + autosave 同此风险，git pull 场景亦存在），计划未加剧机制本身，但「应用自身成为外部写方」使触发概率显著上升，而计划冒烟 #3 仅覆盖无 autosave 路径。
- 建议：`saveFile` 入口加 `if (cur.stale) return false;`（stale 文件须先经「重新加载/保留」决策方可写盘）；或 T8 说明文案补一句 autosave 可能覆盖。一行级修法，建议随本计划一并处理。

### Note ×5

**N1 — Task 7/8：搜索按行计数、替换按出现次数计数，统计条与确认 dialog 数字可不一致**
- 位置：search() 每行 `is_match` 一次（计划 L300）；search_replace `find_iter(&content).count()`（L567）。
- 说明：同一行两次命中（如 `foo foo`）→ 统计条「1 个结果」而确认 dialog「共 2 处」。预览↔写盘一致性不受影响（二者同为次数口径），属语义展示差异，VSCode 亦区分两口径。可接受；如需一致可让统计条展示命中次数。

**N2 — Task 9：陈旧 searchFocusRequest > 0 导致面板每次重挂载抢焦点**
- 位置：计划 L2979-2981 `useEffect(() => { if (searchFocusRequest > 0) inputRef.current?.focus(); }, [searchFocusRequest])`；SidePanel.tsx:16 条件渲染（切 files/git 页签即卸载 SearchPanel）。
- 说明：会话内用过一次 Ctrl+Shift+F 后计数恒 > 0 且不持久化——此后每次鼠标点回搜索页签，挂载 effect 即以陈旧计数聚焦输入框。「挂载不抢焦点」仅对计数 0 成立。影响轻微（聚焦搜索框多数情况合意），可加「仅当计数变化时聚焦」的 ref 前值比较规避。

**N3 — Task 1：ReDoS 顾虑可降级——regex crate 为线性时间有界自动机**
- 说明：计划/控制器列「用户正则无超时 v1 可接受」为风险项；实证 Rust `regex` crate 不做回溯（NFA/DFA 模拟），后端结构性免疫 ReDoS。前端 `new RegExp` 预校验仅编译不执行，`matchRanges` 执行面限于 ≤200 字符行文本。该条可从风险清单移除，仅留档。

**N4 — Task 8：预览→确认之间文件改动导致 dialog 数字与写盘结果漂移**
- 说明：dialog 的 files/total 为快照；用户编辑、autosave、外部进程在预览后确认前改动文件，apply 结果可与 dialog 不符（写盘为权威，结果经自动重搜刷新）。v1 信息性提示可接受，无需改。

**N5 — Task 6：JS/Rust 正则方言差异为双向关卡，Rust 合法 / JS 非法模式被前端拦死**
- 位置：计划 L1687-1695 `regexError` 预校验 + L1458 接口说明。
- 说明：计划已声明「后端恒为匹配权威」并接受极少数分歧；补充具体形态——如 `(?i)foo`（JS 无内联 flag）、JS 不支持的 Rust 语法会被面板判为「无效的正则表达式」且永不发往后端（假阴性方向）；反向（JS 合法 / Rust 拒绝）经 searchError 行内呈现已覆盖。属已裁定的 UX 取舍，记录备查。

---

## 结论

Plan 5 在**架构、锚点、类型链、Rust/前端语义**层面高度成立：11 任务的锚点与磁盘逐字吻合（含 fs.store openFile 三出口的缩进级 old_string、radix-ui 统一包 AlertDialog 导出、watcher 无自写过滤这一「不抑制」裁定的前提），fs-changed 脏/净同步链经核实与计划声称完全一致，四处命令同步链与 camelCase 契约无缝。**不可直接执行**——3 个 Blocker 全部是测试断言/测试手法缺陷（非实现缺陷）：B1 Rust 正则用例命中数算错（fixture 第 2 行也命中）、B2 二次 render() 误用（应 rerender）、B3 getByText 跨 `<mark>` 取文本必抛。三者均为一行级修法。修完 B1-B3 后建议一并处理 R1（saveFile 对 stale 加守卫）再进入执行。
