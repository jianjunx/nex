# Plan 6 预执行验证报告 — 对话页签轮廓 + 新建会话下拉

- **日期**: 2026-07-31
- **对象**: `docs/superpowers/plans/2026-07-31-plan6-tab-outline-new-conversation.md`（6 任务）
- **方法**: 只读核对。逐条比对计划中的代码块 / 锚点（file:line）/ 签名 / import / 测试断言与：(1) 当前磁盘源码（src/**）；(2) node_modules dist（radix-ui@1.6.7 内嵌 @radix-ui/react-dropdown-menu、@radix-ui/react-menu@2.1.24）；(3) 跨计划一致性（Plan 3 / Plan 5 在盘，Plan 4 未出）。另用 Playwright(Chromium) 实测了"被 preventDefault 的 pointerdown 之后 click 是否仍触发"这一关键浏览器语义（data: URL 页面，未触碰仓库）。

---

## 维度总表

| 维度 | 结论 | 关键证据 |
|---|---|---|
| ① 编译可行性 | **PASS** | 全部 import 目标存在；`icon-xs` 在 button.tsx L29；dropdown-menu 六个具名导出齐全（dropdown-menu.tsx L239-255）；所用 CSS 变量全部已定义（globals.css）；tw-animate-css 已装且已 import（package.json L42 / globals.css L3）；`scrollbar-none` 为 Tailwind v4.1+ 内置（仓库 4.3.3） |
| ② 锚点真实性 | **PASS（含 R3 时限性警告）** | 对照当前磁盘逐字核验：registry.ts L85-95 ✓、TopBar.tsx L116-118/L128/L166-169/L16/L53/L110-113/L182 ✓、ui/tabs.tsx L67-70 ✓、ui.store.ts L11/L13/L21/L31-32/L47/L69-70/L75-83 ✓、SettingsDialog.tsx L1/L3/L12/L25 ✓、NewConversationModal.tsx L50-74 ✓、registry.test.ts L27（primary+shift+keyn 断言）✓。**但** Plan 3/5 先执行后 registry.ts 行号会漂移（见 R3） |
| ③ 类型一致性 | **PASS** | `triggerSize: "icon" \| "icon-sm"` ≡ TopBar `iconSize`（TopBar.tsx L99 推断 `"icon-sm" \| "icon"`）；`createConversation(projectId, agentType)` / `createSession(convId, target, cwd)` / `closeTab(id)` 签名与 conversation.store L33-35、agent.store L54 一致；`ServerDescriptor`/`SessionTarget`/`Conversation`/`Project` 与 bridge/tauri L7-13/L24-32/L98-105/L116-118 逐字一致；`SettingsSection` 与 SettingsDialog `TabId` 六值同集 ✓ |
| ④ 测试可运行性 | **FAIL** | jsdom 约定全部合规（docblock/cleanup/fireEvent 路径对 menuitem 正确），**但触发器的 fireEvent.click 路径与真实浏览器事件流不一致，14 处"点击 + 开菜单"断言系统性掩盖了 B1 双触发缺陷**——测试将全绿，真机交互却坏（见 B1，Playwright 实测为证） |
| ⑤ 设计漏洞扫描 | **FAIL** | B1（+ 按钮真机双触发）+ R1（dark 主题下轮廓被内置类级联盖回透明）+ R2（SettingsDialog tab 状态跨开合持久化，与冒烟项 6 承诺矛盾） |

---

## 逐维度详情

### ① 编译可行性 — PASS

- `NewConversationDropdown.tsx` 的依赖逐一落盘核验：
  - `@/components/ui/button`：`icon-xs`（button.tsx L29）、`icon-sm`（L30）、`icon`（L28）、`ghost`（L19）均存在；
  - `@/components/ui/dropdown-menu`：`DropdownMenu/Trigger/Content/Item/Label/Separator` 全部导出（dropdown-menu.tsx L239-255）；内容件自带 `bg-[var(--glass-3-surface)] backdrop-blur-xl`（L43），与计划 L25 的"已玻璃化"论断一致；
  - CSS 变量：`--glass-1/2/3-surface`、`--overlay-hover`、`--overlay-ghost`、`--border-default`、`--border-subtle`、`--radius-md`、`--radius-sm` 全部在 globals.css 定义（`--warning/--success/--error` 命名亦与约束一致）；
  - `animate-in fade-in-0` 依赖 tw-animate-css：package.json L42 已装、globals.css L3 已 `@import "tw-animate-css"`；
  - `scrollbar-none`：Tailwind v4.1+ 内置 scrollbar-width 工具类，仓库 tailwindcss ^4.3.3 ✓；`bg-gradient-to-r/l` 为 v4 保留别名 ✓。
- Task 4 的 `SettingsSection` 导出 → SettingsDialog `type TabId = SettingsSection` 替换，与 `TABS` 数组六值（SettingsDialog.tsx L13-20）完全同集。
- Task 2 的 registry 替换块：`Command.run: () => void`（commands/types.ts L17），`toggleNewConversation` 返回 void ✓；`useUiStore` 已在 registry.ts L4 导入，无需新增 ✓（计划亦如此声明）。

### ② 锚点真实性 — PASS（附 R3）

对照**当前磁盘**逐字核验（全部命中）：

| 计划位置 | 锚点 | 磁盘证据 |
|---|---|---|
| Task 2 header / Step 3 | registry.ts L85-95 `workbench.newConversation` 整条 | registry.ts L85-95 逐字一致（id/title/category/defaultKey/no-op run） |
| Task 3 Edit A old_string | TopBar.tsx L116-118（容器开头 + "No conversations"） | 逐字一致 |
| Task 3 Edit B old_string | TopBar.tsx L166-169（` )}` / `</div>` / 空行 / `{/* Panel toggle */}`） | 逐字一致，且带 Panel toggle 注释保证唯一 |
| Task 3 Step 4 old_string | TopBar.tsx L128 TabsTrigger className | 逐字一致（含 `inset_0_-2px_0_0_var(--accent)` 旧阴影） |
| Task 5 编辑 1-4 | TopBar.tsx L16 / L14 / L2 / L53 / L110-113 / L182 | 全部逐字一致；`iconSize` 推断为 `"icon-sm" \| "icon"`（L99）与 `triggerSize` 逐字一致 |
| Task 1 编辑 1-4 | ui.store.ts L11（sanitizeSidePanelTab 收尾）/L13（interface）/L21（settingsOpen 字段）/L31-32（open/closeSettings 签名）/L47（settingsOpen: false）/L69-70（实现两行） | 全部命中；partialize 白名单 L75-83 确实不含 settingsOpen（"同待遇"论断 ✓） |
| Task 4 SettingsDialog 编辑 1-3 | SettingsDialog.tsx L1 / L3 / L12 / L25 | 逐字一致 |
| 背景论断 "ui/tabs.tsx:67-70 内置类" | tabs.tsx L67 `...:data-[state=active]:shadow-none`、L68 `group-data-[variant=line]/tabs-list:bg-transparent ... :bg-transparent`、L70 `...:after:opacity-100` | 逐字存在，特异性论断成立 |
| 背景论断 "NewConversationModal.tsx:50-74 handleCreate" | NewConversationModal.tsx L50-74 | 逐字一致；kind→SessionTarget 映射、closeTab 回滚、fire-and-forget createSession 全部对得上 |
| Task 2 既有断言 | registry.test.ts L27 `"primary+shift+keyn"` | 存在；当前 4 例（`it(` 计数=4），+1 后"5 例全绿"自洽 |

时限性警告见 R3：执行顺序为 Plan 3→4→5→6，Plan 3 会向 COMMANDS 增 `scm.commit`、Plan 5 改写 `search.focus` 的 run 并向 ui.store 插字段，届时上表中 registry.ts 的**行号**漂移（标识符锚点仍稳）。

### ③ 类型一致性 — PASS

- 跨任务命名链逐一对齐：Task 1 产出的 `newConversationOpen/settingsSection/openNewConversation/closeNewConversation/toggleNewConversation/setSettingsSection/SettingsSection` 与 Task 2（registry run）、Task 4（下拉组件 + SettingsDialog 消费）、Task 5（TopBar 接线）的消费点逐字一致。
- agent.store 数据链核验：`servers: ServerDescriptor[]`（L47）、`serversLoading`（L49）、`serversLoadedAt`（L51，loadAllServers finally 打点 L415）、`loadAllServers`（L66/399）、`refreshRegistry`（L67/420）、`createSession(conversationId, target, cwd) → Promise<string>`（L54/159）、`error`（L52）——与计划 L26 论断及组件用法完全一致。新鲜度守卫写法与 AgentsSection.tsx L32-34 同构（计划仅多加 `if (!open) return`）✓。
- conversation.store：`createConversation(projectId, agentType)`（L33/167，内部 unshift+push+激活，与 TopBar 测试 `fakeCreateConversation` 的副作用逐一对齐——计划 L1037-1039 注释正确）、`closeTab`（L35）、`switchTab`（L34）、三个 ByProject 映射 + 两个 selector（L22-24/L65-86）✓。
- bridge 类型：`Conversation`（L24-32）、`ServerDescriptor`（L98-105，`kind: "registry" | "custom"`）、`SessionTarget`（L116-118）、`Project`（L7-13，测试播种五字段齐全）✓。

### ④ 测试可运行性 — FAIL（见 B1）

合规部分（先记功）：
- 三个新 jsdom 文件均有第 1 行 docblock + `afterEach(() => cleanup())` ✓；`ui.store.test.ts` 无 docblock → node 环境，与既有 `ui.settings.test.ts`（同目录、无 docblock、现绿）先例一致，zustand persist 在 node 下自动降级 no-op ✓。
- MenuItem 选择路径：react-menu@2.1.24 dist L397 `onClick: composeEventHandlers(props.onClick, handleSelect)` → `fireEvent.click` 对**菜单项**正确 ✓；L384-389 `defaultPrevented` 时不 `rootContext.onClose()` → 计划 `onSelect` 里 `e.preventDefault()` 保住面板 ✓；L449 `"data-disabled": disabled ? "" : void 0` → 防连点断言 `getAttribute("data-disabled")).toBe("")` 可达 ✓。
- Esc 关闭：`fireEvent.keyDown(document.body, {key:"Escape"})` 冒泡至 document，命中 radix useEscapeKeydown 监听 → onDismiss → onOpenChange(false) → store 关 ✓。
- 受控 open（store 标志）绕过触发器 pointerdown-only 限制 → jsdom 中 `fireEvent.click` 经 React onClick 单次翻转 → 面板开 ✓（**这正是测试能绿、而真机坏的原因**）。
- SettingsDialog 测试：六分区 + recordingState 全 mock、路径（`./sections/*`、`./KeybindingsEditor`、`./recordingState`）与磁盘一致（sections/ 目录六件 + KeybindingsEditor.tsx + recordingState.ts L11 导出 isRecordingActive）；同一时刻仅渲染一个分区 → `getByTestId("sec")` 唯一 ✓；消费 effect 在 act 内同步落地 ✓、deps `[open, settingsSection]` 无死循环 ✓。
- 用例数自洽：下拉 11 + 弹窗 2 + TopBar 7（F5×4+F6×3）+ registry +1 + ui.store +3，与各 Step 预期文字一致。

FAIL 原因：触发器开启一律用 `fireEvent.click`（计划 L544-547、L551-556、L620、L1147、L1164），该路径只派发 click、不派发 pointerdown，与真实浏览器事件流（pointerdown→[取消]→pointerup→click，见 B1 实测）不同构，系统性掩盖 B1。测试可运行且会全绿——但绿是假信号。

### ⑤ 设计漏洞扫描 — FAIL（B1 / R1 / R2 / R4）

- **B1**（Blocker）：触发器双触发，详见下。
- **R1**（Risk）：dark 主题级联回归。ui/tabs.tsx L68 内置 `dark:group-data-[variant=line]/tabs-list:data-[state=active]:bg-transparent` 与 `...:border-transparent`；dark 变体定义为 `@custom-variant dark (&:where([data-theme="dark"], [data-theme="dark"] *))`（globals.css L2）——`:where()` 零特异性，且 Tailwind 输出中 dark 工具类排在同组 plain 之后 → dark 主题下内置透明底/透明边将**盖过**计划的 plain 前缀玻璃底/描边（计划 L433 未给 bg/border 配 `dark:` 对偶类）。结果：dark 主题激活页签重新变回"透明底、无描边"——即 F5 要消灭的缺陷在 dark 下复现。计划 L23"dark media 模拟下同样成立"的实测结论与该机械分析矛盾。当前 main.tsx L8 硬编码 `data-theme="light"`，默认主题不受影响，故评 Risk 而非 Blocker；globals.css L8 注释表明 dark 才是设计默认，用户切主题即触发。
- **R2**（Risk）：SettingsDialog 的 `tab` state 跨开合持久化。App.tsx L100 **无条件**挂载 `<SettingsDialog />`，`useState<TabId>` 只初始化一次。走"管理智能体…"→ agents → 关闭 → 再普通打开，仍停在"智能体"，**与冒烟项 6（L1292）"关闭后再次普通打开设置回到「外观」"直接矛盾**。测试全过（每例新渲染），冒烟必挂，把实现者打回。
- **R3**（Risk）：锚点时限性。Plan 3 向 COMMANDS 增 `scm.commit`（其计划 L67/L3096）、Plan 5 改 `search.focus` run 且向 ui.store 插 `searchFocusRequest`（其计划 L2795-2846）、Plan 4 未出 → Plan 6 的 `registry.ts:85-95` 行号锚点执行时必漂。已核验：Plan 5 对 ui.store 的四处插入均以稳定唯一行（`settingsOpen: boolean;` / `closeSettings: () => void;` / `settingsOpen: false,` / closeSettings 实现行）为锚，与 Plan 6 的锚点**不互改**、复合后可编译、partialize 双方都靠白名单天然排除——故 ui.store 无硬冲突；registry.ts 靠命令 id 定位亦可恢复。另：Plan 5 会向 ui.settings.test.ts 追加 1 例，Plan 6 Task 1 Step 4"既有 4 例"届时为 5 例（文字过时，不影响绿）。
- **R4**（Risk）：下拉 error 状态跨开合残留。`error` 仅在 `handleCreate` 开头清空（L827）；创建失败后关面板再开，红字错误行仍在（`DropdownMenuContent` 随 open 卸载，但 `useState` 在常驻组件里）。冒烟项 5 未覆盖此路径。

设计漏洞扫描中**未发现问题**的点（记录在案）：
- 创建语义两段 try 切分正确（建标签前失败→错误行不关面板不建 session；建标签后任何同步失败→closeTab 回滚），与测试 L591-600 契约一致；
- 防连点 `creatingId !== null` 同步置位（首个 await 前）→ 断言可达；
- 新鲜度守卫 deps 完整，mock 不改 serversLoadedAt → 无重入循环；
- "管理智能体…" 三动作（close/section/open）同步落 store，SettingsDialog 消费 effect 一次性消费并清空，`if (open && settingsSection)` 守卫保证关窗态不误触；
- 渐隐遮罩 `pointer-events-none` + 常驻（v1 不做滚动感知，YAGNI 合理）；
- `before:` 强调条依赖 TabsTrigger 内置 `relative`（tabs.tsx L67 确有）✓。

---

## 发现清单

### Blocker ×1

**B1 — `+` 触发器 onClick 与 Radix onPointerDown 双触发，真机点击行为全坏**（计划 L860-869 组件、L858-859 注释、L1287 冒烟项 1；测试 L544-556/L620/L1147/L1164）
- 磁盘/实测证据：react-dropdown-menu dist（radix-ui@1.6.7 内嵌）L77-84 Trigger 仅经 `onPointerDown`（`context.onOpenToggle()`，开时 `event.preventDefault()`）与 `onKeyDown` 开合，无 onClick 路径。Playwright(Chromium) 实测：取消 pointerdown 后事件序列为 `pointerdown, pointerup, click`——mousedown/mouseup 被吞，**click 照常派发**。
- 失败场景（真实浏览器＝Tauri WebView2/Chromium）：关→点 `+`：pointerdown 开（store true）→ click 触发 `toggleNewConversation` 关（store false），按钮形同失效；开→点 `+`：pointerdown 关（未 preventDefault）→ 完整 mousedown/mouseup/click → toggle 重开，永远关不上。键盘（Enter/Space，keydown 路径且被 preventDefault）反而正常。jsdom 里 fireEvent.click 只派发 click、单次翻转 → 14 处断言全绿，彻底掩盖。
- 一句话修复：删掉触发器上的 `onClick={toggleNewConversation}`——Radix 触发器自身的开合已经经 `onOpenChange` 汇回同一 store 标志（这就是唯一路径，计划注释的"两路不冲突"论断是错的）。

### Risk ×4

**R1 — dark 主题下胶囊轮廓被内置类级联盖回透明**（计划 L433；L23 实测论断）
- 证据：ui/tabs.tsx L68 内置 `dark:group-data-[variant=line]/tabs-list:data-[state=active]:bg-transparent` / `...:border-transparent`；globals.css L2 dark 变体用 `:where()`（零特异性）+ Tailwind dark 工具类输出序靠后 → 同特异性下级联晚者胜 → 计划的 plain 玻璃底/描边在 dark 下输。
- 失败场景：用户切 dark（globals.css L8 明示 dark 为设计默认；当前 main.tsx L8 暂硬编码 light 故默认不炸），激活页签重回"透明底无描边"，F5 视觉目标在 dark 失效；与计划自述 dark 已实测矛盾。
- 修复：给激活 bg/border 配 `dark:group-data-[variant=line]/tabs-list:data-[state=active]:` 前缀对偶类，并在冒烟项 3 显式加测 dark（computed style 核验）。

**R2 — SettingsDialog tab 跨开合持久化，冒烟项 6 承诺不兑现**（计划 L1292 vs L734-747 实现；App.tsx L100）
- 证据：SettingsDialog 在 App 无条件常驻挂载，`useState<TabId>` 不随关窗重置；计划 effect 仅在 `settingsSection` 存在时 setTab，普通重开无重置路径。
- 失败场景：走一次"管理智能体…"后，此后每次普通打开设置都停在"智能体"，冒烟项 6 期望"回到外观"必挂 → Task 6 循环打回。
- 修复：effect 内对 open false→true 的普通打开（无 settingsSection）重置 `setTab("appearance")`；或修订冒烟文案承认"记忆上次分区"。

**R3 — 行号锚点对执行时磁盘过时（Plan 3/5 先行 + Plan 4 未出）**（计划 L185 Task 2 `registry.ts:85-95`；L171"既有 4 例"）
- 证据：Plan 3 计划 L67/L3096 向 registry.ts COMMANDS 增 `scm.commit`（行号漂移），Plan 5 计划 L2795-2846 向 ui.store 插字段、向 ui.settings.test.ts +1 例。
- 失败场景：机械照抄"第 85-95 行"会替换错命令；"4 例"文字与实跑 5 例不符引发误判。
- 修复：执行时以命令 id / 唯一行锚定、重算行号（ui.store 的锚点已验证与 Plan 5 复合安全，registry 靠 id 即可）。

**R4 — 创建失败的错误行跨开合残留**（计划 L810/L827）
- 证据：`error` 只在 handleCreate 起手清空；面板开合不清。
- 失败场景：失败→关面板→重开，陈旧红字仍在，像新报错。
- 修复：打开时（onOpenChange true 或 open effect）清空 error。

### Note ×8

1. **N1（好）**：Task 6 门槛只写"全部测试绿"，无绝对总数断言——Plan 4 未出也无须重算（当前基线 108/21 文件；Plan 3 目标 153；Plan 5 另加；Plan 6 本计划 +24 例：3+1+7+11+2）。
2. **N2**：`ui.store.test.ts` 不带 jsdom docblock 走 node 环境，有既有同目录 `ui.settings.test.ts` 先例支撑（zustand persist 在 node 自动降级 no-op），可行。
3. **N3**：Task 1 编辑 3 措辞"closeSettings 之后"但块内含 openSettings/closeSettings 两行（插入/替换二义）；接口成员重复在 TS 合法、实现区 Step 明确为替换，不构成编译风险。
4. **N4**：计划关于 tailwind-merge 顶掉内置冲突类的论断经 tabs.tsx L67-70 核验成立（内置冲突类与计划类 modifier 前缀逐字相同 → twMerge 留后参）。
5. **N5**：菜单项 fireEvent.click 选择、`data-disabled=""`、preventDefault 保面板、Esc 冒泡关闭四条测试机制均与 dist 逐行对上（react-menu L397/L449/L384-389）。
6. **N6**：DropdownMenuContent 玻璃底（dropdown-menu.tsx L43）、`--glass-1-surface` 为 TopBar 实际底（TopBar.tsx L105）——渐隐起始色论断成立。
7. **N7**：门槛命令 `pnpm lint && pnpm build && pnpm test` 无管道，不踩 `| tail` 吞退出码陷阱；`pnpm tsc --noEmit` no-op 的认知与约束一致。
8. **N8**：registry.run.test.ts 现无 workbench.newConversation 用例（已 grep 确认），Task 2 接线 run 不破坏任何既有 run 断言；Plan 3/5 对其的扩展与本计划文件集无交集。

---

## 结论

**是否可直接执行：否。**

Blocker×1（B1：`+` 按钮真机双触发，测试全绿但交互全坏——恰被 Task 6 冒烟项 1 逮住，属"执行完才发现"的最坏形态）必须在执行前修掉：删除触发器 `onClick={toggleNewConversation}`（一行改动 + 删 L858-859 误导注释；删除后 jsdom 测试需改用 `fireEvent.pointerDown` 开菜单以匹配真实事件路径，或保持受控 store 直置开启——注意删 onClick 后现有 fireEvent.click 开菜单的 14 处断言会红，须同步改测试路径为 pointerDown）。Risk×4 建议同批修订（R1 加 dark 对偶类并扩冒烟、R2 加重置逻辑或改冒烟文案、R3 执行时重算锚点、R4 开面板清 error）。修完 B1 并处置 R1/R2 后可进入 SDD 执行循环；其余 Note 留档即可。
