# Plan 2：设置面修整 + 键位录制修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修掉 Plan 1 评审沉淀的设置面 / 键位录制缺陷（Esc 双关、mac 语义分歧、失焦静默、智能体重复加载、命名不诚实、陈旧注释），并先补齐 Plan 1 遗留的迁移行为测试。

**Architecture:** 不新增骨架，只修现有模块。新增一个极小的模块级标志 `recordingState.ts`（镜像既有 `keybindingHostState.ts` 模式）解决 radix 捕获层 Esc 双关；KeyRecorder 复用 `eventToLogicalCombo` 使录制语义与全局分发器完全一致；agent.store 加加载时间戳实现 TTL 守卫；其余为命名/注释/标签层卫生。

**Tech Stack:** React 19 + TypeScript + Zustand(immer/persist) + radix-ui Dialog + vitest(+jsdom, @testing-library/react) + pnpm

## Global Constraints

- 所有用户可见文案一律简体中文；代码、标识符、路径、提交信息用英文。
- 不引入新依赖。
- 门槛三件套：`pnpm lint` && `pnpm build` && `pnpm test`。注意 `pnpm tsc --noEmit` 在本仓库是 no-op（solution-style tsconfig，files:[]），**不得**当作类型门槛，真实类型检查在 `pnpm build` 的 tsc -b 段。
- 需要 DOM 的测试文件**第一行**必须是 docblock `/** @vitest-environment jsdom */`（其后才是注释/imports）。
- 键位 token 契约（`normalizeKeyToken`）：`Key[A-Z]`→code 小写（`keya`），`Digit[0-9]`→code 小写（`digit1`），其余 `key.toLowerCase()`（Space→`" "` 长度 1、逗号→`","`、Esc→`"escape"`）。
- C-1 防线：裸可打印字符（`length===1` 或 `/^key[a-z]$/` 或 `/^digit[0-9]$/`）绑定绝不放行输入框白名单旁路；放行需带 primary/alt 或键 token 非打印。本计划任何改动不得削弱该规则。
- 提交纪律（Plan 1 环境回滚事故教训）：commit 后必须在**同一条命令**里 `git log --oneline -1 && git rev-parse HEAD` 确认落盘；若遇到"报告的哈希不存在"，信 `git reflog` 与 `git cat-file -t`，不信报告。
- 提交信息格式沿用仓库习惯：`feat/fix/test/chore/refactor/perf(scope): 中文描述`（scope 英文、描述中文是现有风格，按此执行）。
- 测试 mock 模式沿用 `src/commands/KeybindingHost.test.tsx` 的模块级可变绑定 + `vi.mock` 工厂闭包（工厂体不得在定义时读取外部 let，只能在返回的闭包里延迟读取，避免 TDZ）。

---

## File Structure

| 文件 | 动作 | 职责 |
|---|---|---|
| `src/commands/registry.run.test.ts` | Create | editor.save/editor.close 的 run 逻辑直测（双 Esc 节奏、查找栏让行） |
| `src/commands/KeybindingHost.test.tsx` | Modify | +1 用例：对话框打开时白名单命令在输入框内也让行 |
| `src/stores/keybindings.store.test.ts` | Modify | +1 用例：setOverride 录到默认键时折叠删除覆盖 |
| `src/features/settings/recordingState.ts` | Create | 模块级"录制进行中"标志（set/is） |
| `src/features/settings/SettingsDialog.tsx` | Modify | DialogContent 挂 onEscapeKeyDown，录制中 preventDefault |
| `src/features/settings/SettingsDialog.test.tsx` | Create | 录制中 Esc 不关 / 非录制 Esc 关 |
| `src/features/settings/KeybindingsEditor.tsx` | Modify | KeyRecorder：platform 入组件体、复用 eventToLogicalCombo/isModifierOnly、onBlur 取消、焦点环、挂载置位 recordingState；pendingConflict 去死 id |
| `src/features/settings/KeybindingsEditor.test.tsx` | Create | 录制/拒绝/取消/失焦/mac 语义/冲突横幅/标志位 7 用例 |
| `src/stores/agent.store.ts` | Modify | +serversLoadedAt 时间戳，loadServers/loadAllServers 成功时打点 |
| `src/features/settings/sections/AgentsSection.tsx` | Modify | 挂载加载 TTL 守卫（60s）+ 三处文案中文化 + 根注释更新 |
| `src/features/settings/sections/AgentsSection.test.tsx` | Create | 空列表加载 / 新鲜不加载 / 陈旧加载 3 用例 |
| 14 个 `// src/...` 路径头文件 + 3 个 section + 2 个测试文件 | Modify | 注释清扫（Task 5 清单） |
| `src/commands/registry.ts` | Modify | view.toggleSettings → view.openSettings，run → openSettings() |
| `src/stores/ui.store.ts` | Modify | 删 toggleSettings |
| `src/stores/ui.settings.test.ts` | Modify | 改 open/close 两用例 |
| `src/commands/registry.test.ts` | Modify | 断言改 view.openSettings |
| `src/commands/types.ts` | Modify | labelKey 修 Space 分支；comboToCanonical 对 key 小写 |
| `src/commands/types.test.ts` | Modify | +2 用例 |
| `src/stores/keybindings.store.ts` | Modify | loaded 字段注释注记 |

---

### Task 1: 迁移行为测试（Plan 2 动工前必做，M-7）

**Files:**
- Create: `src/commands/registry.run.test.ts`
- Modify: `src/commands/KeybindingHost.test.tsx`（末尾追加 1 用例）
- Modify: `src/stores/keybindings.store.test.ts`（末尾追加 1 用例）

**Interfaces:**
- Consumes: `getCommand(id)`（`src/commands/registry.ts`）、`_resetCloseEscForTest()`（`src/commands/keybindingHostState.ts`）、`useKeybindingsStore.getState().setOverride`
- Produces: 无（纯测试）；但后续 Task 2/3 对 KeyRecorder 的改动将受这些测试保护

**背景**（给实现者）：`editor.close` 的 run 逻辑：查找栏打开时只记 Esc 节奏（`noteCloseEsc()`）然后让行 CodeMirror 关栏；否则 `noteCloseEsc()` 返回真（500ms 内第二次 Esc）才 `setEditorVisible(false)`，且关后节奏复位。`editor.save` 的 run：仅当激活文件 dirty 时 `saveFile()`。这些逻辑从 EditorPanel 迁出时没带直测，本任务补齐。

- [ ] **Step 1: 创建 registry.run.test.ts**

```tsx
/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Module-level mutable bindings; mock factories read them lazily (TDZ-safe),
// same pattern as KeybindingHost.test.tsx.
let setEditorVisible: ReturnType<typeof vi.fn>;
let fsState: {
  openFiles: { path: string; dirty: boolean }[];
  activePath: string | null;
  saveFile: ReturnType<typeof vi.fn>;
};
let findBarOpen = false;

vi.mock("../stores/ui.store", () => ({
  useUiStore: { getState: () => ({ setEditorVisible }) },
}));
vi.mock("../stores/fs.store", () => ({
  useFsStore: { getState: () => fsState },
}));
vi.mock("./editorKeybindings", () => ({
  isFindBarOpen: () => findBarOpen,
}));

import { getCommand } from "./registry";
import { _resetCloseEscForTest } from "./keybindingHostState";

const runClose = () => getCommand("editor.close")!.run();
const runSave = () => getCommand("editor.save")!.run();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(10_000);
  _resetCloseEscForTest();
  setEditorVisible = vi.fn();
  fsState = { openFiles: [], activePath: null, saveFile: vi.fn() };
  findBarOpen = false;
});
afterEach(() => {
  vi.useRealTimers();
});

describe("editor.close run — double-Esc cadence", () => {
  it("closes only on a second Esc within 500ms, then resets", () => {
    runClose();
    expect(setEditorVisible).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    runClose();
    expect(setEditorVisible).toHaveBeenCalledTimes(1);
    expect(setEditorVisible).toHaveBeenCalledWith(false);
    // 关闭后节奏复位：紧接着的单次 Esc 不再关
    vi.advanceTimersByTime(100);
    runClose();
    expect(setEditorVisible).toHaveBeenCalledTimes(1);
  });

  it("does not close when the second Esc lands outside the window", () => {
    runClose();
    vi.advanceTimersByTime(600);
    runClose();
    expect(setEditorVisible).not.toHaveBeenCalled();
  });

  it("find-bar open: yields without closing but keeps the cadence", () => {
    findBarOpen = true;
    runClose();
    expect(setEditorVisible).not.toHaveBeenCalled();
    // 查找栏被 CodeMirror 关闭后的下一记 Esc 仍在窗口内 → 关面板
    findBarOpen = false;
    vi.advanceTimersByTime(100);
    runClose();
    expect(setEditorVisible).toHaveBeenCalledWith(false);
  });
});

describe("editor.save run", () => {
  it("saves when the active file is dirty", () => {
    fsState.openFiles = [{ path: "/p/a.ts", dirty: true }];
    fsState.activePath = "/p/a.ts";
    runSave();
    expect(fsState.saveFile).toHaveBeenCalledTimes(1);
  });

  it("does nothing when the active file is clean", () => {
    fsState.openFiles = [{ path: "/p/a.ts", dirty: false }];
    fsState.activePath = "/p/a.ts";
    runSave();
    expect(fsState.saveFile).not.toHaveBeenCalled();
  });

  it("does nothing when no file is active", () => {
    fsState.openFiles = [{ path: "/p/a.ts", dirty: true }];
    fsState.activePath = null;
    runSave();
    expect(fsState.saveFile).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 运行新测试确认通过**

Run: `pnpm vitest run src/commands/registry.run.test.ts`
Expected: 6 passed

- [ ] **Step 3: KeybindingHost.test.tsx 追加对话框 + 输入框用例**

在 `describe("KeybindingHost", ...)` 块内、最后一个 `it` 之后追加：

```tsx
  it("yields allowlisted editor.save when a dialog is open, even from an input", () => {
    // 对话框优先于白名单：dlg 打开时 host 全让行，Esc 交给 radix、Ctrl+S 不触发
    const dlg = document.createElement("div");
    dlg.setAttribute("role", "dialog");
    document.body.appendChild(dlg);
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    fire(window, { key: "s", code: "KeyS", ctrlKey: true });
    expect(save).not.toHaveBeenCalled();
    dlg.remove();
  });
```

- [ ] **Step 4: keybindings.store.test.ts 追加回退默认折叠用例**

在 `describe("keybindings store", ...)` 块末尾追加：

```ts
  it("setOverride collapses to default when the combo equals the default", () => {
    // 先污染一个覆盖，再录回默认键（editor.save 默认 primary+keys）→ 覆盖应被删除
    useKeybindingsStore.setState({ overrides: { "editor.save": "primary+alt+keys" } });
    useKeybindingsStore.getState().setOverride("editor.save", { primary: true, key: "keys" });
    expect("editor.save" in useKeybindingsStore.getState().overrides).toBe(false);
  });
```

- [ ] **Step 5: 全量测试确认无回归**

Run: `pnpm test`
Expected: 全部通过（测试总数 = 80 + 6 + 1 + 1 = 88）

- [ ] **Step 6: Commit**

```bash
git add src/commands/registry.run.test.ts src/commands/KeybindingHost.test.tsx src/stores/keybindings.store.test.ts
git commit -m "test(commands): 键位骨架迁移行为测试（双 Esc 节奏 / 查找栏让行 / 对话框优先级 / 覆盖折叠）"
git log --oneline -1 && git rev-parse HEAD
```

---

### Task 2: 录制期 Esc 双关修复

**问题**：快捷键录制中按 Esc，radix 的 DismissableLayer 挂在 document 捕获阶段（先于 React 根合成事件），KeyRecorder 里的 `e.preventDefault()` 拦不住它，导致"取消录制"和"关闭整个设置弹窗"同时发生。修法：录制期间挂起对话框的 onEscapeKeyDown。

**Files:**
- Create: `src/features/settings/recordingState.ts`
- Modify: `src/features/settings/KeybindingsEditor.tsx`（仅 KeyRecorder 的挂载 effect）
- Modify: `src/features/settings/SettingsDialog.tsx`（DialogContent props）
- Create: `src/features/settings/SettingsDialog.test.tsx`

**Interfaces:**
- Produces: `setRecordingActive(v: boolean): void`、`isRecordingActive(): boolean`（Task 3 的失焦取消路径也依赖它保持同步）
- Consumes: radix DialogContent 的 `onEscapeKeyDown` prop（继承自 DismissableLayer；回调内 `event.preventDefault()` 会阻止关闭——radix 检查 `event.defaultPrevented`）

- [ ] **Step 1: 创建 recordingState.ts**

```ts
// Whether a KeyRecorder is currently waiting for a keypress. SettingsDialog
// reads this to suppress Radix's Esc-to-close while recording: the dismiss
// layer listens on document CAPTURE (before React's root handlers), so the
// recorder's own preventDefault cannot stop the dialog from closing.
let recording = false;

export function setRecordingActive(v: boolean): void {
  recording = v;
}

export function isRecordingActive(): boolean {
  return recording;
}
```

- [ ] **Step 2: KeyRecorder 挂载/卸载置位标志**

在 `KeybindingsEditor.tsx` 顶部 import 区加入：

```ts
import { setRecordingActive } from "./recordingState";
```

将 KeyRecorder 现有的：

```ts
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
```

替换为：

```ts
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    setRecordingActive(true);
    ref.current?.focus();
    return () => setRecordingActive(false);
  }, []);
```

- [ ] **Step 3: SettingsDialog 挂 onEscapeKeyDown**

在 `SettingsDialog.tsx` import 区加入：

```ts
import { isRecordingActive } from "./recordingState";
```

将：

```tsx
      <DialogContent className="sm:max-w-3xl h-[70vh] flex flex-col p-0 gap-0 overflow-hidden">
```

替换为：

```tsx
      <DialogContent
        className="sm:max-w-3xl h-[70vh] flex flex-col p-0 gap-0 overflow-hidden"
        onEscapeKeyDown={(e) => {
          // 录制快捷键期间挂起 Esc 关窗——这一记 Esc 属于录制器（取消录制）
          if (isRecordingActive()) e.preventDefault();
        }}
      >
```

- [ ] **Step 4: 创建 SettingsDialog.test.tsx**

```tsx
/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

// Sections pull in heavy stores (agent/tauri bridge); none are under test here.
vi.mock("./sections/AppearanceSection", () => ({ AppearanceSection: () => <div /> }));
vi.mock("./sections/EditorSection", () => ({ EditorSection: () => <div /> }));
vi.mock("./sections/TerminalSection", () => ({ TerminalSection: () => <div /> }));
vi.mock("./sections/AgentsSection", () => ({ AgentsSection: () => <div /> }));
vi.mock("./sections/LayoutSection", () => ({ LayoutSection: () => <div /> }));
vi.mock("./KeybindingsEditor", () => ({ KeybindingsEditor: () => <div /> }));

import { SettingsDialog } from "./SettingsDialog";
import { setRecordingActive } from "./recordingState";
import { useUiStore } from "../../stores/ui.store";

beforeEach(() => {
  useUiStore.setState({ settingsOpen: true });
});
afterEach(() => {
  useUiStore.setState({ settingsOpen: false });
  setRecordingActive(false);
});

describe("SettingsDialog Esc handling", () => {
  it("stays open on Esc while a key recording is active", () => {
    render(<SettingsDialog />);
    expect(screen.getByRole("dialog")).toBeTruthy();
    setRecordingActive(true);
    fireEvent.keyDown(document.body, { key: "Escape", code: "Escape" });
    expect(useUiStore.getState().settingsOpen).toBe(true);
  });

  it("closes on Esc when no recording is active", () => {
    render(<SettingsDialog />);
    fireEvent.keyDown(document.body, { key: "Escape", code: "Escape" });
    expect(useUiStore.getState().settingsOpen).toBe(false);
  });
});
```

环境注记：radix Dialog 在 jsdom 中通常可直接工作；若出现 `ResizeObserver` / `matchMedia` 未定义错误，在该测试文件顶部（docblock 之后、imports 之前）加最小 stub，例如 `class ResizeObserver { observe() {} unobserve() {} disconnect() {} }` 挂到 globalThis——但先不加，报错再补。

- [ ] **Step 5: 运行测试**

Run: `pnpm vitest run src/features/settings/SettingsDialog.test.tsx`
Expected: 2 passed

- [ ] **Step 6: 全量回归**

Run: `pnpm test`
Expected: 90 passed（88 + 2）

- [ ] **Step 7: Commit**

```bash
git add src/features/settings/recordingState.ts src/features/settings/KeybindingsEditor.tsx src/features/settings/SettingsDialog.tsx src/features/settings/SettingsDialog.test.tsx
git commit -m "fix(settings): 录制快捷键期间挂起设置弹窗的 Esc 关闭"
git log --oneline -1 && git rev-parse HEAD
```

---

### Task 3: KeyRecorder 加固（M-3 mac 语义 + M-4 失焦/焦点 + M-10 死字段）

**三个问题**：
1. **M-3**：录制器 `primary = ctrlKey || metaKey` 与全局分发器的 mac 语义（`eventToLogicalCombo`：mac 上仅 Cmd＝primary）不一致——mac 上录 `⌃K` 会存成 `⌘K`，物理动作与存储不符。修法：直接复用 `eventToLogicalCombo`，录制结果＝分发器匹配结果。
2. **M-4**：span 失焦后录制器看似活着但按键无处可去；且 `outline-none` 无焦点可视提示。修法：`onBlur` 取消录制；`outline-none` 之外加 `focus:ring`。
3. **M-10**：`pendingConflict.id` 只写不读。改存 `ConflictRef | null`。

**Files:**
- Modify: `src/features/settings/KeybindingsEditor.tsx`
- Create: `src/features/settings/KeybindingsEditor.test.tsx`

**Interfaces:**
- Consumes: `eventToLogicalCombo(e, platform)`、`isModifierOnly(e)`（`src/commands/types.ts`）；`setRecordingActive/isRecordingActive`（Task 2 产物）
- Produces: 无新导出；KeyRecorder 行为变化由测试锁定

**前置要求**：Task 2 已合入（KeyRecorder 的 effect 已含 `setRecordingActive`）。本任务在其基础上继续改同一 effect 之外的部分，勿覆盖 Task 2 的改动。

- [ ] **Step 1: 创建 KeybindingsEditor.test.tsx（先红）**

```tsx
/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";

// detectPlatform 在模块加载期被调用——用可变绑定 + 部分 mock 控制平台。
let platform: "mac" | "other" = "other";
vi.mock("../../commands/types", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../commands/types")>();
  return { ...actual, detectPlatform: () => platform };
});

const setMock = vi.fn();
const getMock = vi.fn();
vi.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: class {
    constructor() {}
    get = (...a: unknown[]) => getMock(...a);
    set = (...a: unknown[]) => setMock(...a);
  },
}));

import { KeybindingsEditor } from "./KeybindingsEditor";
import { useKeybindingsStore } from "../../stores/keybindings.store";
import { isRecordingActive } from "./recordingState";

beforeEach(() => {
  platform = "other";
  vi.clearAllMocks();
  getMock.mockResolvedValue(undefined);
  setMock.mockResolvedValue(undefined);
  useKeybindingsStore.setState({ loaded: true, overrides: {} });
});

/** 打开指定命令行的录制器，返回"请按键…" span。 */
function startRecording(commandTitle: string): HTMLElement {
  render(<KeybindingsEditor />);
  const row = screen.getByText(commandTitle).closest(".grid")!;
  fireEvent.click(within(row as HTMLElement).getByTitle("改键"));
  return screen.getByText("请按键…");
}

describe("KeybindingsEditor recording", () => {
  it("records a combo and stores the override", () => {
    const rec = startRecording("保存文件");
    fireEvent.keyDown(rec, { key: "k", code: "KeyK", ctrlKey: true });
    expect(useKeybindingsStore.getState().overrides["editor.save"]).toBe("primary+keyk");
    expect(screen.queryByText("请按键…")).toBeNull(); // 录制器已收起
  });

  it("rejects a bare printable key with a hint", () => {
    const rec = startRecording("保存文件");
    fireEvent.keyDown(rec, { key: "k", code: "KeyK" });
    expect(screen.getByText(/需包含 Ctrl/)).toBeTruthy();
    expect(useKeybindingsStore.getState().overrides["editor.save"]).toBeUndefined();
    expect(screen.getByText("请按键…")).toBeTruthy(); // 仍在录制
  });

  it("Escape cancels recording without saving and clears the flag", () => {
    const rec = startRecording("保存文件");
    expect(isRecordingActive()).toBe(true);
    fireEvent.keyDown(rec, { key: "Escape", code: "Escape" });
    expect(screen.queryByText("请按键…")).toBeNull();
    expect(useKeybindingsStore.getState().overrides["editor.save"]).toBeUndefined();
    expect(isRecordingActive()).toBe(false);
  });

  it("blur cancels recording (M-4)", () => {
    const rec = startRecording("保存文件");
    fireEvent.blur(rec);
    expect(screen.queryByText("请按键…")).toBeNull();
    expect(useKeybindingsStore.getState().overrides["editor.save"]).toBeUndefined();
    expect(isRecordingActive()).toBe(false);
  });

  it("mac: bare Ctrl is NOT primary — rejected as bare printable (M-3)", () => {
    platform = "mac";
    const rec = startRecording("保存文件");
    fireEvent.keyDown(rec, { key: "k", code: "KeyK", ctrlKey: true, metaKey: false });
    expect(screen.getByText(/需包含 Ctrl/)).toBeTruthy();
    expect(useKeybindingsStore.getState().overrides["editor.save"]).toBeUndefined();
  });

  it("mac: Cmd records as primary (M-3)", () => {
    platform = "mac";
    const rec = startRecording("保存文件");
    fireEvent.keyDown(rec, { key: "k", code: "KeyK", metaKey: true });
    expect(useKeybindingsStore.getState().overrides["editor.save"]).toBe("primary+keyk");
  });

  it("shows the conflict banner naming the other command (M-10)", () => {
    // editor.close 录成 editor.save 的默认键 primary+keys → 冲突横幅点名「保存文件」
    const rec = startRecording("关闭编辑器面板");
    fireEvent.keyDown(rec, { key: "s", code: "KeyS", ctrlKey: true });
    expect(screen.getByText(/该键位与「保存文件」冲突/)).toBeTruthy();
    expect(useKeybindingsStore.getState().overrides["editor.close"]).toBe("primary+keys");
  });
});
```

Run: `pnpm vitest run src/features/settings/KeybindingsEditor.test.tsx`
Expected: FAIL（mac 两用例与失焦用例必然失败；其余或过或红）

- [ ] **Step 2: 改造 KeybindingsEditor.tsx**

**2a. imports**：将

```ts
import { comboToCanonical, comboToLabel, detectPlatform, type KeyCombo } from "../../commands/types";
```

替换为：

```ts
import {
  comboToCanonical,
  comboToLabel,
  detectPlatform,
  eventToLogicalCombo,
  isModifierOnly,
  type KeyCombo,
  type Platform,
} from "../../commands/types";
```

**2b. platform 移入组件体**（使其在渲染期求值，测试可按用例切换）：删除模块级 `const platform = detectPlatform();`（约第 10 行），在 `KeybindingsEditor` 函数体第一行加入：

```ts
  const platform = detectPlatform();
```

**2c. pendingConflict 去死 id（M-10）**：将

```ts
  const [pendingConflict, setPendingConflict] = useState<{ id: string; conflict: ConflictRef } | null>(null);
```

替换为：

```ts
  const [pendingConflict, setPendingConflict] = useState<ConflictRef | null>(null);
```

onRecord 回调中：

```ts
                        const { conflict: c } = setOverride(cmd.id, combo);
                        setRecordingId(null);
                        if (c) setPendingConflict({ id: cmd.id, conflict: c });
```

改为：

```ts
                        const { conflict: c } = setOverride(cmd.id, combo);
                        setRecordingId(null);
                        if (c) setPendingConflict(c);
```

横幅：

```tsx
        <p className="text-xs text-[var(--warning)]">
          该键位与「{pendingConflict.conflict.commandTitle}」冲突，有自定义覆盖的命令优先响应。
        </p>
```

改为：

```tsx
        <p className="text-xs text-[var(--warning)]">
          该键位与「{pendingConflict.commandTitle}」冲突，有自定义覆盖的命令优先响应。
        </p>
```

**2d. KeyRecorder 传 platform + 重写 onKey + 失焦取消 + 焦点环**：将 KeyRecorder 调用处

```tsx
                    <KeyRecorder
                      onRecord={(combo) => {
```

改为（仅加一行 prop）：

```tsx
                    <KeyRecorder
                      platform={platform}
                      onRecord={(combo) => {
```

将整个 KeyRecorder 组件替换为：

```tsx
/** Records a single combo on the next non-modifier keydown; Esc or blur cancels. */
function KeyRecorder({
  platform,
  onRecord,
  onCancel,
}: {
  platform: Platform;
  onRecord: (c: KeyCombo) => void;
  onCancel: () => void;
}) {
  const [hint, setHint] = useState("请按键…");
  // autoFocus is a no-op on <span> (React only auto-focuses button/input/
  // select/textarea on mount), so focus imperatively after mount.
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    setRecordingActive(true);
    ref.current?.focus();
    return () => setRecordingActive(false);
  }, []);
  // Capture locally so the global host (which yields to dialogs) won't steal it.
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); onCancel(); return; }
    if (isModifierOnly(e)) return;
    e.preventDefault();
    // M-3: 与全局分发器共用同一归一化——录制结果即分发器能匹配的组合
    // （mac 上 Ctrl≠primary，仅 Cmd 是；录 ⌃K 不再被误存成 ⌘K）。
    const combo = eventToLogicalCombo(e, platform);
    if (!combo || combo.key === null) return;
    // C-1: 裸可打印字符（字母/数字/单字符标点）不允许无修饰绑定，避免全局吞键
    const isTypingKey =
      combo.key.length === 1 || /^key[a-z]$/.test(combo.key) || /^digit[0-9]$/.test(combo.key);
    if (isTypingKey && !combo.primary && !combo.alt) {
      setHint("快捷键需包含 Ctrl/⌘ 或 Alt，避免吞掉普通输入");
      return;
    }
    onRecord(combo);
  };
  return (
    // tabIndex + mount-time focus so it receives key events without a real
    // input element; blur cancels so a click elsewhere can't leave a
    // silent "recording" that swallows nothing (M-4).
    <span
      ref={ref}
      tabIndex={0}
      onKeyDown={onKey}
      onBlur={() => onCancel()}
      className="inline-block rounded-sm text-xs text-[var(--accent)] animate-pulse outline-none focus:ring-1 focus:ring-[var(--accent)]"
    >
      {hint}
    </span>
  );
}
```

**2e. 删除文件底部本地 normalize 函数**（`function normalize(code: string, key: string): string {...}` 整段删除——已被 eventToLogicalCombo 取代）。

- [ ] **Step 3: 运行 KeybindingsEditor 测试**

Run: `pnpm vitest run src/features/settings/KeybindingsEditor.test.tsx`
Expected: 7 passed

- [ ] **Step 4: 全量回归 + 门槛**

Run: `pnpm test && pnpm lint && pnpm build`
Expected: 97 passed（90 + 7）；lint 仅剩既有 6 条 warning、无 error；build 退出码 0

- [ ] **Step 5: Commit**

```bash
git add src/features/settings/KeybindingsEditor.tsx src/features/settings/KeybindingsEditor.test.tsx
git commit -m "fix(settings): 键位录制器复用分发器归一化 + 失焦取消 + 焦点环 + 冲突态瘦身"
git log --oneline -1 && git rev-parse HEAD
```

---

### Task 4: AgentsSection 陈旧守卫（M-6）+ 文案中文化（M-5）

**问题**：AgentsSection 每次挂载（＝每次打开智能体页签）无条件 `loadAllServers()`，一次后端往返且无陈旧守卫；另有三处英文用户文案违反全中文约束。

**Files:**
- Modify: `src/stores/agent.store.ts`
- Modify: `src/features/settings/sections/AgentsSection.tsx`
- Create: `src/features/settings/sections/AgentsSection.test.tsx`

**Interfaces:**
- Produces: `AgentState.serversLoadedAt: number`（0＝从未加载；loadServers/loadAllServers 成功后 `Date.now()` 打点）
- 守卫规则：`serversLoading` 时跳过；`servers.length > 0 && Date.now() - serversLoadedAt < 60_000` 时跳过；否则加载。刷新按钮（refreshRegistry → loadAllServers）不受守卫约束。

- [ ] **Step 1: 创建 AgentsSection.test.tsx（先红）**

```tsx
/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

// 受控假 store：组件以 useAgentStore() 解构方式消费。
const loadAllServers = vi.fn().mockResolvedValue(undefined);
let fakeAgent: {
  servers: { id: string; name: string; kind: string; version?: string; description?: string }[];
  serversLoading: boolean;
  serversLoadedAt: number;
};
vi.mock("../../../stores/agent.store", () => ({
  useAgentStore: () => ({
    ...fakeAgent,
    loadAllServers,
    refreshRegistry: vi.fn().mockResolvedValue(undefined),
    upsertCustom: vi.fn().mockResolvedValue(undefined),
    deleteCustom: vi.fn().mockResolvedValue(undefined),
  }),
}));

import { AgentsSection } from "./AgentsSection";

beforeEach(() => {
  vi.clearAllMocks();
  fakeAgent = { servers: [], serversLoading: false, serversLoadedAt: 0 };
});

const SERVER = { id: "s1", name: "测试智能体", kind: "registry" };

describe("AgentsSection mount loading (M-6)", () => {
  it("loads when the list is empty", () => {
    render(<AgentsSection />);
    expect(loadAllServers).toHaveBeenCalledTimes(1);
  });

  it("skips loading when the list is fresh (< 60s)", () => {
    fakeAgent = { servers: [SERVER], serversLoading: false, serversLoadedAt: Date.now() - 10_000 };
    render(<AgentsSection />);
    expect(loadAllServers).not.toHaveBeenCalled();
  });

  it("loads when the list is stale (≥ 60s)", () => {
    fakeAgent = { servers: [SERVER], serversLoading: false, serversLoadedAt: Date.now() - 70_000 };
    render(<AgentsSection />);
    expect(loadAllServers).toHaveBeenCalledTimes(1);
  });
});

describe("AgentsSection copy (M-5)", () => {
  it("uses Chinese labels for the registry controls", () => {
    fakeAgent = { servers: [{ ...SERVER, kind: "custom" }], serversLoading: false, serversLoadedAt: Date.now() };
    render(<AgentsSection />);
    expect(screen.getByTitle("刷新智能体注册表")).toBeTruthy();
    expect(screen.getByTitle("移除自定义智能体")).toBeTruthy();
  });
});
```

Run: `pnpm vitest run src/features/settings/sections/AgentsSection.test.tsx`
Expected: FAIL（守卫与文案用例红）

- [ ] **Step 2: agent.store 增 serversLoadedAt**

在 `interface AgentState`（或该 store 的状态接口）中，`serversLoading: boolean;` 之后加入：

```ts
  serversLoading: boolean;
  /** 上次成功加载 servers 的时间戳（0＝从未加载）。 */
  serversLoadedAt: number;
```

初始化对象中 `serversLoading: false,` 之后加入：

```ts
    serversLoadedAt: 0,
```

`loadServers` 的成功分支：

```ts
        const servers = await agentListServers();
        set((s) => {
          s.servers = servers;
        });
```

改为：

```ts
        const servers = await agentListServers();
        set((s) => {
          s.servers = servers;
          s.serversLoadedAt = Date.now();
        });
```

`loadAllServers` 的成功分支做同样修改（`s.serversLoadedAt = Date.now();`）。`refreshRegistry` 不打点（它不刷新 servers 列表本身，后续 load 会打点）。

- [ ] **Step 3: AgentsSection 守卫 + 文案**

解构加入 `serversLoadedAt`：

```ts
  const { servers, serversLoading, serversLoadedAt, loadAllServers, refreshRegistry, upsertCustom, deleteCustom } = useAgentStore();
```

将挂载 effect：

```ts
  // The side panel only mounts this tab when it is active; load the merged
  // agent list on mount (idempotent if another surface already loaded it).
  useEffect(() => { void loadAllServers(); }, [loadAllServers]);
```

替换为：

```ts
  // 页签激活才挂载本组件。仅当列表为空或上次加载超过一分钟才回后端，
  // 避免每次切到本页签都往返一次；刷新按钮不受此守卫约束。
  useEffect(() => {
    if (serversLoading) return;
    if (servers.length > 0 && Date.now() - serversLoadedAt < 60_000) return;
    void loadAllServers();
  }, [servers.length, serversLoading, serversLoadedAt, loadAllServers]);
```

文案三处：

1. `setError("A name and a command are required for a custom server.");` → `setError("自定义智能体需要填写名称和命令。");`
2. 刷新按钮 `title="Refresh agent registry"` → `title="刷新智能体注册表"`
3. 删除按钮 `title="Remove custom server"` → `title="移除自定义智能体"`

section 根注释：

```tsx
    // ③ Agents — reuses the agent store; no new backend.
```

→

```tsx
    // 复用 agent store；无独立后端。
```

- [ ] **Step 4: 运行测试**

Run: `pnpm vitest run src/features/settings/sections/AgentsSection.test.tsx`
Expected: 4 passed

- [ ] **Step 5: 全量回归**

Run: `pnpm test`
Expected: 101 passed（97 + 4）

- [ ] **Step 6: Commit**

```bash
git add src/stores/agent.store.ts src/features/settings/sections/AgentsSection.tsx src/features/settings/sections/AgentsSection.test.tsx
git commit -m "perf(settings): 智能体列表挂载加载加 60s 陈旧守卫 + 页签文案中文化"
git log --oneline -1 && git rev-parse HEAD
```

---

### Task 5: 陈旧注释清扫（M-9）

**Files:**（全部为 Modify，逐处精确替换）
- 删除 14 个文件的 `// src/...` 路径头注释行：
  `src/stores/keybindings.store.ts`、`src/stores/keybindings.store.test.ts`、`src/commands/editorKeybindings.test.ts`、`src/commands/editorKeybindings.ts`、`src/commands/integration.test.tsx`（第 4 行，docblock 之后）、`src/commands/KeybindingHost.test.tsx`（第 4 行，docblock 之后）、`src/commands/KeybindingHost.tsx`、`src/commands/keybindingHostState.ts`、`src/features/settings/SettingsDialog.tsx`、`src/commands/types.ts`、`src/commands/registry.test.ts`、`src/commands/types.test.ts`、`src/features/settings/KeybindingsEditor.tsx`、`src/commands/registry.ts`
- Modify: `src/features/settings/sections/TerminalSection.tsx`
- Modify: `src/features/settings/sections/AppearanceSection.tsx`
- Modify: `src/features/settings/sections/LayoutSection.tsx`
- Modify: `src/commands/editorKeybindings.test.ts`（注释矛盾 + 断言收紧）
- Modify: `src/stores/fs.store.editor.test.ts`（pin 注释统一）

**判定标准**：注释要么描述当下事实，要么删除；不得含"task N"/"this commit"/"follows in"之类的时点词。

- [ ] **Step 1: 删除路径头**

对上述 14 个文件，删除内容为该文件自身路径的 `// src/...` 单行注释（对两个测试文件，该行在 jsdom docblock 之后，删除时保留 docblock 完整）。逐一执行后验证：

Run: `grep -rn "^// src/" src/ | wc -l`（Git Bash）
Expected: `0`

- [ ] **Step 2: section 注释去时点词**

TerminalSection.tsx：

```tsx
    // ② Terminal — values persist now; xterm wiring follows in task 8.
```

→

```tsx
    // 终端偏好；新打开的终端实例读取这些值。
```

AppearanceSection.tsx：

```tsx
    // ① Appearance — CSS-only this commit; OS glass re-tint lands later.
```

→

```tsx
    // 主题经 CSS 变量生效；系统玻璃染色的自动同步尚未实现。
```

LayoutSection.tsx：

```tsx
    // ④ Layout — sizes only; panel visibility is never touched.
```

→

```tsx
    // 仅重置尺寸，从不改面板可见性。
```

- [ ] **Step 3: editorKeybindings.test.ts 注释矛盾修正**

该文件 mock 了 `searchPanelOpen: () => true`，但第二个用例的注释声称"on an empty state is false"，与 mock 矛盾。将：

```ts
  it("delegates to the registered view", () => {
    registerFindBarAccessor(() => ({ state: {} } as never));
    // searchPanelOpen on an empty state is false; assert wiring returns a boolean.
    expect(typeof isFindBarOpen()).toBe("boolean");
  });
```

替换为：

```ts
  it("delegates to the registered view", () => {
    registerFindBarAccessor(() => ({ state: {} } as never));
    // searchPanelOpen is mocked to always return true; assert the accessor forwards it.
    expect(isFindBarOpen()).toBe(true);
  });
```

- [ ] **Step 4: fs.store.editor.test.ts pin 注释统一**

在 `src/stores/fs.store.editor.test.ts` 中找到 T11 修复时加入的、围绕 `openFile(path, true)` 的三处注释，将每处统一为同一句：

```ts
      // pin:true —— 固定标签，避免被预览模式（未固定单开）替换
```

（若现有注释已表达此语义但措辞不一，改为统一措辞；不得改动断言。）

- [ ] **Step 5: 验证**

Run: `pnpm test && pnpm lint`
Expected: 101 passed（断言收紧不改数量）；lint 无新增 error

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: 清理路径头与时点性陈旧注释、修测试注释与 mock 矛盾"
git log --oneline -1 && git rev-parse HEAD
```

---

### Task 6: view.toggleSettings → view.openSettings（M-2 命名诚实化）

**问题**：`Ctrl+,` 只能开不能关设置弹窗（对话框打开时 host 全让行，`toggleSettings` 的"关"半永不可达），命令名不副实。修法：改名 `view.openSettings`、run 调 `openSettings()`、从 ui.store 删除 `toggleSettings`。关闭由 Esc/遮罩承担（radix）。既有 `keybindings.json` 里针对旧 id 的覆盖会变成惰性条目（resolve 只查已注册命令，无副作用）——本特性刚发布，可接受。

**Files:**
- Modify: `src/commands/registry.ts`
- Modify: `src/stores/ui.store.ts`
- Modify: `src/stores/ui.settings.test.ts`
- Modify: `src/commands/registry.test.ts`

- [ ] **Step 1: registry.ts 改名**

将：

```ts
  {
    id: "view.toggleSettings",
    title: "打开设置",
    category: "视图",
    defaultKey: k(",", { primary: true }),
    run: () => useUiStore.getState().toggleSettings(),
  },
```

替换为：

```ts
  {
    id: "view.openSettings",
    title: "打开设置",
    category: "视图",
    defaultKey: k(",", { primary: true }),
    // 只有"打开"：关闭交给 Esc/遮罩（radix）。对话框打开时 host 全让行，
    // 一个"切换"命令的关半永远不可达，故命名为 open。
    run: () => useUiStore.getState().openSettings(),
  },
```

- [ ] **Step 2: ui.store.ts 删 toggleSettings**

从 `interface UiState` 删除：

```ts
  toggleSettings: () => void;
```

从实现删除：

```ts
      toggleSettings: () => set((s) => { s.settingsOpen = !s.settingsOpen; }),
```

- [ ] **Step 3: ui.settings.test.ts 改 open/close**

将：

```ts
describe("ui.store settings dialog flag", () => {
  it("opens, closes, toggles settings", () => {
    useUiStore.setState({ settingsOpen: false });
    useUiStore.getState().openSettings();
    expect(useUiStore.getState().settingsOpen).toBe(true);
    useUiStore.getState().toggleSettings();
    expect(useUiStore.getState().settingsOpen).toBe(false);
    useUiStore.getState().toggleSettings();
    expect(useUiStore.getState().settingsOpen).toBe(true);
    useUiStore.getState().closeSettings();
    expect(useUiStore.getState().settingsOpen).toBe(false);
  });
});
```

替换为：

```ts
describe("ui.store settings dialog flag", () => {
  it("opens and closes settings", () => {
    useUiStore.setState({ settingsOpen: false });
    useUiStore.getState().openSettings();
    expect(useUiStore.getState().settingsOpen).toBe(true);
    useUiStore.getState().closeSettings();
    expect(useUiStore.getState().settingsOpen).toBe(false);
  });
});
```

- [ ] **Step 4: registry.test.ts 断言改名**

`expect(byId("view.toggleSettings")).toBe("primary+,");` → `expect(byId("view.openSettings")).toBe("primary+,");`

- [ ] **Step 5: 全仓扫描残留引用**

Run: `grep -rn "toggleSettings\|view.toggleSettings" src/ || echo "CLEAN"`
Expected: `CLEAN`

- [ ] **Step 6: 全量门槛**

Run: `pnpm test && pnpm lint && pnpm build`
Expected: 101 passed（用例数不变，一个被重写）；lint 无新增 error；build 退出码 0

- [ ] **Step 7: Commit**

```bash
git add src/commands/registry.ts src/stores/ui.store.ts src/stores/ui.settings.test.ts src/commands/registry.test.ts
git commit -m "refactor(commands): view.toggleSettings → view.openSettings（关闭交给 Esc/遮罩）"
git log --oneline -1 && git rev-parse HEAD
```

---

### Task 7: types 卫生（Space 标签 + canonical 小写归一 + loaded 注记）

**三个小项**：
1. `labelKey` 的 `if (token === "space")` 是死分支——token 化永不产生 `"space"`（Space 键的 `event.key` 是字面空格，token＝`" "`），导致 `Ctrl+Space` 的标签渲染成 `Ctrl+ `。改为匹配字面 `" "`。
2. `comboToCanonical` 不对 `c.key` 小写——所有组合创建点已小写，但手改 `keybindings.json` 注入 `"primary+KeyS"` 会形成死绑定（匹配不上事件归一化结果）。在 canonical 化时统一小写，使手改 JSON 大小写不敏感。
3. `keybindings.store` 的 `loaded` 字段仅测试 mock 在用——保留（维持 mock 形状稳定），注释注记。

**Files:**
- Modify: `src/commands/types.ts`
- Modify: `src/commands/types.test.ts`
- Modify: `src/stores/keybindings.store.ts`

- [ ] **Step 1: types.test.ts 加两用例（先红）**

在 types.test.ts 中（确认已 import `comboToCanonical`、`comboToLabel`，缺则补）追加：

```ts
  it('labels the literal-space token as "Space"', () => {
    // Space 键的 event.key 是 " "，normalizeKeyToken 得 token=" "（非 "space"）
    expect(comboToLabel({ key: " " }, "other")).toBe("Space");
    expect(comboToLabel({ primary: true, key: " " }, "other")).toBe("Ctrl+Space");
  });

  it("canonical form lowercases the key token (case-insensitive hand-edited JSON)", () => {
    expect(comboToCanonical({ primary: true, key: "KeyS" })).toBe("primary+keys");
    expect(comboToCanonical({ key: "Escape" })).toBe("escape");
  });
```

Run: `pnpm vitest run src/commands/types.test.ts`
Expected: 两条新用例 FAIL

- [ ] **Step 2: 修 labelKey 死分支**

`src/commands/types.ts`：

```ts
  if (token === "space") return "Space";
```

→

```ts
  if (token === " ") return "Space";
```

- [ ] **Step 3: comboToCanonical 小写归一**

```ts
  parts.push(c.key);
```

→

```ts
  parts.push(c.key.toLowerCase());
```

- [ ] **Step 4: keybindings.store loaded 注记**

`src/stores/keybindings.store.ts` 接口中：

```ts
interface KeybindingsState {
  loaded: boolean;
```

→

```ts
interface KeybindingsState {
  /** load() 完成后置位。当前仅测试 mock 消费；保留以维持 mock 形状稳定。 */
  loaded: boolean;
```

- [ ] **Step 5: 验证**

Run: `pnpm test && pnpm lint && pnpm build`
Expected: 103 passed（101 + 2）；lint 无新增 error；build 退出码 0

- [ ] **Step 6: Commit**

```bash
git add src/commands/types.ts src/commands/types.test.ts src/stores/keybindings.store.ts
git commit -m "fix(commands): Space 键标签修正 + canonical 键名小写归一 + loaded 字段注记"
git log --oneline -1 && git rev-parse HEAD
```

---

### Task 8: 全量验证 + 手工冒烟清单

**Files:** 无代码改动；产出验证报告。

- [ ] **Step 1: 三门槛**

Run: `pnpm lint && pnpm build && pnpm test`
Expected: lint 仅既有 6 条 warning、无 error；build 退出码 0；tests 全绿（103）

- [ ] **Step 2: 差异自检**

Run: `git diff main --stat`
核对：改动文件集与 File Structure 表一致，无意外文件。

- [ ] **Step 3: 输出手工冒烟清单（写入报告文件）**

桌面端 `pnpm tauri dev`，逐项核对：

1. 设置 → 快捷键页签 → 点「改键」进入录制 → 按 `Esc`：**只取消录制**，设置弹窗保持打开（Plan 1 是双关）
2. 录制中点击弹窗外任意位置（失焦）：录制自动取消
3. 录制器有可见焦点环（accent 色细环）
4. mac（若有）：录制 `⌃K` 被拒并提示需修饰键；`⌘K` 录成 `⌘K` 且立即生效
5. 设置 → 智能体页签：首次打开加载一次；60 秒内反复切入切出**不再**触发后端请求（观察 devtools 网络/后端日志）；刷新按钮始终可用
6. 智能体页签无英文残留（按钮 tooltip、校验错误提示均为中文）
7. `Ctrl+,` 开设置；关只能靠 Esc/遮罩/×（与命名一致）
8. 快捷键列表中绑过 Space 相关组合的命令（若无则临时录一个 `Ctrl+Space`）标签显示为 `Ctrl+Space` 而非 `Ctrl+ `
9. 双 Esc 关编辑器面板节奏、`Ctrl+S` 输入框内保存行为与 Plan 1 冒烟一致（M-7 测试已锁定，回归确认）

- [ ] **Step 4: Commit（仅当 Step 3 暴露问题并修复后；否则跳过）**

若冒烟发现缺陷：修复 → 重跑 Step 1 → 提交 `fix(settings): 冒烟发现：<具体>`。
