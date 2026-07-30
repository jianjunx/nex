# Plan 3 Task 11-14 实现层核验（执行前设计关卡）

**日期**：2026-07-31
**核验对象**：`docs/superpowers/plans/2026-07-31-plan3-git-panel-rich.md` L3250-4680（Task 11 ChangesSection / Task 12 GitActionsMenu+OpLogPanel / Task 13 HistorySection / Task 14 门槛+冒烟）。交叉引用比对基准：Task 6 段 L1539-1711、Task 7 段 L1712-2247、Task 8-10 段 L2248-3249（后者为锚链与测试基线所需）。
**方法**：计划代码 × 磁盘真实源码逐字核对；Radix 行为以 pnpm store 内精确解析版本（radix-ui 1.6.7 → @radix-ui/react-dropdown-menu 2.1.24 / react-menu 2.1.24）dist 源码为权威实证；lucide-react 1.26.0 图标以 `require('lucide-react')` 实测导出；测试基线亲自计数。只读，未改任何文件、未做 git 操作。
**分级**：Blocker（执行必挂）／Risk（能跑但有隐患）／Note（可接受但应知会）。

---

## 维度结论

| # | 维度 | 结论 | 说明 |
|---|------|------|------|
| ① | 组件/依赖真实性 | **失败** | B1：`@/components/ui/scroll-area` 仓库不存在、计划无任何任务创建，T12 OpLogPanel 的 import 解析失败 → build 挂。其余全部实证存在且 API 用法正确（见细目）。 |
| ② | 交叉引用真实性 | **通过** | 消费的 T7 store 动作/字段逐条命中且签名一致；T6 桥接/类型命中；GitFileChange 字段与磁盘逐字吻合；fs.store openFile、dialog 目录选择模式均与磁盘先例一致。零未定义符号。 |
| ③ | 锚点真实性 | **通过** | GitPanel 改造链 T7→T9→T10→T11→T12→T13 逐环自洽；磁盘现状锚点（File lists 块、Commit area、Diff viewer、解构行）与计划描述逐字吻合；T14 的 34 文件集合实测等于各任务 Files 并集。 |
| ④ | 测试可运行性 | **失败** | B2/B3：T12 `GitActionsMenu.test.tsx` 4 个用例全红（Trigger 以 pointerdown 开启、MenuItem 选中即关根菜单）。基线 108 ✓ 实测、新增 44 ✓ 逐块计数、152 算术成立；docblock/cleanup/mock 模式合规。 |
| ⑤ | 设计漏洞扫描 | **通过（带 Risk）** | 无 Blocker；3 个 Risk（R1 跨项目历史串显、R2 stash 选中索引漂移、R3 属 T10 的连带测试问题）+ 6 个 Note。冒烟清单逐条覆盖 spec 验收 Git 全部条目。 |

### ① 组件/依赖真实性细目（除 B1 外全部通过）

- `ui/dropdown-menu`（`src/components/ui/dropdown-menu.tsx`）：T12 导入的 10 个符号**全部真实导出**（L239-255）——`DropdownMenuSub`(L193)/`DropdownMenuSubTrigger`(L199)/`DropdownMenuSubContent`(L223)/`DropdownMenuCheckboxItem`(L83, checked+onCheckedChange 透传)/`DropdownMenuLabel`(L144)/`DropdownMenuItem`（含 `variant="destructive"` L63）/`DropdownMenuTrigger`（asChild ✓）/`DropdownMenuContent`（align ✓）。这是最易踩空处，实测无虞。
- `ui/dialog`：`Dialog/DialogContent/DialogDescription/DialogFooter/DialogHeader/DialogTitle` 全导出（dialog.tsx L147-158），`showCloseButton` 支持（L53）——GitConfirmDialog（T9）依赖项 ✓。
- `ui/button`：`variant="ghost"`（L19）与 `size="icon-xs"`（L29）真实存在 ✓；`ui/input` 透明转发原生 props（autoFocus/onKeyDown ✓）。
- **`ui/scroll-area` 不存在**：`src/components/ui/` 仅有 button/card/dialog/dropdown-menu/input/label/radio-group/slider/switch/tabs/textarea 共 11 个文件；全仓 src 零处引用 ScrollArea；计划全文 grep 仅 T12 三处消费（L3859 声称「勘察实录确认」、L4015 import、L4286/4293 使用），无任何 Create 步骤 → **B1**。
- lucide-react ^1.26.0：T11-13 用到的 18 个图标（MoreHorizontal、Loader2、FolderTree、FileDiff、Trash2、Undo2、RefreshCw、GitBranch、ChevronRight/Down、Check、File、Folder、List、Minus、Plus 等）**实测全部导出**（node 直接 require 判定，含 1.x 保留的旧名别名）。
- 未引用 `alert-dialog`/`popover`（仓库不存在）✓；`@tauri-apps/plugin-dialog` ^2.7.2、`@tauri-apps/api` ^2.11.1 均在 devDeps ✓。

### ② 交叉引用真实性细目（全部命中）

- **T7 store（计划 L1896-2215 全量代码为基准）**：T11 消费的 `status/statusLoading/opRunning/treeView/setTreeView/stage/unstage/discard(→Promise<boolean> L1955)/revertStaged(L1956)/viewDiff` 全在接口 L1916-1963；T12 消费的 `opLog/opLogOpen/setOpLogOpen/clearLog/stashes/loadStashes/fetch/pull/push/clone/stashApply/stashPop/stashDrop/stashSave` 全命中；T13 消费的 `commits/historyLoading/historyOpen/setHistoryOpen/loadHistory/openCommitDiff` 全命中，且 `loadHistory` 实现体（L2184-2194）确含 `gitLog(projectPath, 20)`/historyLoading 门控/失败写共享 `error`——T13「store 零改动、纯消费」成立。
- **opRunning 中文字面**：T12 清单「拉取/推送/获取/克隆/存储/应用存储/弹出存储/删除存储」与 T7 runOp 名（L2107/2112/2123/2128/2143/2152/2158/2167）**逐字一致** ✓；spinner 匹配不会踏空。
- **T6 桥接**：`gitLog` 定义于计划 L1620-1622（T13 自述「L1620 已核实」属实）；`StashEntry{index,message}`（L1608）/`CommitInfo{hash,message,author,time}`（L1613）/`gitStashSave(projectPath, message: string)`（L1648）与 T12 扩展 `stashSave(projectPath, message?)`→`gitStashSave(projectPath, message ?? "")`（T12 Step 3 锚点与 T7 原实现 L1951/L2142-2143 逐字吻合）一致。
- **GitFileChange**：磁盘 `src/bridge/tauri.ts` L206-210 实测 `{ path; status: "modified"|"added"|"deleted"|"untracked"; staged }`，与计划 L3259 逐字一致；`GitStatus` L212-217 同证。
- **fs.store openFile**：磁盘 L162 实测 `openFile: async (filePath: string, pin = false)`，计划单参调用 `useFsStore.getState().openFile(absPath)` ✓；绝对路径组件内拼接、Windows 接受 `/` 的注释成立。
- **dialog 目录选择**：计划 L4064-4068 与磁盘 `ProjectSelector.tsx` L84-86 逐步一致（`getCurrentWindow().setFocus().catch(() => {})` → `open({ directory: true, multiple: false, title })` → `typeof selected === "string"`）；导入路径 `@tauri-apps/plugin-dialog` / `@tauri-apps/api/window`（ProjectSelector L2-3）与 T12 测试 mock 路径逐字一致。
- **GitConfirmDialog（T9 L2643-2651）**：T11（L3794-3812）与 T12（L4241-4253）使用的 props `open/title/description/confirmLabel/busy?/onConfirm/onCancel` 与 T9 定义完全匹配。
- 其他锚点：`commands.ts:30 GIT_LOG` 实测存在 ✓；`events.ts` L9 `FS_CHANGED`、L24-26 `GitStatusChangedPayload` ✓；`App.tsx` L99-100 KeybindingHost/SettingsDialog ✓；`tauri.ts` gitCommit L235-237 与 `// --- Terminal ---` L239 ✓。

### ③ 锚点真实性细目（GitPanel 改造链全链自洽）

核对口径＝T11-14 对「T9/T10 改后形态」的引用是否与 T9/T10 的产出描述自洽（兼对磁盘现状做根源核对）：

- 磁盘 GitPanel 现状：L9 解构含 `loading` ✓、L21-26 handleCommit ✓、L28-39 handleStage/handleUnstage + staged/unstaged 派生 ✓、L52-87 `{/* File lists */}` + `flex-1 overflow-y-auto px-4 py-3` 块 ✓、L86 错误行（T9 Step 6.5 移除）✓、L89 Commit area ✓、L108 Diff viewer ✓、L101 `disabled={loading || !commitMsg.trim()}` ✓（与 t1-8 报告 N2 口径一致）。
- T11 Step 5 对「T10 后形态」的引用：lucide 去 Plus/Minus 后剩 `GitBranch, ChevronDown, RefreshCw`——与 T10 Step 9.1 的产出 `GitBranch, Plus, Minus, ChevronDown, RefreshCw` 衔接 ✓；解构行去 viewDiff/stage/unstage 后 L3822 与 T10 Step 9.2 的 L3230 逐字衔接 ✓；File lists 整块替换边界清晰 ✓。
- T12 Step 6 对「T11 后形态」的引用：刷新按钮（T9 L2888-2900 `title="刷新" size="icon-xs"`）之后挂 GitActionsMenu ✓；Diff viewer 之后、BranchSelector（T9 Step 6.6 挂载）之前挂 OpLogPanel ✓。
- T13 Step 6 对「T12 后形态」的引用：HistorySection 插于 Diff viewer 与 OpLogPanel 之间，最终布局 L4543 描述与三步插入序列自洽 ✓。
- T14 Step 3 的 34 文件集合：逐任务 Files 段去重并集**实测等于 34**（Rust 8 + bridge 4 + commands 5 + git features 15 + stores 2），无集合外、无缺项 ✓。

### ④ 测试可运行性细目（除 B2/B3 外可通过）

- **基线与算术（亲自计数）**：磁盘现有 21 个测试文件 `it(/test(` 逐行计数 **TOTAL=108**（无 skip/todo/each）✓；计划新增逐代码块计数：T7=9（2+3+3+1）、T8=6、T9=4、T10=4+3+2=9、T11=6、T12=4、T13=2+4=6，合计 **44** ✓；108+44=**152** ✓，与计划 L4572 逐文件分布描述一致（T13 Step 5「store 11 例」=9+2 ✓）。
- **B2 实证**：`@radix-ui/react-dropdown-menu` 2.1.24（radix-ui 1.6.7 的解析版本）dist `index.mjs` L77——`DropdownMenuTrigger` 仅挂 `onPointerDown`（+ L83 onKeyDown），**无 onClick**；jsdom `fireEvent.click` 只派发 click → 菜单不开 → `openMenu()` 的 `findByText("拉取")` 超时，T12 全部 4 用例红。
- **B3 实证**：`@radix-ui/react-menu` 2.1.24 dist `index.mjs` L378-397——`MenuItem.onClick = composeEventHandlers(props.onClick, handleSelect)`；handleSelect 派发 ITEM_SELECT 后若**未 preventDefault 即 `rootContext.onClose()`**。T12 存储条目项 `onSelect={() => setSelectedStash(s.index)}` 无 preventDefault → 点选条目即关闭整个根菜单、SubContent 卸载 → 测试 L3960 `getByTestId("stash-drop")` 抛错。（SubTrigger 不受影响：react-menu L650-655 确有 onClick 开子菜单 ✓，且计划自带 onClick 兜底 ✓。）
- 合规项：三个新 jsdom 测试 docblock 均在第 1 行（L3274/3868/4368）、`afterEach(() => cleanup())` 齐备（L3329/3921/4402）；`let gitState` + mock 工厂**延迟读取**模式与磁盘先例同构（`registry.run.test.ts` L6-7 明确注释 "mock factories read them lazily (TDZ-safe)"、`KeybindingHost.test.tsx` L9-32 同款）；T11 `const openFileMock` 经双层闭包延迟读取，无 TDZ 风险；mock 路径全部正确；T13 store 用例追加于 T7 所建文件、复用既有 `gitLogMock`（T7 L1736/1759）✓。
- 断言可行性抽查：T11「更改 (2)」跨文本节点匹配走元素 textContent ✓；确认按钮 `getByRole("button", { name: "丢弃" })` 精确匹配仅命中 dialog（行按钮可及名为 title「丢弃更改」）✓；T13「1 小时前」＝delta 恰为 3600s 落 `delta < 86400` 分支 ✓ 无时序脆性；T12 `data-disabled`/`svg.animate-spin` 断言与 Radix/lucide 渲染产物一致 ✓。

### ⑤ 设计漏洞扫描细目

- **树形/平面切换状态保持**：组级 `collapsed`（FileGroup 本地态）切换不卸载、保持 ✓；`ChangeTreeView` 的目录折叠 Set 随视图切换卸载重置（回树视图全展开）——Note 级。
- **discard 刷新链**：确认 → `discard/revertStaged`（T7 成功后 `refresh`，L2172-2182）→ 列表刷新 ✓ 链完整。
- **··· 菜单 opRunning 禁用闭包**：`opRunning` 走 selector 重渲染、动作引用 zustand 稳定，无陈旧态 ✓；进行中项 spinner 不禁用自身 + 其余网络项禁用 + store runOp 重入守卫兜底 ✓。
- **stash 空列表防御**：「暂无存储条目」disabled 占位（L4143）+ 三项 `selectedStash === null` 禁用 ✓；缺陷在**选中索引漂移**（R2）。
- **loadHistory 失败回显**：写共享 `error` → T9 头部下方错误条 ✓；store 用例（T13 L4355-4361）覆盖 ✓。
- **spec 验收逐条对照**（`specs/2026-07-30-vscode-ux-alignment-design.md` L158 Git 条 + F2 L61-69）：可提交（冒烟 11-13）/切建删分支（1-4）/pull·push·fetch·clone（14-17）/stash（18-20）/丢弃·撤销暂存（8-9）/树视图（10）/历史（25-26）/凭据弹窗+记住同 host 不再弹（21-22）/错误可读（15-16、24）**全覆盖** ✓；diff 条（L159）属 Plan 4，冒烟 26 明示占位 ✓。

---

## 发现列表

### Blocker ×3

**B1 — Task 12：`@/components/ui/scroll-area` 不存在，计划无任何任务创建**
- 位置：计划 L4015（`import { ScrollArea } from "@/components/ui/scroll-area"`）、L4286-4293（OpLogPanel 使用）；L3859 声称「勘察实录确认已玻璃化…直接用」与事实不符。
- 实证：`src/components/ui/` 实测 11 个文件无 scroll-area；全仓 src 零引用；计划全文仅 T12 三处消费、零处 Create。
- 失败场景：`pnpm build`（tsc）TS2307 模块不可解析，T12 门槛即挂；OpLogPanel 亦无法渲染。
- 建议：T12 增一 Step 新建 `scroll-area.tsx`（radix-ui 包含 ScrollArea 原语，已安装，照 shadcn 模板玻璃化），或 OpLogPanel 改 `<div className="max-h-40 overflow-y-auto">`（一行替代，免新组件）。

**B2 — Task 12 测试：DropdownMenuTrigger 以 pointerdown 开启，`fireEvent.click` 打不开菜单**
- 位置：计划 L3925（`openMenu` 内 `fireEvent.click(screen.getByTitle("更多操作"))`），为 4 个用例共用入口。
- 实证：react-dropdown-menu 2.1.24（radix-ui ^1.6.7 解析版本）`dist/index.mjs` L77——Trigger 仅 `onPointerDown`/`onKeyDown` 开启，无 onClick；jsdom click 不派发 pointerdown。
- 失败场景：`findByText("拉取")` 超时 → GitActionsMenu.test.tsx **4/4 红**，T12 Step 5「跑出绿」不成立。
- 建议：`openMenu` 改用 `fireEvent.pointerDown(screen.getByTitle("更多操作"))`（项目无 user-event，fireEvent 即可）。

**B3 — Task 12 测试＋UX：点选 stash 条目未 preventDefault，Radix 立即关闭整个根菜单**
- 位置：计划 L4136（条目项 `onSelect={() => setSelectedStash(s.index)}`）；测试 L3959-3960 连续点击 stash-0 → stash-drop。
- 实证：react-menu 2.1.24 `dist/index.mjs` L378-397——MenuItem 选中事件未 `preventDefault` 即 `rootContext.onClose()`，根菜单连带 SubContent 一并卸载。
- 失败场景：测试第 4 例 `getByTestId("stash-drop")` 抛错（元素已卸载）；真实使用 likewise——选中条目后菜单消失须重开，且打断「选中→弹出/应用/删除」动线。
- 建议：条目项改 `onSelect={(e) => { e.preventDefault(); setSelectedStash(s.index); }}`（Radix 约定：preventDefault 保持菜单开启），一行同时修复测试与 UX。

### Risk ×3

**R1 — Task 13：跨项目切换时历史区串显旧项目提交**
- 位置：计划 L4476-4478（`if (commits.length === 0) void loadHistory(projectPath)`）与 L4339 自述「项目切换经 projectPath 重触发」。
- 失败场景：`commits` 是全局 store 字段、项目切换不清空；项目 A 加载过历史后切到 B → effect 虽因 projectPath 变化重跑，但 `commits.length > 0` 条件挡掉加载 → 面板显示 A 的提交；点击条目 → `openCommitDiff(B路径, A的hash)` → 错误条。多项目用户必现。
- 建议：effect 改为 projectPath 变化即加载（`const prev = useRef(projectPath); if (commits.length === 0 || prev.current !== projectPath) loadHistory(...)`），或 T7 refresh 链在项目切换时重置 commits；另建议 T14 冒烟补一条双项目切换（见 N6）。

**R2 — Task 12：stash 选中索引在 pop/drop 后漂移**
- 位置：计划 L4057-4060（仅 `selectedStash === null` 时自动选首项）+ L4145-4170（三按钮禁用条件 `selectedStash === null || busy`）。
- 失败场景：git stash 条目索引在 pop/drop 后整体前移；选中 index=1 弹出后，selectedStash=1 可能指向另一条目或越界 → 「弹出/应用」把无效索引送后端（错误条兜底）、「删除」因 `stashes.find` 返回 undefined 而静默无响应。
- 建议：pop/drop 成功（store 返回 true）后 `setSelectedStash(null)` 令自动选首项逻辑接管，或按刷新后列表 clamp。

**R3 — （连带发现，属 T10 范围，影响 T14 的 152 门槛）CommitSection 测试同款 Trigger 问题**
- 位置：计划 L2993（`fireEvent.click(screen.getByTitle("更多提交方式"))`）。
- 说明：与 B2 同机制，该用例（T10 第 3 例）同样会红 → 152 全过前提少 1。归属 t9-10 核验，此处仅备档交接；修法同 B2（pointerDown）。

### Note ×6

**N1 — Task 11：树视图目录折叠态在列表↔树切换时重置**（ChangeTreeView 卸载，本地 `collapsed: Set` 丢失；组级折叠保持）。v1 可接受。

**N2 — Task 13：`openCommitDiff` 占位转发 `viewDiff(projectPath, "", false)`**，空路径进后端 `git_diff` 行为未定义（可能闪错误条）。属 T7 占位语义、Plan 4 正式实现，计划注释已标明替换点。

**N3 — Task 14 门槛的跨任务依赖**：Step 1「152 全过」与 Step 2「git_test 全绿」以 t1-8 报告 B1-B4（错误消息映射 ×2、`mut` 绑定 ×5、类型 re-export ×1）先修为前提；建议 T14 文案注明依赖。

**N4 — spec F2 偏差（Plan 级决策，非实现缺陷）**：spec L64 的「以树形式查看」在 ··· 菜单内、且列有 提交/更改/分支/远程/标记 子菜单；计划将树切换挪到更改区右上角、v1 仅做 stash 子菜单。功能条目本身被冒烟覆盖，记录备查。

**N5 — Task 12：SubTrigger 的 onClick 兜底路径只 setStashSubOpen(true)、不调 loadStashes**；加载实际由 Radix 内部 `onOpenChange(true)` 路径触发（实测点击时两路俱发）。耦合冗余，建议 onClick 去掉或补 loadStashes 二选一。

**N6 — Task 14 冒烟清单未覆盖多项目切换**（R1 的触发场景）；单仓库预备下清单单跑全绿不能暴露 R1。

---

## 结论

Task 11-14 在**交叉引用、锚点链、类型契约、spec 覆盖**四个层面全部成立——T7 store 契约被逐字正确消费，GitPanel 六任改造链环环自洽，152 测试基线算术经亲自计数无误（108 实测 + 44 逐块计数）。但**不可直接执行**：3 个 Blocker 集中在 Task 12——`scroll-area` 组件缺失（build 挂）、菜单 Trigger 测试触发方式错误（4/4 红）、stash 条目选中未 preventDefault（第 4 例红 + UX 断点）。三者修法均为一步级（新建/替换一个滚动容器组件、`pointerDown` 替换 `click`、一行 `e.preventDefault()`）。建议修完 B1-B3 与 R1（历史串显，多项目必现）后再进入执行；R2/R3 可与对应任务一并处理。
