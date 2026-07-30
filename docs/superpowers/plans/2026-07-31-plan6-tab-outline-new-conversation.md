# 对话页签轮廓与新建会话下拉 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给对话页签加上"有边界胶囊"轮廓（玻璃面 + 整圈描边 + 左侧 2px 强调边 + 顶部内高光 + 溢出渐隐遮罩），并删除 `NewConversationModal`，把 `+` 按钮与 `Ctrl+Shift+N` 统一为受控下拉面板——点智能体行即创建会话。

**Architecture:** 触发机制是 `ui.store` 的 `newConversationOpen` 标志位（外加一次性消费的 `settingsSection` 供"管理智能体…"定向），命令注册表只翻转标志位，下拉组件受控渲染，`+` 按钮即 Radix Trigger。页签轮廓是纯 TopBar className 层改动（不动 `ui/tabs.tsx`）；**关键：激活态样式必须带 `group-data-[variant=line]/tabs-list:data-[state=active]:` 前缀**——已实测，裸 `data-[state=active]:` 类会被 `ui/tabs.tsx` 内置的同组 `bg-transparent`/`shadow-none` 类按 CSS 特异性压制（当前线上激活页签实际透明底、无阴影），同前缀类才能经 tailwind-merge 精确冲突顶掉内置类。创建语义原样搬自旧模态框：立即开标签 → 关面板 → 后台会话握手；创建失败本地错误行，建标签后失败回滚 `closeTab`。

**Tech Stack:** React 19 + TypeScript + Zustand(immer/persist) + radix-ui Tabs/DropdownMenu + Tailwind v4（tw-animate-css 已在依赖）+ vitest(+jsdom, @testing-library/react) + pnpm

## Global Constraints

1. 所有面向用户文案为简体中文；代码标识符、文件路径、提交信息 scope 保持英文。
2. 提交信息风格：英文 scope + 中文描述。
3. 门槛三件套 `pnpm lint && pnpm build && pnpm test` 全绿；`pnpm tsc --noEmit` 是 no-op，真实类型门槛是 build；lint 既有 6 条 warning 可接受，不新增 error。
4. vitest 未开 globals：jsdom 文件第 1 行 `/** @vitest-environment jsdom */` docblock + 显式 `afterEach(() => cleanup())`；模块 mock 用模块级可变 let + vi.mock 闭包延迟读取模式（参考 src/features/settings/KeybindingsEditor.test.tsx）。
5. 命令注册：改 command run 后核对 registry.test 的既有断言不破坏。
6. 多智能体集成复用 agent store 既有能力（loadAllServers/refreshRegistry/createSession），不硬编码命令、不新增后端。
7. 不新增依赖。

**技术背景（勘察与实测结论，实现者必读）：**

- `src/components/ui/tabs.tsx:67-70` 的 TabsTrigger 内置了 `group-data-[variant=line]/tabs-list:bg-transparent`、`group-data-[variant=line]/tabs-list:data-[state=active]:bg-transparent`、`group-data-[variant=line]/tabs-list:data-[state=active]:shadow-none`、`group-data-[variant=line]/tabs-list:data-[state=active]:after:opacity-100` 等类，其 CSS 特异性（0,4,0）高于裸 `data-[state=active]:*` 类（0,2,0）。**浏览器实测（2026-07-31，vite dev + computed style）**：当前线上激活页签 `backgroundColor` 透明、`boxShadow` 全零——即现状激活指示基本不可见。因此 Task 3 的 className 里一切激活态样式与 hover 背景均带 `group-data-[variant=line]/tabs-list:` 前缀；`cn()`（tailwind-merge）会把同前缀的内置冲突类直接丢弃、保留我们的后参数类。Task 3 的完整 className 已实测生效（激活玻璃底/1px 内高光/描边/12px 圆角/左侧强调条、非激活 hover 上浮+显底显边、激活 hover 不浮、dark media 模拟下同样成立），**照抄勿改前缀**。
- 渐隐遮罩的起始色用 `var(--glass-1-surface)`（TopBar 实际玻璃底）；仓库无 `--bg-app` 变量。
- `DropdownMenuContent` 已玻璃化（`bg-[var(--glass-3-surface)] backdrop-blur-xl`），直接用；Radix 下拉键盘导航/Esc/焦点陷阱/portal 全自带。
- agent 数据链已齐：`servers: ServerDescriptor[]`（`{ id, name, version, description, icon, kind: "registry" | "custom" }`）+ `serversLoading` + `serversLoadedAt` + `loadAllServers()` + `refreshRegistry()` + `createSession(conversationId, target, cwd)`，均在 `src/stores/agent.store.ts`。
- 创建语义来源 `src/features/projects/NewConversationModal.tsx:50-74`（`handleCreate`）：`createConversation(projectId, agentType)` 立即建会话并开标签激活 → 关面板 → fire-and-forget `createSession`（`SessionTarget` 由 `kind` 映射 `{type:"custom"|"registry", id}`；失败写 `agent.store.error`）。`closeTab(id)` 负责回滚。
- 测试环境：`vite.config.ts` test.environment 默认 node；jsdom 文件必须自带 docblock（约束 4）。zustand 真 store 在 jsdom 下可用（persist 有 localStorage）；store 的 **action 可用 `setState` 注入 mock**（本计划测试采用"模块级可变 let 持有 mock action + beforeEach 经 setState 注入真 store"模式——约束 4 模式的 zustand 变体，避免整模块 mock zustand）。
- `workbench.newConversation` 命令已注册于 `src/commands/registry.ts:85-95`（no-op 占位，默认键 `Ctrl/Cmd+Shift+N`），本计划只接线其 `run`。

---

## File Structure

| 文件 | 动作 | 职责 |
|---|---|---|
| `src/stores/ui.store.ts` | Modify | +`SettingsSection` 类型；+`newConversationOpen`/`settingsSection` 字段与 open/close/toggle/setSettingsSection 动作（均不持久化） |
| `src/stores/ui.store.test.ts` | Create | 下拉开关三动作、settingsSection 往返、两新字段不进 persist partialize |
| `src/commands/registry.ts` | Modify | `workbench.newConversation.run` 接线 `toggleNewConversation()` |
| `src/commands/registry.test.ts` | Modify | +1 例：run 往返翻转 ui.store 开关 |
| `src/features/layout/TopBar.tsx` | Modify | 页签容器改 relative+滚动层+左右渐隐遮罩；TabsTrigger className 重写为胶囊轮廓；`+` 按钮换成下拉组件；删模态框 import/state/挂载 |
| `src/features/layout/TopBar.test.tsx` | Create（T3 建 F5 断言，T5 扩 F6 集成例） | 轮廓类断言、遮罩类断言、点 `+` 开下拉、Esc 关、命令开、点行即建 |
| `src/features/projects/NewConversationDropdown.tsx` | Create | 受控下拉：`+` Trigger + 头部"选择智能体"+刷新、列表行（名称/版本/kind 徽标/描述截断）、点行即建、防连点、空态/加载、错误行、管理智能体…、stagger 入场 |
| `src/features/projects/NewConversationDropdown.test.tsx` | Create | 创建链路、kind 映射、成功关面板、失败错误行、回滚 closeTab、防连点、新鲜度守卫、空态/加载、管理智能体定向 |
| `src/features/settings/SettingsDialog.tsx` | Modify | 打开时一次性消费 `ui.store.settingsSection`（定位页签后立即清空） |
| `src/features/settings/SettingsDialog.test.tsx` | Create | 默认定位外观；settingsSection 一次性消费 |
| `src/features/projects/NewConversationModal.tsx` | Delete | 旧模态框（Task 5 删，全仓残留清零） |

---

### Task 1: ui.store — newConversationOpen 开关 + settingsSection 定向字段

**Files:**
- Modify: `src/stores/ui.store.ts`
- Test: `src/stores/ui.store.test.ts`（Create）

**Interfaces:**
- Consumes: 无（底层）
- Produces: `useUiStore` 新增——`newConversationOpen: boolean`（初始 `false`）、`settingsSection: SettingsSection | null`（初始 `null`）、`openNewConversation(): void`、`closeNewConversation(): void`、`toggleNewConversation(): void`、`setSettingsSection(section: SettingsSection | null): void`；新导出类型 `export type SettingsSection = "appearance" | "editor" | "terminal" | "agents" | "keybindings" | "layout"`。两个新字段**不进 persist partialize**（瞬态，与 `settingsOpen` 同待遇）。Task 2（registry run）、Task 4（下拉组件 + SettingsDialog）、Task 5（TopBar 接线）全部依赖这些名字，逐字使用。

- [ ] **Step 1: 写失败测试**

创建 `src/stores/ui.store.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { useUiStore } from "./ui.store";

describe("ui.store newConversationOpen", () => {
  it("open/close/toggle the dropdown flag", () => {
    useUiStore.setState({ newConversationOpen: false });
    useUiStore.getState().openNewConversation();
    expect(useUiStore.getState().newConversationOpen).toBe(true);
    useUiStore.getState().closeNewConversation();
    expect(useUiStore.getState().newConversationOpen).toBe(false);
    useUiStore.getState().toggleNewConversation();
    expect(useUiStore.getState().newConversationOpen).toBe(true);
    useUiStore.getState().toggleNewConversation();
    expect(useUiStore.getState().newConversationOpen).toBe(false);
  });
});

describe("ui.store settingsSection", () => {
  it("defaults to null and round-trips via setSettingsSection", () => {
    useUiStore.setState({ settingsSection: null });
    expect(useUiStore.getState().settingsSection).toBeNull();
    useUiStore.getState().setSettingsSection("agents");
    expect(useUiStore.getState().settingsSection).toBe("agents");
    useUiStore.getState().setSettingsSection(null);
    expect(useUiStore.getState().settingsSection).toBeNull();
  });

  it("keeps both new fields transient (excluded from persist partialize)", () => {
    const options = useUiStore.persist.getOptions() as unknown as {
      partialize: (s: unknown) => Record<string, unknown>;
    };
    const persisted = options.partialize(useUiStore.getState());
    expect(Object.keys(persisted)).not.toContain("newConversationOpen");
    expect(Object.keys(persisted)).not.toContain("settingsSection");
    expect(Object.keys(persisted)).not.toContain("settingsOpen");
  });
});
```

- [ ] **Step 2: 跑测试确认红**

Run: `pnpm vitest run src/stores/ui.store.test.ts`
Expected: FAIL（`newConversationOpen` / `settingsSection` / 各动作均不存在，TS 编译或断言失败）

- [ ] **Step 3: 实现 ui.store 改动**

对 `src/stores/ui.store.ts` 做四处编辑：

编辑 1 —— 在 `sanitizeSidePanelTab` 之后、`interface UiState` 之前加类型：

```ts
/** 设置弹窗六分区；供 ui.store.settingsSection 一次性定向导航（如"管理智能体…"）。 */
export type SettingsSection =
  | "appearance"
  | "editor"
  | "terminal"
  | "agents"
  | "keybindings"
  | "layout";
```

编辑 2 —— `interface UiState` 字段区，`settingsOpen: boolean;` 之后：

```ts
  settingsOpen: boolean;
  newConversationOpen: boolean;
  /** 一次性设置弹窗定向：置位后由 SettingsDialog 打开时消费并清空。 */
  settingsSection: SettingsSection | null;
```

编辑 3 —— `interface UiState` 动作区，`closeSettings: () => void;` 之后：

```ts
  openSettings: () => void;
  closeSettings: () => void;
  openNewConversation: () => void;
  closeNewConversation: () => void;
  toggleNewConversation: () => void;
  setSettingsSection: (section: SettingsSection | null) => void;
```

编辑 4 —— 初始化与动作实现。初始值区：

```ts
      settingsOpen: false,
      newConversationOpen: false,
      settingsSection: null,
```

动作实现区（替换原 openSettings/closeSettings 两行所在段落）：

```ts
      openSettings: () => set((s) => { s.settingsOpen = true; }),
      closeSettings: () => set((s) => { s.settingsOpen = false; }),
      openNewConversation: () => set((s) => { s.newConversationOpen = true; }),
      closeNewConversation: () => set((s) => { s.newConversationOpen = false; }),
      toggleNewConversation: () => set((s) => { s.newConversationOpen = !s.newConversationOpen; }),
      setSettingsSection: (section) => set((s) => { s.settingsSection = section; }),
```

`partialize` 保持原样不动（新字段天然不被持久化）。

- [ ] **Step 4: 跑测试确认绿**

Run: `pnpm vitest run src/stores/ui.store.test.ts src/stores/ui.settings.test.ts`
Expected: PASS（ui.settings.test.ts 既有 4 例不受影响）

- [ ] **Step 5: 提交**

```bash
git add src/stores/ui.store.ts src/stores/ui.store.test.ts
git commit -m "feat(store): 新增新建会话下拉开关与设置分区定向字段"
```

---

### Task 2: registry — workbench.newConversation 接线

**Files:**
- Modify: `src/commands/registry.ts:85-95`
- Test: `src/commands/registry.test.ts`（追加 1 例 + 1 行 import）

**Interfaces:**
- Consumes: Task 1 的 `useUiStore.getState().toggleNewConversation()`（registry.ts 已 import `useUiStore`，无需新增 import）
- Produces: `getCommand("workbench.newConversation")!.run()` 翻转下拉开关；KeybindingHost 分发链路零改动。既有断言 `comboToCanonical(getCommand("workbench.newConversation")?.defaultKey)` = `"primary+shift+keyn"` 保持不变。

- [ ] **Step 1: 写失败测试**

对 `src/commands/registry.test.ts`：第 3 行 import 区追加：

```ts
import { useUiStore } from "../stores/ui.store";
```

并在 `describe("command registry", ...)` 末尾追加用例：

```ts
  it("workbench.newConversation toggles the new-conversation dropdown flag", () => {
    useUiStore.setState({ newConversationOpen: false });
    getCommand("workbench.newConversation")!.run();
    expect(useUiStore.getState().newConversationOpen).toBe(true);
    getCommand("workbench.newConversation")!.run();
    expect(useUiStore.getState().newConversationOpen).toBe(false);
  });
```

- [ ] **Step 2: 跑测试确认红**

Run: `pnpm vitest run src/commands/registry.test.ts`
Expected: FAIL（新用例断言 `true` 得 `false`——run 仍是 no-op；既有 4 例仍绿）

- [ ] **Step 3: 接线 run**

替换 `src/commands/registry.ts` 中 `workbench.newConversation` 整条命令（第 85-95 行）为：

```ts
  {
    id: "workbench.newConversation",
    title: "新建会话",
    category: "会话",
    defaultKey: k("keyn", { primary: true, shift: true }),
    // 下拉由 TopBar 内的 NewConversationDropdown 受控渲染（ui.store.newConversationOpen
    // 为唯一事实源）；命令只翻转标志位，Ctrl/Cmd+Shift+N 即可全局开关。
    run: () => useUiStore.getState().toggleNewConversation(),
  },
```

- [ ] **Step 4: 跑测试确认绿**

Run: `pnpm vitest run src/commands/registry.test.ts`
Expected: PASS（5 例全绿，含唯一键位/默认键位既有断言——满足约束 5）

- [ ] **Step 5: 提交**

```bash
git add src/commands/registry.ts src/commands/registry.test.ts
git commit -m "feat(commands): 接线新建会话命令到下拉开关"
```

---

### Task 3: TopBar — 页签胶囊轮廓 + 溢出渐隐遮罩

**Files:**
- Modify: `src/features/layout/TopBar.tsx`（页签容器 L116 起 + TabsTrigger className L128）
- Test: `src/features/layout/TopBar.test.tsx`（Create）

**Interfaces:**
- Consumes: 无（纯 className；测试用真 store + setState 播种数据）
- Produces: `TopBar` 导出与 props 不变；TabsTrigger 携带下述新类集；页签外层容器变为 relative 包裹 + 内层滚动层（`overflow-x-auto scrollbar-none`）+ 左右常驻渐隐遮罩。本任务**不动** `+` 按钮与模态框（Task 5 处理）。

**背景（实测结论，勿改前缀）：** 激活态一切样式必须带 `group-data-[variant=line]/tabs-list:data-[state=active]:` 前缀，hover 背景必须带 `group-data-[variant=line]/tabs-list:hover:` 前缀——裸前缀会输给 `ui/tabs.tsx` 内置的 `bg-transparent`/`shadow-none`（见 Global Constraints 技术背景）。以下 className 已在浏览器实测生效，照抄。

- [ ] **Step 1: 写失败测试**

创建 `src/features/layout/TopBar.test.tsx`：

```tsx
/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

// TopBar 触碰 Tauri 窗口 API 与重子组件；全部打桩。被测的页签轮廓是纯
// className 逻辑，store 用真实例 + setState 播种。
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    startDragging: () => Promise.resolve(),
    toggleMaximize: () => Promise.resolve(),
    isFullscreen: () => Promise.resolve(false),
    onResized: () => Promise.resolve(() => {}),
  }),
}));
vi.mock("../projects/ProjectSelector", () => ({
  ProjectSelector: () => <div data-testid="project-selector" />,
}));
vi.mock("./WindowControls", () => ({ WindowControls: () => null }));
vi.mock("../agent/CloseTabConfirmDialog", () => ({
  CloseTabConfirmDialog: () => null,
}));

import { TopBar } from "./TopBar";
import { useProjectStore } from "../../stores/project.store";
import { useConversationStore } from "../../stores/conversation.store";

beforeEach(() => {
  useProjectStore.setState({
    projects: [{ id: "p1", name: "demo", path: "/tmp/demo", created_at: 0, last_opened: 0 }],
    activeProjectId: "p1",
  });
  useConversationStore.setState({
    conversationsByProject: {
      p1: [
        { id: "c1", project_id: "p1", title: "第一个会话", agent_type: "x", status: "active", created_at: 0, updated_at: 0 },
        { id: "c2", project_id: "p1", title: "第二个会话", agent_type: "x", status: "active", created_at: 0, updated_at: 0 },
      ],
    },
    tabsByProject: { p1: ["c1", "c2"] },
    activeTabByProject: { p1: "c1" },
  });
});
afterEach(() => cleanup());

describe("conversation tab outline (F5)", () => {
  it("active trigger carries capsule outline classes (glass bg, border, top highlight, left accent bar)", () => {
    render(<TopBar />);
    const active = screen.getByRole("tab", { name: /第一个会话/ });
    expect(active.className).toContain(
      "group-data-[variant=line]/tabs-list:data-[state=active]:bg-[var(--glass-2-surface)]"
    );
    expect(active.className).toContain(
      "group-data-[variant=line]/tabs-list:data-[state=active]:border-[color:var(--border-default)]"
    );
    expect(active.className).toContain(
      "group-data-[variant=line]/tabs-list:data-[state=active]:shadow-[inset_0_1px_0_0_rgba(255,255,255,0.06)]"
    );
    expect(active.className).toContain(
      "group-data-[variant=line]/tabs-list:data-[state=active]:before:w-0.5"
    );
    expect(active.className).toContain(
      "group-data-[variant=line]/tabs-list:data-[state=active]:before:opacity-100"
    );
    expect(active.className).toContain("rounded-[var(--radius-md)]");
    // line 变体内置 after 下划线保持关闭
    expect(active.className).toContain(
      "group-data-[variant=line]/tabs-list:data-[state=active]:after:opacity-0"
    );
  });

  it("legacy bottom-line shadow and small radius are gone", () => {
    render(<TopBar />);
    const active = screen.getByRole("tab", { name: /第一个会话/ });
    expect(active.className).not.toContain("shadow-[inset_0_-2px_0_0_var(--accent)]");
    expect(active.className).not.toContain("rounded-[var(--radius-sm)]");
  });

  it("inactive triggers keep transparent placeholder border + hover lift/bg/border", () => {
    render(<TopBar />);
    const inactive = screen.getByRole("tab", { name: /第二个会话/ });
    expect(inactive.className).toContain("border-transparent");
    expect(inactive.className).toContain("hover:-translate-y-px");
    expect(inactive.className).toContain(
      "group-data-[variant=line]/tabs-list:hover:bg-[var(--overlay-hover)]"
    );
    expect(inactive.className).toContain("hover:border-[color:var(--border-subtle)]");
    // 激活 hover 不位移的覆盖类也在同一 class 集里
    expect(inactive.className).toContain("data-[state=active]:hover:translate-y-0");
  });

  it("renders scrollbar-hidden overflow with left/right fade masks", () => {
    const { container } = render(<TopBar />);
    expect(container.innerHTML).toContain("overflow-x-auto scrollbar-none");
    expect(container.innerHTML).toContain("bg-gradient-to-r from-[var(--glass-1-surface)] to-transparent");
    expect(container.innerHTML).toContain("bg-gradient-to-l from-[var(--glass-1-surface)] to-transparent");
    expect(container.innerHTML).toContain("pointer-events-none");
  });
});
```

- [ ] **Step 2: 跑测试确认红**

Run: `pnpm vitest run src/features/layout/TopBar.test.tsx`
Expected: FAIL（轮廓类断言全部落空；遮罩断言落空）

- [ ] **Step 3: 重写页签容器（渐隐遮罩）**

对 `src/features/layout/TopBar.tsx` 做两次精确编辑（两段 old_string 均逐字取自现网文件，可直接粘贴；中间的 `<Tabs>`…`</Tabs>` 页签 map 段保持原样原缩进不动——JSX 缩进不敏感）。

编辑 A——容器开头（加 relative 包裹层 + 内层滚动层，空态文案中文化，约束 1）：

old_string：

```tsx
      {/* Conversation tabs */}
      <div className="flex items-center gap-1.5 flex-1 min-w-0 overflow-x-auto">
        {openTabs.length === 0 ? (
          <span className="text-xs text-[var(--text-tertiary)] px-2">No conversations</span>
```

new_string：

```tsx
      {/* Conversation tabs */}
      <div className="relative flex-1 min-w-0">
        <div className="flex items-center gap-1.5 overflow-x-auto scrollbar-none">
        {openTabs.length === 0 ? (
          <span className="text-xs text-[var(--text-tertiary)] px-2">暂无会话</span>
```

编辑 B——容器收尾（闭合内层滚动层 + 两个常驻渐隐遮罩 + 闭合 relative 包裹层）：

old_string：

```tsx
        )}
      </div>

      {/* Panel toggle */}
```

new_string：

```tsx
        )}
        </div>
        {/* 溢出渐隐遮罩：常驻（v1 不做滚动位置感知，YAGNI）。起始色＝TopBar 玻璃底。 */}
        <div className="pointer-events-none absolute inset-y-0 left-0 w-6 bg-gradient-to-r from-[var(--glass-1-surface)] to-transparent" />
        <div className="pointer-events-none absolute inset-y-0 right-0 w-6 bg-gradient-to-l from-[var(--glass-1-surface)] to-transparent" />
      </div>

      {/* Panel toggle */}
```

改完后该段结构为：relative 包裹层 → 内层滚动层（`overflow-x-auto scrollbar-none`，含空态 span 与 Tabs）→ 两个 `pointer-events-none` 绝对定位遮罩。

- [ ] **Step 4: 重写 TabsTrigger className（胶囊轮廓）**

编辑 `src/features/layout/TopBar.tsx`，将：

```tsx
                    className={`${isMac ? "h-7 text-xs " : ""}flex-none gap-2 rounded-[var(--radius-sm)] px-2.5 font-normal text-[var(--text-secondary)] transition-colors duration-150 hover:text-[var(--text-primary)] data-[state=active]:bg-[var(--glass-2-surface)] data-[state=active]:text-[var(--text-primary)] data-[state=active]:shadow-[inset_0_-2px_0_0_var(--accent)] group-data-[variant=line]/tabs-list:data-[state=active]:after:opacity-0`}
```

替换为（一行，照抄——每个激活态类都带 group-data 前缀，已实测生效）：

```tsx
                    className={`${isMac ? "h-7 text-xs " : ""}flex-none gap-2 rounded-[var(--radius-md)] border border-transparent px-2.5 font-normal text-[var(--text-secondary)] transition-all duration-150 hover:-translate-y-px hover:border-[color:var(--border-subtle)] group-data-[variant=line]/tabs-list:hover:bg-[var(--overlay-hover)] hover:text-[var(--text-primary)] data-[state=active]:hover:translate-y-0 group-data-[variant=line]/tabs-list:data-[state=active]:bg-[var(--glass-2-surface)] group-data-[variant=line]/tabs-list:data-[state=active]:border-[color:var(--border-default)] group-data-[variant=line]/tabs-list:data-[state=active]:text-[var(--text-primary)] group-data-[variant=line]/tabs-list:data-[state=active]:shadow-[inset_0_1px_0_0_rgba(255,255,255,0.06)] before:absolute before:left-0 before:top-1/4 before:bottom-1/4 before:w-0 before:rounded before:bg-[var(--accent)] before:opacity-0 before:transition-all before:duration-150 group-data-[variant=line]/tabs-list:data-[state=active]:before:w-0.5 group-data-[variant=line]/tabs-list:data-[state=active]:before:opacity-100 group-data-[variant=line]/tabs-list:data-[state=active]:after:opacity-0`}
```

类集释义（供 review）：
- 形状/占位：`rounded-[var(--radius-md)]` + `border border-transparent`（非激活透明占位边框，防布局抖动）+ `transition-all duration-150`
- 非激活 hover：`hover:-translate-y-px`（上浮 1px）+ `hover:border-[color:var(--border-subtle)]`（透明→显色）+ `group-data-[variant=line]/tabs-list:hover:bg-[var(--overlay-hover)]`（前缀压过内置 `bg-transparent`）+ `hover:text-[var(--text-primary)]`
- 激活：`group-data-...:data-[state=active]:bg-[var(--glass-2-surface)]`（玻璃面）+ `:border-[color:var(--border-default)]`（整圈描边）+ `:shadow-[inset_0_1px_0_0_rgba(255,255,255,0.06)]`（顶部极淡内高光）+ `:text-[var(--text-primary)]`；**旧底部线 `shadow-[inset_0_-2px_0_0_var(--accent)]` 已删**
- 激活 hover 不位移：`data-[state=active]:hover:translate-y-0`
- 左侧 2px 强调边：`before:` 伪元素（TabsTrigger 内置 `relative`），非激活 `before:w-0 before:opacity-0`，激活 `:before:w-0.5 :before:opacity-100`，`before:transition-all before:duration-150` 宽度/透明度过渡滑入
- after 下划线保持关闭：`group-data-[variant=line]/tabs-list:data-[state=active]:after:opacity-0`（twMerge 顶掉内置 opacity-100）

- [ ] **Step 5: 跑测试确认绿**

Run: `pnpm vitest run src/features/layout/TopBar.test.tsx`
Expected: PASS（4 例）

- [ ] **Step 6: 提交**

```bash
git add src/features/layout/TopBar.tsx src/features/layout/TopBar.test.tsx
git commit -m "feat(topbar): 对话页签胶囊轮廓与溢出渐隐遮罩"
```

---

### Task 4: NewConversationDropdown 组件 + SettingsDialog 分区定向

**Files:**
- Create: `src/features/projects/NewConversationDropdown.tsx`
- Test: `src/features/projects/NewConversationDropdown.test.tsx`（Create）
- Test: `src/features/settings/SettingsDialog.test.tsx`（Create）
- Modify: `src/features/settings/SettingsDialog.tsx`

**Interfaces:**
- Consumes: Task 1 的 `newConversationOpen`/`openNewConversation`/`closeNewConversation`/`toggleNewConversation`/`openSettings`/`setSettingsSection`/`SettingsSection`；`agent.store` 的 `servers`/`serversLoading`/`serversLoadedAt`/`loadAllServers`/`refreshRegistry`/`createSession`；`conversation.store` 的 `createConversation`/`closeTab`；`project.store` 的 `projects`/`activeProjectId`；`bridge/tauri` 类型 `Conversation`/`ServerDescriptor`/`SessionTarget`；`ui/dropdown-menu` 的 `DropdownMenu`/`DropdownMenuTrigger`/`DropdownMenuContent`/`DropdownMenuItem`/`DropdownMenuLabel`/`DropdownMenuSeparator`
- Produces: `<NewConversationDropdown triggerSize={"icon" | "icon-sm"} />` —— 渲染 `+` 触发按钮（ghost Button + `Plus size={14}`，外观与原 TopBar `+` 按钮一致）+ 受控面板。Task 5 在 TopBar 以 `<NewConversationDropdown triggerSize={iconSize} />` 挂载。

- [ ] **Step 1: 写失败测试（下拉组件）**

创建 `src/features/projects/NewConversationDropdown.test.tsx`：

```tsx
/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { NewConversationDropdown } from "./NewConversationDropdown";
import { useUiStore } from "../../stores/ui.store";
import { useAgentStore } from "../../stores/agent.store";
import { useConversationStore } from "../../stores/conversation.store";
import { useProjectStore } from "../../stores/project.store";
import type { Conversation, ServerDescriptor } from "../../bridge/tauri";

// 模块级可变 let 持有 mock action，beforeEach 经 setState 注入真 store
//（约束 4 模式的 zustand 变体：store 实例保持真实，只换动作，数据字段可断言）。
let createConversationMock: ReturnType<typeof vi.fn>;
let createSessionMock: ReturnType<typeof vi.fn>;
let closeTabMock: ReturnType<typeof vi.fn>;
let loadAllServersMock: ReturnType<typeof vi.fn>;
let refreshRegistryMock: ReturnType<typeof vi.fn>;

const realCloseNewConversation = useUiStore.getState().closeNewConversation;

const SERVER_CLAUDE: ServerDescriptor = {
  id: "claude-code", name: "Claude Code", version: "1.2.3",
  description: "Anthropic 的智能体", icon: null, kind: "registry",
};
const SERVER_CUSTOM: ServerDescriptor = {
  id: "my-agent", name: "My Agent", version: "",
  description: "", icon: null, kind: "custom",
};
const CONV: Conversation = {
  id: "conv-1", project_id: "p1", title: "新对话", agent_type: "claude-code",
  status: "active", created_at: 0, updated_at: 0,
};

beforeEach(() => {
  createConversationMock = vi.fn().mockResolvedValue(CONV);
  createSessionMock = vi.fn().mockResolvedValue("sess-1");
  closeTabMock = vi.fn();
  loadAllServersMock = vi.fn().mockResolvedValue(undefined);
  refreshRegistryMock = vi.fn().mockResolvedValue(undefined);

  useUiStore.setState({
    newConversationOpen: false,
    settingsOpen: false,
    settingsSection: null,
    closeNewConversation: realCloseNewConversation,
  });
  useProjectStore.setState({
    projects: [{ id: "p1", name: "demo", path: "/tmp/demo", created_at: 0, last_opened: 0 }],
    activeProjectId: "p1",
  });
  useAgentStore.setState({
    servers: [SERVER_CLAUDE, SERVER_CUSTOM],
    serversLoading: false,
    serversLoadedAt: Date.now(),
    error: null,
    createSession: createSessionMock,
    loadAllServers: loadAllServersMock,
    refreshRegistry: refreshRegistryMock,
  });
  useConversationStore.setState({
    createConversation: createConversationMock,
    closeTab: closeTabMock,
  });
});
afterEach(() => cleanup());

function openDropdown() {
  render(<NewConversationDropdown triggerSize="icon" />);
  fireEvent.click(screen.getByRole("button", { name: "新建会话" }));
}

describe("NewConversationDropdown", () => {
  it("the + trigger toggles the controlled panel", () => {
    render(<NewConversationDropdown triggerSize="icon" />);
    fireEvent.click(screen.getByRole("button", { name: "新建会话" }));
    expect(useUiStore.getState().newConversationOpen).toBe(true);
    expect(screen.getByText("选择智能体")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "新建会话" }));
    expect(useUiStore.getState().newConversationOpen).toBe(false);
  });

  it("clicking a registry row creates immediately and closes the panel", async () => {
    openDropdown();
    fireEvent.click(screen.getByText("Claude Code"));
    await waitFor(() =>
      expect(createConversationMock).toHaveBeenCalledWith("p1", "claude-code")
    );
    expect(createSessionMock).toHaveBeenCalledWith(
      "conv-1", { type: "registry", id: "claude-code" }, "/tmp/demo"
    );
    expect(useUiStore.getState().newConversationOpen).toBe(false);
  });

  it("custom kind maps to a custom session target", async () => {
    openDropdown();
    fireEvent.click(screen.getByText("My Agent"));
    await waitFor(() =>
      expect(createSessionMock).toHaveBeenCalledWith(
        "conv-1", { type: "custom", id: "my-agent" }, "/tmp/demo"
      )
    );
  });

  it("createConversation failure: inline error row, panel stays open, no session", async () => {
    createConversationMock.mockRejectedValue({ message: "创建失败" });
    openDropdown();
    fireEvent.click(screen.getByText("Claude Code"));
    await screen.findByText("创建失败");
    expect(useUiStore.getState().newConversationOpen).toBe(true);
    expect(createSessionMock).not.toHaveBeenCalled();
    expect(closeTabMock).not.toHaveBeenCalled();
  });

  it("rolls the tab back (closeTab) when a post-creation sync step fails", async () => {
    // 契约：标签已建之后的任何同步失败都必须回滚标签。
    useUiStore.setState({
      closeNewConversation: () => { throw new Error("store boom"); },
    });
    openDropdown();
    fireEvent.click(screen.getByText("Claude Code"));
    await screen.findByText("store boom");
    expect(closeTabMock).toHaveBeenCalledWith("conv-1");
  });

  it("anti-double-click: sibling rows are disabled while creating", async () => {
    let release: (v: Conversation) => void = () => {};
    createConversationMock.mockImplementation(
      () => new Promise<Conversation>((res) => { release = res; })
    );
    openDropdown();
    const row = screen.getByText("Claude Code").closest('[role="menuitem"]')!;
    fireEvent.click(row);
    const other = screen.getByText("My Agent").closest('[role="menuitem"]')!;
    expect(other.getAttribute("data-disabled")).toBe("");
    release(CONV);
    await waitFor(() => expect(createSessionMock).toHaveBeenCalled());
  });

  it("freshness guard: stale servers trigger loadAllServers on open", () => {
    useAgentStore.setState({ serversLoadedAt: Date.now() - 120_000 });
    render(<NewConversationDropdown triggerSize="icon" />);
    expect(loadAllServersMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "新建会话" }));
    expect(loadAllServersMock).toHaveBeenCalledTimes(1);
  });

  it("freshness guard: fresh servers skip the reload", () => {
    openDropdown();
    expect(loadAllServersMock).not.toHaveBeenCalled();
  });

  it("shows a loading row when empty and loading", () => {
    useAgentStore.setState({ servers: [], serversLoading: true });
    openDropdown();
    expect(screen.getByText("正在加载智能体列表…")).toBeTruthy();
  });

  it("shows empty hint + refresh when no servers", () => {
    useAgentStore.setState({ servers: [], serversLoading: false });
    openDropdown();
    expect(screen.getByText("暂无可用智能体")).toBeTruthy();
    const refreshButtons = screen.getAllByTitle("刷新智能体注册表");
    fireEvent.click(refreshButtons[0]);
    expect(refreshRegistryMock).toHaveBeenCalled();
  });

  it("'管理智能体…' targets the agents section and opens settings", () => {
    openDropdown();
    fireEvent.click(screen.getByText("管理智能体…"));
    expect(useUiStore.getState().settingsSection).toBe("agents");
    expect(useUiStore.getState().settingsOpen).toBe(true);
    expect(useUiStore.getState().newConversationOpen).toBe(false);
  });
});
```

- [ ] **Step 2: 写失败测试（SettingsDialog 定向）**

创建 `src/features/settings/SettingsDialog.test.tsx`：

```tsx
/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

// 六个分区组件各自依赖 store/时间线，全部打桩成可识别文本。
vi.mock("./sections/AppearanceSection", () => ({ AppearanceSection: () => <div data-testid="sec">外观</div> }));
vi.mock("./sections/EditorSection", () => ({ EditorSection: () => <div data-testid="sec">编辑器</div> }));
vi.mock("./sections/TerminalSection", () => ({ TerminalSection: () => <div data-testid="sec">终端</div> }));
vi.mock("./sections/AgentsSection", () => ({ AgentsSection: () => <div data-testid="sec">智能体</div> }));
vi.mock("./KeybindingsEditor", () => ({ KeybindingsEditor: () => <div data-testid="sec">快捷键</div> }));
vi.mock("./sections/LayoutSection", () => ({ LayoutSection: () => <div data-testid="sec">布局</div> }));
vi.mock("./recordingState", () => ({ isRecordingActive: () => false }));

import { SettingsDialog } from "./SettingsDialog";
import { useUiStore } from "../../stores/ui.store";

beforeEach(() => {
  useUiStore.setState({ settingsOpen: true, settingsSection: null });
});
afterEach(() => cleanup());

describe("SettingsDialog section targeting", () => {
  it("defaults to the appearance section", () => {
    render(<SettingsDialog />);
    expect(screen.getByTestId("sec").textContent).toBe("外观");
  });

  it("consumes a one-shot settingsSection on open", () => {
    useUiStore.setState({ settingsSection: "agents" });
    render(<SettingsDialog />);
    expect(screen.getByTestId("sec").textContent).toBe("智能体");
    expect(useUiStore.getState().settingsSection).toBeNull();
  });
});
```

- [ ] **Step 3: 跑测试确认红**

Run: `pnpm vitest run src/features/projects/NewConversationDropdown.test.tsx src/features/settings/SettingsDialog.test.tsx`
Expected: FAIL（`NewConversationDropdown` 模块不存在；SettingsDialog 不消费 settingsSection，第二例断言"智能体"得"外观"）

- [ ] **Step 4: 实现 SettingsDialog 定向消费**

对 `src/features/settings/SettingsDialog.tsx` 做三处编辑：

编辑 1 —— 首行 import：

```tsx
import { useState } from "react";
```
改为：
```tsx
import { useEffect, useState } from "react";
```

编辑 2 —— ui.store import 与 TabId 类型：

```tsx
import { useUiStore } from "../../stores/ui.store";
```
改为：
```tsx
import { useUiStore, type SettingsSection } from "../../stores/ui.store";
```

```tsx
type TabId = "appearance" | "editor" | "terminal" | "agents" | "keybindings" | "layout";
```
改为：
```tsx
type TabId = SettingsSection;
```

编辑 3 —— 组件体，`const [tab, setTab] = useState<TabId>("appearance");` 之后插入：

```tsx
  const settingsSection = useUiStore((s) => s.settingsSection);

  // 一次性定向（如新建会话下拉的"管理智能体…"）：打开时落到目标页签并立即清空，
  // 下次普通打开仍回到默认页签。
  useEffect(() => {
    if (open && settingsSection) {
      setTab(settingsSection);
      useUiStore.getState().setSettingsSection(null);
    }
  }, [open, settingsSection]);
```

- [ ] **Step 5: 实现 NewConversationDropdown 组件**

创建 `src/features/projects/NewConversationDropdown.tsx`：

```tsx
import { useEffect, useState } from "react";
import { Loader2, Plus, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { useAgentStore } from "../../stores/agent.store";
import { useConversationStore } from "../../stores/conversation.store";
import { useProjectStore } from "../../stores/project.store";
import { useUiStore } from "../../stores/ui.store";
import type { Conversation, ServerDescriptor, SessionTarget } from "../../bridge/tauri";

function errorMessage(err: unknown): string {
  if (
    err && typeof err === "object" && "message" in err &&
    typeof (err as { message: unknown }).message === "string"
  ) {
    return (err as { message: string }).message;
  }
  return String(err);
}

// 列表项 stagger 入场（前 12 条，tw-animate-css 的 fade-in；fill-mode 经 inline style）。
const ITEM_ENTER = "animate-in fade-in-0 duration-150";
// hover 左侧强调色条，与对话页签轮廓（F5）呼应。
const ITEM_ACCENT =
  "before:absolute before:left-0 before:top-1/4 before:bottom-1/4 before:w-0 before:rounded before:bg-[var(--accent)] before:opacity-0 before:transition-all before:duration-150 hover:before:w-0.5 hover:before:opacity-100";

interface Props {
  triggerSize: "icon" | "icon-sm";
}

export function NewConversationDropdown({ triggerSize }: Props) {
  const open = useUiStore((s) => s.newConversationOpen);
  const openNewConversation = useUiStore((s) => s.openNewConversation);
  const closeNewConversation = useUiStore((s) => s.closeNewConversation);
  const toggleNewConversation = useUiStore((s) => s.toggleNewConversation);
  const openSettings = useUiStore((s) => s.openSettings);
  const setSettingsSection = useUiStore((s) => s.setSettingsSection);
  const servers = useAgentStore((s) => s.servers);
  const serversLoading = useAgentStore((s) => s.serversLoading);
  const serversLoadedAt = useAgentStore((s) => s.serversLoadedAt);
  const loadAllServers = useAgentStore((s) => s.loadAllServers);
  const refreshRegistry = useAgentStore((s) => s.refreshRegistry);
  const createSession = useAgentStore((s) => s.createSession);
  const createConversation = useConversationStore((s) => s.createConversation);
  const closeTab = useConversationStore((s) => s.closeTab);
  const projects = useProjectStore((s) => s.projects);
  const activeProjectId = useProjectStore((s) => s.activeProjectId);
  const project = projects.find((p) => p.id === activeProjectId);

  const [creatingId, setCreatingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // 新鲜度守卫，写法同 AgentsSection：仅当列表为空或上次成功加载超过一分钟
  // 才在打开时回后端；刷新按钮不受此约束。
  useEffect(() => {
    if (!open) return;
    if (serversLoading) return;
    if (servers.length > 0 && Date.now() - serversLoadedAt < 60_000) return;
    void loadAllServers();
  }, [open, servers.length, serversLoading, serversLoadedAt, loadAllServers]);

  // 语义搬自旧 NewConversationModal.handleCreate：createConversation 立即开标签
  // → 关面板 → createSession 后台握手（失败写 agent.store 共享 error，现状一致）。
  // 拆成两段 try：建标签前的失败只出错误行；建标签后的任何同步失败回滚标签。
  const handleCreate = async (selected: ServerDescriptor) => {
    if (!project || creatingId) return;
    setCreatingId(selected.id);
    setError(null);
    let conv: Conversation;
    try {
      conv = await createConversation(project.id, selected.id);
    } catch (err) {
      setError(errorMessage(err));
      setCreatingId(null);
      return;
    }
    try {
      const target: SessionTarget =
        selected.kind === "custom"
          ? { type: "custom", id: selected.id }
          : { type: "registry", id: selected.id };
      setCreatingId(null);
      closeNewConversation();
      void createSession(conv.id, target, project.path).catch((err) => {
        useAgentStore.setState({ error: errorMessage(err) });
      });
    } catch (err) {
      closeTab(conv.id);
      setError(errorMessage(err));
      setCreatingId(null);
    }
  };

  return (
    <DropdownMenu
      open={open}
      onOpenChange={(o) => (o ? openNewConversation() : closeNewConversation())}
    >
      {/* + 按钮显式 toggle（与命令同一路径）；Radix 触发器自身的开合经
          onOpenChange 汇回同一 store 标志，两路计算同一目标值，不冲突。 */}
      <DropdownMenuTrigger asChild>
        <Button
          size={triggerSize}
          variant="ghost"
          aria-label="新建会话"
          onClick={toggleNewConversation}
        >
          <Plus size={14} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-[320px]">
        <div className="flex items-center justify-between gap-2 px-2 pt-1">
          <DropdownMenuLabel className="text-xs font-medium uppercase tracking-wide text-[var(--text-tertiary)]">
            选择智能体
          </DropdownMenuLabel>
          <Button
            variant="ghost"
            size="icon-xs"
            title="刷新智能体注册表"
            disabled={serversLoading}
            onClick={() => void refreshRegistry()}
          >
            <RotateCw size={12} className={serversLoading ? "animate-spin" : ""} />
          </Button>
        </div>

        <div className="max-h-72 overflow-y-auto py-1">
          {serversLoading && servers.length === 0 && (
            <div className="flex items-center gap-2 px-3 py-2 text-xs text-[var(--text-tertiary)]">
              <Loader2 size={12} className="animate-spin" />
              正在加载智能体列表…
            </div>
          )}
          {!serversLoading && servers.length === 0 && (
            <div className="flex items-center justify-between gap-2 px-3 py-2 text-xs text-[var(--text-tertiary)]">
              <span>暂无可用智能体</span>
              <Button
                variant="ghost"
                size="icon-xs"
                title="刷新智能体注册表"
                onClick={() => void refreshRegistry()}
              >
                <RotateCw size={12} />
              </Button>
            </div>
          )}
          {servers.map((s, i) => (
            <DropdownMenuItem
              key={s.id}
              disabled={creatingId !== null}
              // Radix 默认点 Item 即关菜单；关的时机由我们控制（成功即关、
              // 失败保持开），故阻止默认。
              onSelect={(e) => {
                e.preventDefault();
                void handleCreate(s);
              }}
              className={`${ITEM_ENTER} ${ITEM_ACCENT} flex-col items-start gap-0.5 px-3 py-2`}
              style={
                i < 12
                  ? { animationDelay: `${i * 20}ms`, animationFillMode: "both" }
                  : undefined
              }
            >
              <div className="flex w-full items-center gap-2">
                <span className="font-medium text-sm">{s.name}</span>
                {s.version && (
                  <span className="text-xs text-[var(--text-tertiary)]">v{s.version}</span>
                )}
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--overlay-ghost)] text-[var(--text-tertiary)]">
                  {s.kind === "custom" ? "自定义" : "注册表"}
                </span>
                {creatingId === s.id && (
                  <Loader2 size={12} className="ml-auto animate-spin text-[var(--accent)]" />
                )}
              </div>
              {s.description && (
                <div className="w-full text-xs text-[var(--text-tertiary)] truncate">
                  {s.description}
                </div>
              )}
            </DropdownMenuItem>
          ))}
        </div>

        {error && <p className="px-3 py-1.5 text-xs text-[var(--error)]">{error}</p>}

        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={(e) => {
            e.preventDefault();
            closeNewConversation();
            setSettingsSection("agents");
            openSettings();
          }}
        >
          管理智能体…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
```

- [ ] **Step 6: 跑测试确认绿**

Run: `pnpm vitest run src/features/projects/NewConversationDropdown.test.tsx src/features/settings/SettingsDialog.test.tsx`
Expected: PASS（下拉 11 例 + 弹窗 2 例）

- [ ] **Step 7: 提交**

```bash
git add src/features/projects/NewConversationDropdown.tsx src/features/projects/NewConversationDropdown.test.tsx src/features/settings/SettingsDialog.tsx src/features/settings/SettingsDialog.test.tsx
git commit -m "feat(conversation): 新建会话智能体下拉，点行即建"
```

---

### Task 5: TopBar 接线 + 删除 NewConversationModal

**Files:**
- Modify: `src/features/layout/TopBar.tsx`
- Delete: `src/features/projects/NewConversationModal.tsx`
- Test: `src/features/layout/TopBar.test.tsx`（整体重写为最终形态：F5 断言 + F6 集成例）

**Interfaces:**
- Consumes: Task 4 的 `<NewConversationDropdown triggerSize={...} />`；Task 1 的 store 字段
- Produces: TopBar 不再引用 `NewConversationModal`/`showNewConversation`；`grep -rn "NewConversationModal" src/` 与 `grep -rn "showNewConversation" src/` 均空。

- [ ] **Step 1: 写失败测试（整体重写 TopBar.test.tsx）**

用 Write 工具将 `src/features/layout/TopBar.test.tsx` 覆盖为最终形态（Task 3 的 F5 断言原样保留 + 新增 F6 集成 describe + 扩展 beforeEach）：

```tsx
/**
 * @vitest-environment jsdom
 */
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

// TopBar 触碰 Tauri 窗口 API 与重子组件；全部打桩。NewConversationDropdown
// 保持真实（本文件同时覆盖 F5 轮廓与 F6 接线）。
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    startDragging: () => Promise.resolve(),
    toggleMaximize: () => Promise.resolve(),
    isFullscreen: () => Promise.resolve(false),
    onResized: () => Promise.resolve(() => {}),
  }),
}));
vi.mock("../projects/ProjectSelector", () => ({
  ProjectSelector: () => <div data-testid="project-selector" />,
}));
vi.mock("./WindowControls", () => ({ WindowControls: () => null }));
vi.mock("../agent/CloseTabConfirmDialog", () => ({
  CloseTabConfirmDialog: () => null,
}));

import { TopBar } from "./TopBar";
import { getCommand } from "../../commands/registry";
import { useProjectStore } from "../../stores/project.store";
import { useConversationStore } from "../../stores/conversation.store";
import { useAgentStore } from "../../stores/agent.store";
import { useUiStore } from "../../stores/ui.store";
import type { Conversation, ServerDescriptor } from "../../bridge/tauri";

// 模块级可变 let 持有 mock action，beforeEach 经 setState 注入真 store。
let createConversationMock: ReturnType<typeof vi.fn>;
let createSessionMock: ReturnType<typeof vi.fn>;
let loadAllServersMock: ReturnType<typeof vi.fn>;
let refreshRegistryMock: ReturnType<typeof vi.fn>;

const SERVER_CLAUDE: ServerDescriptor = {
  id: "claude-code", name: "Claude Code", version: "1.2.3",
  description: "Anthropic 的智能体", icon: null, kind: "registry",
};

// mock 的 createConversation 与真实动作的副作用逐一对齐（conversationsByProject.unshift
// + tabs.push + 激活）——TopBar 的页签标题从 conversationsByProject 解析，漏掉 unshift
// 会让标题回退成 tab id，"新对话"断言必挂。
const fakeCreateConversation = async (projectId: string, agentType: string): Promise<Conversation> => {
  const conv: Conversation = {
    id: "conv-1", project_id: projectId, title: "新对话", agent_type: agentType,
    status: "active", created_at: 0, updated_at: 0,
  };
  useConversationStore.setState((s) => {
    if (!s.conversationsByProject[projectId]) s.conversationsByProject[projectId] = [];
    s.conversationsByProject[projectId].unshift(conv);
    const tabs = s.tabsByProject[projectId] ?? [];
    s.tabsByProject[projectId] = [...tabs, conv.id];
    s.activeTabByProject[projectId] = conv.id;
  });
  return conv;
};

beforeEach(() => {
  createConversationMock = vi.fn().mockImplementation(fakeCreateConversation);
  createSessionMock = vi.fn().mockResolvedValue("sess-1");
  loadAllServersMock = vi.fn().mockResolvedValue(undefined);
  refreshRegistryMock = vi.fn().mockResolvedValue(undefined);

  useUiStore.setState({ newConversationOpen: false });
  useProjectStore.setState({
    projects: [{ id: "p1", name: "demo", path: "/tmp/demo", created_at: 0, last_opened: 0 }],
    activeProjectId: "p1",
  });
  useConversationStore.setState({
    conversationsByProject: {
      p1: [
        { id: "c1", project_id: "p1", title: "第一个会话", agent_type: "x", status: "active", created_at: 0, updated_at: 0 },
        { id: "c2", project_id: "p1", title: "第二个会话", agent_type: "x", status: "active", created_at: 0, updated_at: 0 },
      ],
    },
    tabsByProject: { p1: ["c1", "c2"] },
    activeTabByProject: { p1: "c1" },
  });
  useAgentStore.setState({
    servers: [SERVER_CLAUDE],
    serversLoading: false,
    serversLoadedAt: Date.now(),
    error: null,
    createSession: createSessionMock,
    loadAllServers: loadAllServersMock,
    refreshRegistry: refreshRegistryMock,
  });
  useConversationStore.setState({
    createConversation: createConversationMock,
  });
});
afterEach(() => cleanup());

describe("conversation tab outline (F5)", () => {
  it("active trigger carries capsule outline classes (glass bg, border, top highlight, left accent bar)", () => {
    render(<TopBar />);
    const active = screen.getByRole("tab", { name: /第一个会话/ });
    expect(active.className).toContain(
      "group-data-[variant=line]/tabs-list:data-[state=active]:bg-[var(--glass-2-surface)]"
    );
    expect(active.className).toContain(
      "group-data-[variant=line]/tabs-list:data-[state=active]:border-[color:var(--border-default)]"
    );
    expect(active.className).toContain(
      "group-data-[variant=line]/tabs-list:data-[state=active]:shadow-[inset_0_1px_0_0_rgba(255,255,255,0.06)]"
    );
    expect(active.className).toContain(
      "group-data-[variant=line]/tabs-list:data-[state=active]:before:w-0.5"
    );
    expect(active.className).toContain(
      "group-data-[variant=line]/tabs-list:data-[state=active]:before:opacity-100"
    );
    expect(active.className).toContain("rounded-[var(--radius-md)]");
    expect(active.className).toContain(
      "group-data-[variant=line]/tabs-list:data-[state=active]:after:opacity-0"
    );
  });

  it("legacy bottom-line shadow and small radius are gone", () => {
    render(<TopBar />);
    const active = screen.getByRole("tab", { name: /第一个会话/ });
    expect(active.className).not.toContain("shadow-[inset_0_-2px_0_0_var(--accent)]");
    expect(active.className).not.toContain("rounded-[var(--radius-sm)]");
  });

  it("inactive triggers keep transparent placeholder border + hover lift/bg/border", () => {
    render(<TopBar />);
    const inactive = screen.getByRole("tab", { name: /第二个会话/ });
    expect(inactive.className).toContain("border-transparent");
    expect(inactive.className).toContain("hover:-translate-y-px");
    expect(inactive.className).toContain(
      "group-data-[variant=line]/tabs-list:hover:bg-[var(--overlay-hover)]"
    );
    expect(inactive.className).toContain("hover:border-[color:var(--border-subtle)]");
    expect(inactive.className).toContain("data-[state=active]:hover:translate-y-0");
  });

  it("renders scrollbar-hidden overflow with left/right fade masks", () => {
    const { container } = render(<TopBar />);
    expect(container.innerHTML).toContain("overflow-x-auto scrollbar-none");
    expect(container.innerHTML).toContain("bg-gradient-to-r from-[var(--glass-1-surface)] to-transparent");
    expect(container.innerHTML).toContain("bg-gradient-to-l from-[var(--glass-1-surface)] to-transparent");
    expect(container.innerHTML).toContain("pointer-events-none");
  });
});

describe("new-conversation dropdown wiring (F6)", () => {
  it("clicking + opens the dropdown; Esc closes it", async () => {
    render(<TopBar />);
    fireEvent.click(screen.getByRole("button", { name: "新建会话" }));
    expect(screen.getByText("选择智能体")).toBeTruthy();
    fireEvent.keyDown(document.body, { key: "Escape" });
    await waitFor(() => expect(screen.queryByText("选择智能体")).toBeNull());
    expect(useUiStore.getState().newConversationOpen).toBe(false);
  });

  it("Ctrl+Shift+N (command run) opens the dropdown", () => {
    render(<TopBar />);
    act(() => {
      getCommand("workbench.newConversation")!.run();
    });
    expect(screen.getByText("选择智能体")).toBeTruthy();
  });

  it("clicking an agent row creates a conversation and shows the tab immediately", async () => {
    render(<TopBar />);
    fireEvent.click(screen.getByRole("button", { name: "新建会话" }));
    fireEvent.click(screen.getByText("Claude Code"));
    await waitFor(() =>
      expect(createConversationMock).toHaveBeenCalledWith("p1", "claude-code")
    );
    expect(useUiStore.getState().newConversationOpen).toBe(false);
    expect(await screen.findByRole("tab", { name: /新对话/ })).toBeTruthy();
  });
});
```

- [ ] **Step 2: 跑测试确认红**

Run: `pnpm vitest run src/features/layout/TopBar.test.tsx`
Expected: FAIL（F6 三例红：TopBar 仍挂模态框，无 `+` aria-label「新建会话」按钮、点行不建会话；F5 四例保持绿）

- [ ] **Step 3: 接线 TopBar**

对 `src/features/layout/TopBar.tsx` 做四处编辑：

编辑 1 —— import 区：删除

```tsx
import { NewConversationModal } from "../projects/NewConversationModal";
```

并在 `import { CloseTabConfirmDialog } from "../agent/CloseTabConfirmDialog";` 之后加：

```tsx
import { NewConversationDropdown } from "../projects/NewConversationDropdown";
```

lucide import 中 `Plus` 不再使用：

```tsx
import { Plus, PanelRight } from "lucide-react";
```
改为：
```tsx
import { PanelRight } from "lucide-react";
```

编辑 2 —— 删除模态框本地 state：

```tsx
  const [showNewConversation, setShowNewConversation] = useState(false);
```
整行删除（`useState` import 保留——`pendingCloseId`/`closing`/`macFullscreen` 仍在用）。

编辑 3 —— `+` 按钮换成下拉组件：

```tsx
      {/* New conversation */}
      <Button size={iconSize} variant="ghost" onClick={() => setShowNewConversation(true)}>
        <Plus size={14} />
      </Button>
```
改为：
```tsx
      {/* New conversation: controlled dropdown, also opened by workbench.newConversation */}
      <NewConversationDropdown triggerSize={iconSize} />
```

（`iconSize` 推断为 `"icon-sm" | "icon"`，与组件 `triggerSize` 类型逐字一致。）

编辑 4 —— 删除模态框挂载行：

```tsx
      <NewConversationModal open={showNewConversation} onClose={() => setShowNewConversation(false)} />
```
整行删除。

- [ ] **Step 4: 删除模态框文件**

Run: `rm src/features/projects/NewConversationModal.tsx`

- [ ] **Step 5: 残留清零核对**

Run: `grep -rn "NewConversationModal\|showNewConversation" src/ || echo CLEAN`
Expected: 输出 `CLEAN`

- [ ] **Step 6: 跑测试确认绿**

Run: `pnpm vitest run src/features/layout/TopBar.test.tsx src/features/projects/NewConversationDropdown.test.tsx`
Expected: PASS（TopBar 7 例 + 下拉 11 例）

- [ ] **Step 7: 提交**

```bash
git add -A src/features/layout/TopBar.tsx src/features/layout/TopBar.test.tsx src/features/projects/NewConversationModal.tsx
git commit -m "refactor(topbar): 以受控下拉替换新建会话模态框"
```

---

### Task 6: 全量门槛 + 差异自检 + 手工冒烟

**Files:** 无新增（验证任务）

**Interfaces:**
- Consumes: Task 1-5 的全部产物
- Produces: 门槛三件套全绿的终态确认 + 手工冒烟结论

- [ ] **Step 1: 门槛三件套**

Run: `pnpm lint && pnpm build && pnpm test`
Expected: lint 仅既有 6 条 warning（0 error）；build（含 tsc -b 真实类型门槛）成功；全部测试绿。

- [ ] **Step 2: 残留与差异自检**

Run:
```bash
grep -rn "NewConversationModal\|showNewConversation" src/ || echo CLEAN-1
grep -rn "inset_0_-2px_0_0" src/ || echo CLEAN-2
```
Expected: `CLEAN-1` 与 `CLEAN-2` 均输出（旧底部线阴影类在 src 内零残留）。

核对改动文件集合与 File Structure 表逐行一致：`src/stores/ui.store.ts`、`src/stores/ui.store.test.ts`、`src/commands/registry.ts`、`src/commands/registry.test.ts`、`src/features/layout/TopBar.tsx`、`src/features/layout/TopBar.test.tsx`、`src/features/projects/NewConversationDropdown.tsx`、`src/features/projects/NewConversationDropdown.test.tsx`、`src/features/settings/SettingsDialog.tsx`、`src/features/settings/SettingsDialog.test.tsx`、删除 `src/features/projects/NewConversationModal.tsx`。无计划外文件。

- [ ] **Step 3: 手工冒烟（pnpm tauri dev）**

逐项过，全过才算完成：

1. `Ctrl+Shift+N` 打开下拉，再按一次关闭；`+` 按钮开合一致。
2. 点任一智能体行：新页签**立即**出现并激活，下拉随即关闭，状态点进入 starting/running（后台握手）；无任何中间选中态。
3. 激活页签：玻璃底 + 整圈描边 + 顶部极淡高光 + 左侧 2px 强调边；非激活 hover 上浮 1px + 显底 + 边框淡入；激活页签 hover 不位移。
4. 开 10+ 页签：横向滚动、滚动条不可见、左右渐隐遮罩常驻。
5. 停掉后端再点行：下拉内出现红字错误行，下拉保持打开，页签无残留幽灵标签；恢复后端后可重试成功。
6. 「管理智能体…」：设置弹窗打开并直接落在「智能体」分区；关闭后再次普通打开设置回到「外观」。
7. Esc / 点外部关闭下拉（Radix 自带）。
8. 开下拉后不操作等 1 分钟再开：列表静默重载一次（新鲜度守卫）。

- [ ] **Step 4: 无提交**

本任务不产生代码改动，不提交。若冒烟发现缺陷，回到对应 Task 修复并补测试后重新走门槛。
