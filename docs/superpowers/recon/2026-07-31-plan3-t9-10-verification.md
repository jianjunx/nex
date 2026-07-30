# Plan 3 Task 9-10 实现层核验（执行前设计关卡）

**日期**：2026-07-31
**核验对象**：`docs/superpowers/plans/2026-07-31-plan3-git-panel-rich.md` L2540-3248（Task 9-10，哨兵 `<!-- PLAN-CONTINUES -->` L3249 之前；Task 11-14 不在范围）
**方法**：计划锚点 × 磁盘源码逐字核对；radix-ui / lucide-react / jsdom / vitest 行为以本机 node_modules 实际发行物为权威实证（react-dropdown-menu 2.x、react-menu 2.1.24、react-popper、lucide-react 1.26.0、jsdom 30、vitest 4.1.10）；既有命令测试套件实跑确认绿基线（6 文件 / 41 用例全过）；只读，未改任何仓库文件、未做 git 操作。
**分级**：Blocker（按字面执行必挂）／Risk（能跑但有真实缺陷）／Note（可接受但应知会）。
**先例**：T1-8 核验报告（`2026-07-31-plan3-t1-8-verification.md`）的分级与证据体例；其 B1-B4/R1-R2/N2 已由控制器修入计划，本次未复查 Task 1-8，但 Task 9-10 消费的 T7 契约已与计划 T7 段（L1712-2246）逐字交叉核对。

**锚点基准说明**：Task 9-10 的修改锚点是相对于「T1-8 执行后」的状态。磁盘当前为预执行态，故凡 T7 会改动的锚点（GitPanel 解构行、handleCommit、disabled 行），均与计划 T7 段给出的目标形态（L2221-2235）核对一致性；T7 不触碰的锚点（头部块、错误行、提交区块）直接与磁盘核对。

---

## 维度结论

| # | 维度 | 结论 | 说明 |
|---|------|------|------|
| ① | 组件/依赖真实性 | **通过** | 引用的 4 个 ui 组件全部存在且用法正确；8 个 lucide 图标全部存在（Loader2 为别名导出）；radix 原语经 ui 封装的用法与实现逐字吻合。 |
| ② | 锚点真实性 | **通过** | 全部锚点吻合（含相对 T7 目标态的 3 处）。 |
| ③ | 命令注册链路完整性 | **通过** | registry → keybindings.store resolve 回退 → host 分发（allowlist 之后求值 when）→ Input 属性透传的 when 标志，闭环完整可执行；`when` 是函数类型而非表达式字符串（host 无解析器），计划用函数形式，契约吻合。 |
| ④ | 类型/引用一致性 | **通过** | 消费的 17 个 store 字段/动作与 T7 契约逐字一致；BranchInfo 五字段三处对齐；GitConfirmDialog props 契约清楚；tsc `noUnusedLocals` 逐项过。 |
| ⑤ | 测试可运行性 | **失败** | B1：CommitSection 下拉用例 `fireEvent.click` 打不开 radix DropdownMenu（Trigger 只认 onPointerDown），Step 3「全过」不可达。其余全部用例逐一推演可过。 |
| ⑥ | 设计漏洞扫描 | **通过** | 无 Blocker；2 Risk、5 Note。Ctrl+Enter 冲突与双触发经实现级推演均安全。 |

---

## 维度细目

### ① 组件/依赖真实性（通过）

- `ls src/components/ui/`：button / card / dialog / dropdown-menu / input / label / radio-group / slider / switch / tabs / textarea。**无 alert-dialog、无 popover**——计划未引用（T9 L2549 明确「仓库无 `components/ui/alert-dialog`，A6 裁定不新增依赖」，改以 ui/dialog 手搓 GitConfirmDialog）✓。
- `ui/dialog`：`DialogContent` 支持 `showCloseButton?: boolean`（`src/components/ui/dialog.tsx:50-57`，GitConfirmDialog 传 `showCloseButton={false}` ✓）；`Dialog` 透传 Root props → `open`/`onOpenChange` 可用（dialog.tsx:8-12）；`DialogHeader/Title/Description/Footer` 导出齐全（dialog.tsx:147-158）。
- `ui/dropdown-menu`：`DropdownMenu/Trigger/Content/Item` 四件套导出（dropdown-menu.tsx:239-255）；`DropdownMenuTrigger` 支持 `asChild`（包 Button 的用法 ✓，计划 L3061）；`DropdownMenuItem` 支持 `onSelect`（radix 原语透传 ✓）。
- `ui/button`：variant `destructive/outline/ghost` 齐（button.tsx:11-22）；size `xs/icon-xs/sm` 齐（button.tsx:23-32）——T9 头部的 `size="xs"`、`size="icon-xs"` 与 GitConfirmDialog 的 `variant="destructive"/"outline"` 全部合法。
- `ui/input`：`function Input({ className, type, ...props })` 全透传到 `<input>`（input.tsx:5-18）→ `data-scm-commit-input`、`onKeyDown`、`autoFocus`、`placeholder` 均落到 DOM ✓（这是 ③ 的 when 标志机制的地基）。
- lucide-react **1.26.0**（node_modules/lucide-react/package.json）：`Check/GitBranch/Plus/Trash2/ChevronDown/RefreshCw/Minus` 均有独立声明；`Loader2` 无独立声明但**以别名导出**——d.ts 导出行含 `LoaderCircle as Loader2, LoaderCircle as Loader2Icon`（lucide-react.d.ts L26300）→ `import { Loader2 } from "lucide-react"` 编译通过 ✓（1.x 大版本只删了部分弃用别名，Loader2 保留为 LoaderCircle 别名）。
- radix 行为实证（node_modules/.pnpm 实物）：DropdownMenuTrigger **只在 `onPointerDown`（button===0 && !ctrlKey）与 `onKeyDown`（Enter/Space/ArrowDown）开合，无 onClick 回退**（@radix-ui/react-dropdown-menu dist L77-90）；MenuItem **选择走 `onClick → handleSelect`**（@radix-ui/react-menu 2.1.24 dist L397）——后者保证 `fireEvent.click(item)` 选中可行，前者是 B1 的根因。

### ② 锚点真实性（通过，全部吻合）

**GitPanel.tsx**（磁盘预执行态 + T7 目标态）：
- 头部块 `{/* Header */}` 起于 L43，flex 容器（`GitBranch size={14}` 所在）L44-50——T7 不改头部（T7 Step 5 只动 L9/L21-26/L58/L74/L101），T9 Step 6.4「整体替换」锚点对 T9 执行时刻仍然逐字成立 ✓。
- 错误行 L86 `{error && <p className="text-[var(--error)] text-xs px-2 mt-2">{error}</p>}` 与 T9 Step 6.5 old_string 逐字一致 ✓。
- `const [commitMsg, setCommitMsg] = useState("");` L13——T9 Step 6.3「下方追加 branchSelectorOpen」✓；T10 Step 9.3 删除锚点 ✓。
- 提交区 `{/* Commit area */}` L89 起至闭合 `</div>` L106——T9 不改，T10 Step 9.4 整块替换锚点成立 ✓。
- 最外层容器闭合 `</div>` L125，Diff viewer 块 L108-124——T9 Step 6.6「Diff viewer 块之后、容器闭合之前挂载 BranchSelector」位置无歧义 ✓。
- 解构行：磁盘 L9 为 `loading` 版；T7 Step 5.1 目标行（计划 L2221）为 `{ status, diff, diffFile, statusLoading, opRunning, error, refresh, viewDiff, stage, unstage, commit }`；T9 Step 6.2 目标行在其上追加 `loadBranches, loadStashes`（计划 L2867）——与 T7 目标态**一致** ✓（注：文案说「追加三个动作」，实为两个，见 N1）。
- handleCommit：T7 Step 5.2 目标形态（计划 L2225-2232，`const ok = await commit(...)`）与 T10 Step 9.3「删除（T7 版本）」描述一致 ✓。

**registry.ts**：
- `workbench.newConversation` 空实现占位 L85-95（run 体为 `/* wired in Plan 6 */`）与计划背景逐字吻合 ✓。
- 无 `register()` API——`const COMMANDS: Command[] = [...]` 静态数组（registry.ts:13）+ `BY_ID` Map（L98）；计划 Step 4.2「在 COMMANDS 数组 scm.focus 条目之后插入」是对数组的直接编辑，与结构吻合 ✓（scm.focus 条目 L62-68，插入位其后、files.focus 之前）。
- `k()` 助手 L7-10 签名 `(key: string, o: { primary?; alt?; shift? })` → `k("enter", { primary: true })` 合法 ✓；`getCommand/listCommands` 导出 L100-106 ✓。

**KeybindingHost.tsx**：
- `ALLOW_IN_INPUT` L12 现为 `new Set(["editor.save", "editor.close"])`——T10 Step 5 给出的整行替换（追加 `"scm.commit"`）逐字吻合、行号正确 ✓。
- when 求值时机：`allowBypass` 计算 L51 → `inInput` 门 L52 → `if (cmd.when && !cmd.when()) continue;` **L53**——「when 求值在 allowlist 之后」✓ 与 L51-53 附近预期完全一致。
- 捕获阶段 + 拦截：`window.addEventListener("keydown", onKeyDown, true)` L60；命中后 `preventDefault()` L54 + `stopImmediatePropagation()` L55 ✓（计划 L2940 的双触发论证所依赖的两点均属实）。
- `dialogOpen()` 检查 `[role="dialog"], [role="alertdialog"]`（L20-22），`if (dlg) continue` L49——模态对话框打开时全局键位全让行（见 ⑥ 分析，对 scm.commit 是增强而非缺陷）。

**keybindings.store.ts / ui.store**：T9-10 不改动。`resolve(id)` 回退 `getCommand(commandId)?.defaultKey`（keybindings.store.ts:48-52）→ scm.commit 默认键位自动进入 host 分发、`conflictsFor` 冲突检测（L54-63）与键位编辑器列表（`listCommands`），无需额外接线 ✓。

**git.store.ts**：磁盘预执行态与 T1-8 报告核验的基线一致（T7 全量重写）。T9-10 只消费 T7 输出契约，见 ④。

### ③ 命令注册链路完整性（通过）

- **注册**：`scm.commit` 条目形状 `{ id, title, category, defaultKey, when, run }` 与 `Command` 接口逐字匹配（`src/commands/types.ts:11-19`）。`when?: () => boolean`——**host 没有 when 字符串表达式解析器**，L53 直接函数调用；计划采用函数形式（`when: () => !!document.activeElement?.closest("[data-scm-commit-input]")`），契约吻合（用户维度 3 中「when 解析器逐字匹配」的前提不成立，实际是函数契约匹配，计划无误）。
- **键位 token 链**：`k("enter", { primary: true })` → `comboToCanonical`（types.ts:30-36，修饰键序 primary→alt→shift、key 小写）→ `"primary+enter"`，与 registry.test 断言（计划 L3123）逐字一致 ✓；事件侧 `normalizeKeyToken("Enter","Enter")`：code 不匹配 `^Key[A-Z]$`/`^Digit[0-9]$` → `key.toLowerCase()` = `"enter"`（types.ts:51-55）→ `eventToLogicalCombo`（ctrlKey→primary，jsdom `navigator.platform=""` → platform "other"，types.ts:21-26/61-73）→ canonical `"primary+enter"` ✓ 两侧归一化吻合。`labelKey` 还有 `"enter"→"↵"` 的展示映射（types.ts:78），键位编辑器显示无碍 ✓。
- **唯一性**：现有 9 条种子命令无 `primary+enter`（registry.test.ts:19-28 断言列表 + registry.ts:13-96 全表）→ 严格唯一性用例（registry.test.ts:30-39）保持通过 ✓。
- **host 分发**：`resolve` 回退 defaultKey（keybindings.store.ts:51）→ 新命令零接线进入分发循环（KeybindingHost.tsx:47-48）；`dlg` 门（L49）→ 模态打开时让行（CommitSection 不在对话框内，正常场景不受影响；BranchSelector 打开时抑制 Ctrl+Enter，属期望行为）；allowBypass：`isTypingKey("enter")` = false（长 5、非 key[a-z]、非 digit，L38-40）→ `ALLOW_IN_INPUT.has("scm.commit") && (!false)` = true → 输入框内放行（L51-52）——计划 L2941「Enter 为非打印键，白名单放行条件天然满足」**属实** ✓；`when()` L53 兜底 → 仅提交框聚焦时命中。
- **when 标志机制（焦点上报）**：不依赖 when 上下文 store——`data-scm-commit-input` 经 Input 全透传落到 `<input>` DOM（input.tsx:16），when 在派发时刻读 `document.activeElement?.closest(...)`。机制完整可执行，非注释占位 ✓。CommitSection 的 Input 带该属性（计划 L3034），when 读同一选择器 ✓ 闭环。
- **与 editor.save 让行**：editor.save = `primary+keys`（registry.ts:18），与 `primary+enter` 无交集；两者同在白名单、互不影响 ✓。
- **双触发推演**：window 捕获阶段（L60）早于 React 19 root 容器冒泡监听 → host 命中 scm.commit 时 `stopImmediatePropagation`（L55）**阻断** React 合成 keydown → 命令路径与组件本地路径（裸 Enter，计划 L3042 跳过 ctrl/meta）互斥，不可能同时触发；即使用户把 scm.commit 重绑为裸 enter，也是 host 单发（本地 handler 被阻断）。T7 `commitWith` 头部同步守卫 `if (!msg || get().opRunning) return;`（计划 L2060，runOp 首个 set 在 await 前同步落盘）是多余但无害的二道保险 ✓。

### ④ 类型/引用一致性（通过）

T9-10 消费的每个 git.store 成员 × T7 契约（计划 L1916-1964 接口表 / L2013-2213 实现）：

| 成员 | T9-10 用法 | T7 契约位置 | 结论 |
|------|-----------|------------|------|
| `branches: BranchInfo[]` | BranchSelector 列表 | L1920 / L1600-1603 | ✓ |
| `opRunning: string \| null` | busy 门控 / `=== "提交"` | L1927 / runOp("提交") L2054 | ✓ 值域吻合 |
| `loadBranches(path)` | open effect / 刷新按钮 | L2073-2083 | ✓ |
| `checkout(path, name): Promise<boolean>` | doCheckout | L2085-2092（成功后 refresh+loadBranches） | ✓ |
| `createBranch(path, name): Promise<boolean>` | doCreate | L2094-2098 | ✓ |
| `deleteBranch(path, name): Promise<boolean>` | 确认对话框 onConfirm | L2100-2104 | ✓ |
| `commitMessage / setCommitMessage` | CommitSection 受控输入 | L1930 / L2056 | ✓ |
| `commitWith(path, mode): Promise<void>` | 三模式提交 | L2058-2071，mode 联合 `"commit"\|"push"\|"sync"` | ✓ 逐字 |
| `statusLoading / error / refresh / viewDiff / stage / unstage / loadStashes` | GitPanel 头部/列表 | L1923/L1929/L2032/L2038/L2044/L2049/L2130 | ✓ |

- `BranchInfo { name; isHead; isRemote; ahead: number\|null; behind: number\|null }`（T6 计划 L1550、L1600-1603，Rust 侧 camelCase L85/L219-222）与 T9 测试 gitState（L2563）及组件访问 `b.isRemote/b.isHead/b.name`（L2737-2738）三处逐字对齐 ✓。
- `GitConfirmDialog` props 契约（`{ open, title, description, confirmLabel, busy?, onConfirm, onCancel }`，L2643-2651 + 实现 L2658-2685）定义完整，T11-12 可直接消费（ discard/revert/stash-drop 确认）✓。
- `BranchSelector { projectPath, open, onOpenChange }`（L2704-2708）↔ GitPanel `branchSelectorOpen` 本地状态 + 挂载（L2868、L2910-2916）闭环 ✓。
- `useProjectStore.getState()` 取 `{ projects, activeProjectId }` → `.find(p => p.id === activeProjectId)?.path`（L3107-3108）与 project.store 实际字段逐字一致（`src/stores/project.store.ts:6-15`）✓；project.store 模块级仅 `create()(persist(...))` 无副作用（L25-73），registry.ts 新增顶层 import 在 node 环境测试中安全（persist 无 localStorage 时降级 no-op，且同类 ui.store 已在 registry.test.ts 现有绿测中以同样方式被引入）。
- **tsc `noUnusedLocals/noUnusedParameters`（tsconfig.app.json 已开）**：逐项核对 T9/T10 全部新增/变更 import 与解构——T9 后 GitPanel lucide 六项全有用（Check 仍供旧提交区 L104）、T10 后删 Check/Input/commit 恰为失用项；BranchSelector/CommitSection/GitConfirmDialog 无冗余导入；两份新测试文件 import 全部消费 ✓ 无 TS6133/6196 风险。

### ⑤ 测试可运行性（失败：B1；其余全部通过）

- **先例一致性**：docblock `@vitest-environment jsdom` 第 1 行（计划 L2556-2558 / L2947-2949）与 `KeybindingHost.test.tsx:1-3`、`registry.run.test.ts:1-3` 同式 ✓；`afterEach(() => cleanup())` 同项目约定 ✓；vi.mock 工厂「模块级 let + 惰性闭包读取」（计划 L2562-2572 / L2953-2961）与 `registry.run.test.ts:8-24` 同构、TDZ 安全 ✓。注：vitest 4.1.10 默认开启 globals（node_modules/vitest/dist/chunks/index.DC7d2Pf8.js:434 `pretendToBeVisual = true` 同源默认），RTL 自动 cleanup 生效——实跑 `npx vitest run src/commands` 得 **6 文件 / 41 用例全绿**，确认无 window 监听器累积问题，T10 Step 8 的 `toHaveBeenCalledTimes(1)` 断言不受干扰。
- **mock 路径**：`../../stores/git.store`（从 src/features/git/，计划 L2570/L2959）✓；`../stores/project.store`、`../stores/git.store`（从 src/commands/，计划 L3139/L3142）✓。
- **BranchSelector.test 四例逐一推演可过**：loadBranches 同步断言 + effect ✓；checkout 成功关闭（mock resolved true）✓；新建分支→自动 checkout 串行链 ✓；删除走内嵌 GitConfirmDialog（`getByText(/确定删除分支「feature」/)` 命中 DialogDescription、`getByRole("button", { name: "删除" })` 唯一命中确认钮）✓。radix Dialog 受控 open 在 jsdom 可渲染有项目先例（`SettingsDialog.test.tsx:28-34` `getByRole("dialog")`）；嵌套 Dialog 由 DismissableLayer 层栈管理，fireEvent.click 不触发 pointerdown 外侧关闭路径 ✓。
- **registry.test.ts 扩展**：`byId` 助手（registry.test.ts:20）+ `comboToCanonical` → `"primary+enter"` ✓。
- **registry.run.test.ts 扩展**：既有结构（模块级 let L8-14 / mock 工厂 L16-24 / beforeEach L32-39 / getCommand L26）与追加内容逐字相容；新 describe 复用 fake timers 但 run 为同步 ✓；`document` API 有 jsdom docblock 支撑（registry.run.test.ts:1-3）✓。
- **KeybindingHost.test.tsx 扩展两例推演可过**：`fire(window, { key:"Enter", code:"Enter", ctrlKey:true })` → canonical `"primary+enter"` 命中 mock 的 scm.commit → `dlg=false`（body 仅 input）→ `isTypingKey=false` 放行 → `when()` 经 activeElement.closest 判定 → 提交框用例触发 / 无关输入用例不触发 ✓（按 KeybindingHost.tsx:28-58 逐行推演）。
- **CommitSection.test：例 1/2/4 可过**（裸 Enter 经本地 onKeyDown、`e.nativeEvent.isComposing` 默认 false；Ctrl+Enter 本地跳过；空消息 disabled 经 `getByRole("button", { name: "提交" })` 精确匹配唯一命中——RTL 字符串 name 为全等匹配，不会误中 title「更多提交方式」的触发钮）。**例 3 必红，见 B1。**

### ⑥ 设计漏洞扫描（通过；R1/R2 + 5 Note）

- **Ctrl+Enter 与对话框输入冲突**：CommitSection 不在任何对话框内 → 正常触发；BranchSelector/GitConfirmDialog 打开时 `dialogOpen()` 门（KeybindingHost.tsx:49）全让行，叠加 `when()` 对非提交框输入返回 false → 双重抑制 ✓。BranchSelector 新建分支 Input 的 Enter 走本地 doCreate（计划 L2830-2832），与全局命令无交集 ✓。
- **双触发**：见 ③ 末段——捕获阶段 stopImmediatePropagation 使命令/本地两路互斥，机制比计划自身论证（opRunning 守卫兜底）更干净，结论正确 ✓。
- **远程分支 detached HEAD**：分组尾注「签出远程分支将进入分离 HEAD 状态」（L2817）已覆盖；分离后 `status.branch === "HEAD"` 时 T7 push 守卫报中文错（计划 L2119-2122），链路有兜底 ✓。
- **HEAD 分支不可删**：isHead 项渲染 Check 而非删除按钮（L2780-2794）✓。
- **刷新后状态保持**：branches 为 store 级状态、不依赖组件挂载；BranchSelector 每次 open 重新 loadBranches（L2724-2732）；刷新按钮 refresh+loadBranches+loadStashes 三连（L2893-2897）不触碰视图态 ✓。Tree/列表切换态属 T11 范围，本段不适用。
- 其余见 R1/R2 与 Note 列表。

---

## 发现列表

### Blocker ×1

**B1 — Task 10：CommitSection.test 例 3 用 `fireEvent.click` 打不开 radix DropdownMenu（Trigger 只监听 onPointerDown）**
- 位置：计划 L2993（`fireEvent.click(screen.getByTitle("更多提交方式"))`）→ L2994（`await screen.findByText("提交并推送")`）；Step 3（L3085）声称「全过」。
- 实证：@radix-ui/react-dropdown-menu 的 Trigger 开合仅由 `onPointerDown`（`event.button === 0 && event.ctrlKey === false` → `onOpenToggle`）与 `onKeyDown`（Enter/Space/ArrowDown）驱动，**无 onClick 路径**（node_modules/.pnpm/@radix-ui+react-dropdown-me_96c1…/dist/index.mjs L77-90）。`fireEvent.click` 只派发 MouseEvent("click") → 菜单永不打开 → `findByText` 1s 超时红。
- 失败场景：`pnpm test src/features/git/CommitSection.test.tsx` 四例挂一，TDD 绿步不可达。
- 修法（一行，且修复路径已逐环实证可行）：改该行 `fireEvent.pointerDown(screen.getByTitle("更多提交方式"))`；item 点击保持 `fireEvent.click` 不变——MenuItem 选择走 `onClick → handleSelect`（@radix-ui/react-menu 2.1.24 dist L397）✓；jsdom 30 具备 `PointerEvent` 构造器（实机探针确认）✓；vitest jsdom 默认 `pretendToBeVisual: true` 提供 rAF（vitest dist chunk L434），满足 react-popper `autoUpdate(..., { animationFrame: … })`（react-popper dist L130-134）✓；react-menu 2.1.24 全文无 `hasPointerCapture` 调用（grep 空）✓；floating-ui 的 `elementResize` 默认值带 `typeof ResizeObserver === 'function'` 守卫（jsdom 为 false，不启用）✓。

### Risk ×2

**R1 — Task 9：BranchSelector 对 checkout/createBranch/deleteBranch 失败静默无回显**
- 位置：计划 L2740-2755（doCheckout/doCreate 失败仅 `return`，不清理不提示）、L2851-2855（deleteBranch fire-and-forget，确认框点「删除」后立即 `setToDelete(null)` 关闭）。
- 失败场景：T7 失败时设 `error`（计划 L1993）→ GitPanel 头部下方错误条（L2902-2904）确实会显示，但**被 BranchSelector 对话框遮罩（z-50 overlay）盖住**，用户只见对话框停留、不知为何；删除失败则确认框已关、彻底无感。T7 的 opLog 已记录失败原因，T9 UI 未消费。
- 建议：BranchSelector 订阅 `useGitStore((s) => s.error)` 并在对话框内底部渲染一行错误；或 doCheckout/doCreate/delete 改本地 error state 回显。

**R2 — Task 9：GitConfirmDialog 的 `busy` prop 近乎摆设（与 R1 同根因）**
- 位置：计划 L2851-2855——onConfirm 同步 `setToDelete(null)` 后 `void deleteBranch(...)`，对话框立即关闭，`busy={busy}`（L2849，值取自 opRunning）没有机会渲染禁用态；删除进行中用户可再次打开再次删除（store 的 opRunning 门会挡掉实际调用，但 UI 无反馈）。
- 建议：onConfirm 改 async——`await deleteBranch(...)` 期间对话框保持打开并显示 busy，成功后再关。

### Note ×5

**N1 — Task 9 Step 6.2 文案「追加三个动作」实为两个**
- 位置：计划 L2867。目标解构行相对 T7 目标行只多出 `loadBranches, loadStashes`。计划给出的完整目标行本身正确，执行者照目标行即可；仅文案计数错。

**N2 — BranchSelector 搜索框 Enter 无行为**
- 位置：计划 L2763-2768。搜索 Input 无 onKeyDown，Enter 空操作。可考虑「Enter 签出首个匹配项」，纯 UX 建议。

**N3 — 嵌套对话框焦点回落**
- 说明：内层 GitConfirmDialog 关闭后 radix 将焦点恢复至内层打开前的聚焦元素（外层某个 `opacity-0` 的删除图标按钮），视觉略怪但无害；Esc 嵌套由 DismissableLayer 层栈保证只关最内层。

**N4 — registry.test.ts（node 环境）经 registry 新增引入真实 project.store 的 persist 中间件**
- 位置：计划 L3091-3093（registry.ts 新增两条 store import）。
- 说明：project.store 模块级仅 `create()(persist(...))` 无副作用（project.store.ts:25-73）；node 环境无 localStorage 时 zustand persist 降级为 no-op（可能多一条 console.warn）。同类 ui.store 已在现有 registry 测试中以同样方式引入且套件实跑全绿，无行为风险。

**N5 — 维度③前提订正：host 无 when 表达式解析器**
- 说明：`Command.when` 是 `() => boolean` 函数类型（types.ts:16-17，KeybindingHost.tsx:53 直接调用），不存在字符串表达式 parser。计划全程使用函数 when，与实现契约吻合；「when 表达式语法与 host 解析器逐字匹配」应理解为「函数契约 + 键位 token 归一化（`"enter"`/`"primary+enter"`）逐字匹配」，后者已验通。

---

## 结论

Task 9-10 在**组件真实性、锚点、命令注册全链路、类型契约**四个维度全部成立：scm.commit 的 registry → resolve 回退 → host 分发（allowlist/when 次序）→ Input 属性透传的 when 标志是一条完整可执行的闭环；Ctrl+Enter 与裸 Enter 的双触发、对话框冲突经实现级推演均安全。**不可直接执行的唯一点是 B1**——CommitSection 下拉测试用 `fireEvent.click` 开 radix 菜单（一行改 `fireEvent.pointerDown` 即修复，修复路径的每个环境依赖已实证）。修完 B1 后建议一并处理 R1（失败回显，顺带消解 R2）再进入执行。
