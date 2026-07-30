# 快捷键骨架 + 设置弹窗（含快捷键页签） Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立集中式命令注册表 + 可改键服务 + 全局按键分发器，把设置从侧栏页签迁移为带竖向页签的弹窗，并在弹窗中提供 VSCode 风格的快捷键编辑器；同时把 EditorPanel 现有的 `Ctrl+S`/双 `Esc` 迁移到该骨架。

**Architecture:** 命令以静态注册表描述（id/title/category/默认键/when/run），`run`/`when` 在调用时通过各 store 的 `getState()` 读取实时状态。用户改键以覆盖表持久化到 `keybindings.json`（沿用 settings 的 `LazyStore` 模式，非 zustand persist）。`KeybindingHost` 在 `App.tsx` 以 `window` 捕获阶段单点监听，归一化按键→匹配命令→校验 `when`→执行；焦点在输入框/弹窗时让行（白名单除外）。设置弹窗用左竖向 nav + 右内容，五个页签＝外观/编辑器/终端/智能体（现有四块原样搬移）+ 快捷键（新编辑器）。

**Tech Stack:** React 19、Zustand + immer、`@tauri-apps/plugin-store` 的 `LazyStore`、radix-ui（dialog）、lucide-react、vitest + @testing-library/react、Tailwind v4（CSS 变量主题）。**不新增运行时依赖。**

**Spec:** `docs/superpowers/specs/2026-07-30-vscode-ux-alignment-design.md`（§1 骨架 + F1 设置结构；F1 视觉精修在 Plan 2）。

## Global Constraints

- 不新增 npm 运行时依赖；仅用现有栈。
- 组合键 canonical 形式：修饰符按 `primary,alt,shift` 顺序 + 键 token，小写，`+` 连接；例 `ctrl+shift+keyf`、`primary+keyb`。`primary`＝win/linux 的 Ctrl、mac 的 Cmd。
- 平台检测：`navigator.platform`/`userAgent` 含 `Mac` 视为 mac（沿用 `TopBar.tsx` 写法）。
- 持久化键名固定：覆盖表存 `keybindings.json`，单键 `"overrides"`，值为 `Record<commandId, string|null>`（canonical 串或 `null`＝解绑）。
- 显示标签：mac `primary→⌘ alt→⌥ shift→⇧`；win/linux `primary→Ctrl alt→Alt shift→Shift`。键 token 的 `keyX`→大写 X，其余原样。
- 所有面向用户文案沿用现有语言习惯（设置项中文，命令标题可中文，技术 id 英文）。
- 每个 Task 结束提交；提交信息用 `feat:`/`refactor:`/`test:` 前缀 + 中文描述，结尾带 `Co-Authored-By: Claude <noreply@anthropic.com>`。
- 测试运行：`pnpm test`（vitest run）；类型/构建：`pnpm build`（`tsc -b && vite build`）；lint：`pnpm lint`。

---

## File Structure

- Create `src/commands/types.ts` — `KeyCombo`/`Platform`/`Command` 类型 + combo↔canonical↔label 纯函数 + 平台检测。
- Create `src/commands/registry.ts` — 命令注册表 + 种子命令 + `getCommand`/`listCommands`。
- Create `src/commands/editorKeybindings.ts` — EditorPanel 查找栏访问器注册（供 `editor.close` 的 when/run 查询）。
- Create `src/commands/keybindingHostState.ts` — 双 Esc 时间戳状态（供 `editor.close` 与单测）。
- Create `src/stores/keybindings.store.ts` — 覆盖表 + resolve/setOverride/reset/conflicts + `LazyStore` 持久化 + load。
- Create `src/commands/KeybindingHost.tsx` — 全局捕获阶段分发器（无 UI）。
- Create `src/features/settings/KeybindingsEditor.tsx` — 快捷键编辑器（搜索表 + 录制 + 重置 + 冲突角标）。
- Create `src/features/settings/SettingsDialog.tsx` — 弹窗壳 + 左竖向 nav + 页签路由。
- Create `src/features/settings/sections/AppearanceSection.tsx`、`EditorSection.tsx`、`TerminalSection.tsx`、`AgentsSection.tsx` — 从现 `SettingsPanel.tsx` 原样拆出。
- Delete `src/features/settings/SettingsPanel.tsx` — 被 dialog + sections 取代。
- Modify `src/stores/ui.store.ts` — 增 `settingsOpen` + open/close/toggle（**不**持久化）。
- Modify `src/features/layout/IconBar.tsx` — 齿轮改调 `openSettings()`。
- Modify `src/features/layout/SidePanel.tsx` — 移除 settings 分支。
- Modify `src/App.tsx` — 挂载 `KeybindingHost` + `SettingsDialog`；启动时 `load()` 键位覆盖。
- Modify `src/features/editor/EditorPanel.tsx` — 删除 window keydown effect，挂载查找栏访问器。
- Test `src/commands/types.test.ts`、`src/commands/registry.test.ts`、`src/stores/keybindings.store.test.ts`、`src/commands/KeybindingHost.test.tsx`。

---

### Task 1: 组合键类型与纯函数

**Files:**
- Create: `src/commands/types.ts`
- Test: `src/commands/types.test.ts`

**Interfaces:**
- Produces: `type Platform = "mac" | "other"`；`interface KeyCombo { primary?: boolean; alt?: boolean; shift?: boolean; key: string | null }`；`interface Command { id: string; title: string; category: string; defaultKey: KeyCombo | null; when?: () => boolean; run: () => void }`；`detectPlatform(): Platform`；`comboToCanonical(c: KeyCombo | null): string | null`；`canonicalToCombo(s: string | null): KeyCombo | null`；`comboToLabel(c: KeyCombo | null, p: Platform): string`；`eventToLogicalCombo(e: { ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean; code: string; key: string }, p: Platform): KeyCombo | null`；`isModifierOnly(e): boolean`；`normalizeKeyToken(code: string, key: string): string`。

- [ ] **Step 1: Write the failing test**

```ts
// src/commands/types.test.ts
import { describe, expect, it } from "vitest";
import {
  canonicalToCombo,
  comboToCanonical,
  comboToLabel,
  eventToLogicalCombo,
  isModifierOnly,
  normalizeKeyToken,
} from "./types";

describe("combo canonical round-trip", () => {
  it("serializes modifiers in fixed order", () => {
    expect(comboToCanonical({ shift: true, primary: true, key: "keyf" })).toBe("primary+shift+keyf");
    expect(comboToCanonical({ alt: true, primary: true, shift: true, key: "enter" })).toBe(
      "primary+alt+shift+enter",
    );
  });

  it("round-trips through canonical", () => {
    const c = { primary: true, shift: true, key: "keyn" };
    expect(canonicalToCombo(comboToCanonical(c))).toEqual(c);
  });

  it("null key means unbound", () => {
    expect(comboToCanonical({ key: null })).toBeNull();
    expect(canonicalToCombo(null)).toEqual({ key: null });
  });
});

describe("normalizeKeyToken", () => {
  it("letter codes become keyX", () => {
    expect(normalizeKeyToken("KeyA", "a")).toBe("keya");
    expect(normalizeKeyToken("KeyF", "F")).toBe("keyf");
  });
  it("special keys use lowercased e.key", () => {
    expect(normalizeKeyToken("Enter", "Enter")).toBe("enter");
    expect(normalizeKeyToken("Escape", "Escape")).toBe("escape");
    expect(normalizeKeyToken("BracketLeft", "[")).toBe("[");
  });
});

describe("eventToLogicalCombo", () => {
  it("maps Cmd to primary on mac, Ctrl to primary elsewhere", () => {
    const ev = { ctrlKey: false, metaKey: true, altKey: false, shiftKey: false, code: "KeyB", key: "b" };
    expect(eventToLogicalCombo(ev, "mac")).toEqual({ primary: true, key: "keyb" });
    expect(eventToLogicalCombo({ ...ev, metaKey: false, ctrlKey: true }, "other")).toEqual({
      primary: true,
      key: "keyb",
    });
  });
  it("ignores the platform-native cmd/ctrl cross bit", () => {
    // On mac a Ctrl+B should NOT be primary; on other a Cmd+B should NOT be primary.
    expect(eventToLogicalCombo({ ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, code: "KeyB", key: "b" }, "mac")).toEqual({ key: "keyb" });
    expect(eventToLogicalCombo({ ctrlKey: false, metaKey: true, altKey: false, shiftKey: false, code: "KeyB", key: "b" }, "other")).toEqual({ key: "keyb" });
  });
});

describe("isModifierOnly", () => {
  it("true for bare modifier presses", () => {
    expect(isModifierOnly({ key: "Control" } as KeyboardEvent)).toBe(true);
    expect(isModifierOnly({ key: "Meta" } as KeyboardEvent)).toBe(true);
    expect(isModifierOnly({ key: "Shift" } as KeyboardEvent)).toBe(true);
    expect(isModifierOnly({ key: "Alt" } as KeyboardEvent)).toBe(true);
  });
  it("false for real keys", () => {
    expect(isModifierOnly({ key: "b" } as KeyboardEvent)).toBe(false);
  });
});

describe("comboToLabel", () => {
  it("uses glyphs on mac", () => {
    expect(comboToLabel({ primary: true, shift: true, key: "keyf" }, "mac")).toBe("⌘⇧F");
  });
  it("uses words elsewhere", () => {
    expect(comboToLabel({ primary: true, key: "keyb" }, "other")).toBe("Ctrl+B");
  });
  it("unbound shows placeholder", () => {
    expect(comboToLabel({ key: null }, "mac")).toBe("—");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/commands/types.test.ts`
Expected: FAIL — module `./types` 不存在。

- [ ] **Step 3: Write minimal implementation**

```ts
// src/commands/types.ts
export type Platform = "mac" | "other";

/** Cross-platform logical combo. `primary` = Ctrl on win/linux, Cmd on mac. `key` null = unbound. */
export interface KeyCombo {
  primary?: boolean;
  alt?: boolean;
  shift?: boolean;
  key: string | null;
}

export interface Command {
  id: string;
  title: string;
  category: string;
  defaultKey: KeyCombo | null;
  /** Evaluated at dispatch time; return false to suppress. Omit = always enabled. */
  when?: () => boolean;
  run: () => void;
}

export function detectPlatform(): Platform {
  if (typeof navigator === "undefined") return "other";
  const p = navigator.platform ?? "";
  const ua = navigator.userAgent ?? "";
  return p.startsWith("Mac") || /Macintosh/.test(ua) ? "mac" : "other";
}

const ORDER: (keyof Pick<KeyCombo, "primary" | "alt" | "shift">)[] = ["primary", "alt", "shift"];

export function comboToCanonical(c: KeyCombo | null): string | null {
  if (!c || c.key == null) return null;
  const parts: string[] = [];
  for (const m of ORDER) if (c[m]) parts.push(m);
  parts.push(c.key);
  return parts.join("+");
}

export function canonicalToCombo(s: string | null): KeyCombo | null {
  if (s == null) return { key: null };
  const tokens = s.split("+").filter(Boolean);
  const c: KeyCombo = { key: null };
  for (const t of tokens) {
    if (t === "primary") c.primary = true;
    else if (t === "alt") c.alt = true;
    else if (t === "shift") c.shift = true;
    else c.key = t;
  }
  return c;
}

export function normalizeKeyToken(code: string, key: string): string {
  if (/^Key[A-Z]$/.test(code)) return code.toLowerCase();
  if (/^Digit[0-9]$/.test(code)) return code.toLowerCase();
  return key.toLowerCase();
}

export function isModifierOnly(e: { key: string }): boolean {
  return e.key === "Control" || e.key === "Meta" || e.key === "Shift" || e.key === "Alt";
}

export function eventToLogicalCombo(
  e: { ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean; code: string; key: string },
  p: Platform,
): KeyCombo | null {
  const primary = p === "mac" ? e.metaKey : e.ctrlKey;
  const token = normalizeKeyToken(e.code, e.key);
  if (!token) return null;
  return { primary, alt: e.altKey, shift: e.shiftKey, key: token };
}

function labelKey(token: string): string {
  if (/^key[a-z]$/.test(token)) return token.slice(3).toUpperCase();
  if (/^digit[0-9]$/.test(token)) return token.slice(5);
  if (token === "enter") return "↵";
  if (token === "escape") return "Esc";
  if (token === "space") return "Space";
  if (token === "arrowup") return "↑";
  if (token === "arrowdown") return "↓";
  if (token === "arrowleft") return "←";
  if (token === "arrowright") return "→";
  return token.charAt(0).toUpperCase() + token.slice(1);
}

export function comboToLabel(c: KeyCombo | null, p: Platform): string {
  if (!c || c.key == null) return "—";
  const mac = p === "mac";
  const parts: string[] = [];
  if (c.primary) parts.push(mac ? "⌘" : "Ctrl");
  if (c.alt) parts.push(mac ? "⌥" : "Alt");
  if (c.shift) parts.push(mac ? "⇧" : "Shift");
  parts.push(labelKey(c.key));
  return mac ? parts.join("") : parts.join("+");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/commands/types.test.ts`
Expected: PASS（全绿）。

- [ ] **Step 5: Commit**

```bash
git add src/commands/types.ts src/commands/types.test.ts
git commit -m "feat(commands): 组合键类型与 canonical/label 纯函数

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: 命令注册表 + 种子命令

**Files:**
- Create: `src/commands/registry.ts`
- Create: `src/commands/editorKeybindings.ts`
- Create: `src/commands/keybindingHostState.ts`
- Test: `src/commands/registry.test.ts`

**Interfaces:**
- Consumes: `KeyCombo`/`Command`（来自 `./types`）；`useUiStore`、`useFsStore`（`../stores/...`）。
- Produces: `getCommand(id): Command | undefined`；`listCommands(): Command[]`；`registerFindBarAccessor(getView): () => void`；`isFindBarOpen(): boolean`；`viewForFindBar()`；`noteCloseEsc(): boolean`（返回是否应关闭编辑器）。

- [ ] **Step 1: Write the failing test**

```ts
// src/commands/registry.test.ts
import { describe, expect, it } from "vitest";
import { comboToCanonical } from "./types";
import { getCommand, listCommands } from "./registry";

describe("command registry", () => {
  it("has unique ids", () => {
    const ids = listCommands().map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every command exposes a title and category and a runnable fn", () => {
    for (const c of listCommands()) {
      expect(c.title.trim().length).toBeGreaterThan(0);
      expect(c.category.trim().length).toBeGreaterThan(0);
      expect(typeof c.run).toBe("function");
    }
  });

  it("seeds the core VSCode-style defaults", () => {
    const byId = (id: string) => comboToCanonical(getCommand(id)?.defaultKey ?? null);
    expect(byId("editor.save")).toBe("primary+keys");
    expect(byId("view.toggleSidebar")).toBe("primary+keyb");
    expect(byId("view.toggleSettings")).toBe("primary+comma");
    expect(byId("search.focus")).toBe("primary+shift+keyf");
    expect(byId("scm.focus")).toBe("primary+shift+keyg");
    expect(byId("terminal.toggle")).toBe("primary+backquote");
    expect(byId("workbench.newConversation")).toBe("primary+shift+keyn");
  });

  it("single-combo defaults are unique across commands (no accidental clash)", () => {
    const seen = new Map<string, string>();
    for (const c of listCommands()) {
      const k = comboToCanonical(c.defaultKey);
      if (!k) continue;
      // when-scoped duplicates are allowed; the seed set has none, so assert strict uniqueness.
      expect(seen.has(k), `combo ${k} duplicated by ${c.id} and ${seen.get(k)}`).toBe(false);
      seen.set(k, c.id);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/commands/registry.test.ts`
Expected: FAIL — `./registry` 不存在。

- [ ] **Step 3: Implement editor keybinding accessor + host state**

```ts
// src/commands/editorKeybindings.ts
import type { EditorView } from "@uiw/react-codemirror";
import { searchPanelOpen } from "@codemirror/search";

// Module-level accessor so command when/run can query the live editor find-bar
// without the static registry holding a React ref. EditorPanel registers on
// mount and clears on unmount.
let getView: (() => EditorView | null) | null = null;

export function registerFindBarAccessor(fn: (() => EditorView | null) | null): void {
  getView = fn;
}

export function viewForFindBar(): EditorView | null {
  return getView ? getView() : null;
}

export function isFindBarOpen(): boolean {
  const v = viewForFindBar();
  return !!v && searchPanelOpen(v.state);
}
```

```ts
// src/commands/keybindingHostState.ts
// Double-Esc-to-close-editor timing, lifted out of EditorPanel so the migrated
// editor.close command (and its unit test) can drive it.
const DOUBLE_ESC_MS = 500;
let lastEscAt = 0;

/** Call on each Esc the close command considers. Returns true iff the editor
 *  should close now (a second Esc within the window). Always updates the stamp. */
export function noteCloseEsc(): boolean {
  const now = Date.now();
  const shouldClose = now - lastEscAt < DOUBLE_ESC_MS;
  lastEscAt = shouldClose ? 0 : now;
  return shouldClose;
}

export function _resetCloseEscForTest(): void {
  lastEscAt = 0;
}
```

- [ ] **Step 4: Implement the registry with seed commands**

```ts
// src/commands/registry.ts
import type { Command, KeyCombo } from "./types";
import { isFindBarOpen, noteCloseEsc } from "./editorKeybindings";
import { useUiStore } from "../stores/ui.store";
import { useFsStore } from "../stores/fs.store";

const k = (key: string, o: { primary?: boolean; alt?: boolean; shift?: boolean } = {}): KeyCombo => ({
  key,
  ...o,
});

// Handlers read live state via getState() so the static table never goes stale.
const COMMANDS: Command[] = [
  {
    id: "editor.save",
    title: "保存文件",
    category: "编辑器",
    defaultKey: k("keys", { primary: true }),
    run: () => {
      const fs = useFsStore.getState();
      const active = fs.openFiles.find((f) => f.path === fs.activePath);
      if (active?.dirty) void fs.saveFile();
    },
  },
  {
    id: "editor.close",
    title: "关闭编辑器面板",
    category: "编辑器",
    defaultKey: k("escape"),
    // No `when`: the dispatcher already gates this to the Escape combo. The
    // find-bar case is handled inside run (record the cadence, then yield to
    // CodeMirror's own keymap which closes the bar).
    run: () => {
      if (isFindBarOpen()) {
        noteCloseEsc(); // keep cadence; CodeMirror's own keymap closes the bar
        return;
      }
      if (noteCloseEsc()) useUiStore.getState().setEditorVisible(false);
    },
  },
  {
    id: "view.toggleSidebar",
    title: "切换侧栏",
    category: "视图",
    defaultKey: k("keyb", { primary: true }),
    run: () => useUiStore.getState().toggleSidePanel(),
  },
  {
    id: "view.toggleSettings",
    title: "打开设置",
    category: "视图",
    defaultKey: k("comma", { primary: true }),
    run: () => useUiStore.getState().toggleSettings(),
  },
  {
    id: "terminal.toggle",
    title: "切换终端",
    category: "视图",
    defaultKey: k("backquote", { primary: true }),
    run: () => useUiStore.getState().toggleTerminal(),
  },
  {
    id: "search.focus",
    title: "聚焦搜索",
    category: "搜索",
    defaultKey: k("keyf", { primary: true, shift: true }),
    run: () => useUiStore.getState().setSidePanelTab("search"),
  },
  {
    id: "scm.focus",
    title: "聚焦源代码管理",
    category: "Git",
    defaultKey: k("keyg", { primary: true, shift: true }),
    run: () => useUiStore.getState().setSidePanelTab("git"),
  },
  {
    id: "files.focus",
    title: "聚焦文件树",
    category: "视图",
    defaultKey: k("keye", { primary: true, shift: true }),
    run: () => useUiStore.getState().setSidePanelTab("files"),
  },
  {
    id: "workbench.newConversation",
    title: "新建会话",
    category: "会话",
    // Opens the new-conversation dropdown in Plan 6; for now it is a no-op
    // placeholder so the binding shows in the editor and is reserveable.
    defaultKey: k("keyn", { primary: true, shift: true }),
    run: () => {
      /* wired in Plan 6 */
    },
  },
];

const BY_ID = new Map(COMMANDS.map((c) => [c.id, c]));

export function getCommand(id: string): Command | undefined {
  return BY_ID.get(id);
}

export function listCommands(): Command[] {
  return COMMANDS.slice();
}
```

> 注：`editor.close` 省略 `when`——分发器已按 combo=escape 匹配，查找栏情形在 `run` 内处理（记录节奏后让行给 CodeMirror 关查找栏）。`isFindBarOpen` 的 import 因此仍被 `run` 使用，不要删。

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm test src/commands/registry.test.ts`
Expected: PASS。若 `search.focus` 等引用的 `setSidePanelTab`/`toggleSettings`/`toggleTerminal` 在 `ui.store` 尚未存在会导致**类型**报错——`toggleSettings` 在 Task 7 才加。此 Task 先**临时**在 `ui.store` 加 `settingsOpen`+三方法的最小桩（见 Task 7 完整定义），或把引用 `toggleSettings` 的命令移到 Task 7 注册。**采用后者**：本 Task 的 `COMMANDS` 暂不含 `view.toggleSettings`，并把测试里 `view.toggleSettings` 那行断言删除；Task 7 再加回命令与断言。

- [ ] **Step 6: Commit**

```bash
git add src/commands/registry.ts src/commands/editorKeybindings.ts src/commands/keybindingHostState.ts src/commands/registry.test.ts
git commit -m "feat(commands): 命令注册表与种子命令 + 查找栏访问器

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: 键位覆盖 store + 冲突检测 + 持久化

**Files:**
- Create: `src/stores/keybindings.store.ts`
- Test: `src/stores/keybindings.store.test.ts`

**Interfaces:**
- Consumes: `comboToCanonical`/`canonicalToCombo`（`../commands/types`）；`listCommands`（`../commands/registry`）；`LazyStore`（`@tauri-apps/plugin-store`）。
- Produces: `useKeybindingsStore` with `{ loaded, overrides, load, resolve(id): KeyCombo|null, setOverride(id, combo|null): { conflict: { commandId, commandTitle } | null }, reset(id), conflictsFor(combo): {commandId,commandTitle}[] }`。

- [ ] **Step 1: Write the failing test**

```ts
// src/stores/keybindings.store.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const setMock = vi.fn();
const getMock = vi.fn();
vi.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: class {
    constructor() {}
    get = (...a: unknown[]) => getMock(...a);
    set = (...a: unknown[]) => setMock(...a);
  },
}));

import { comboToCanonical } from "../commands/types";
import { useKeybindingsStore } from "./keybindings.store";

beforeEach(() => {
  vi.clearAllMocks();
  getMock.mockResolvedValue(undefined);
  useKeybindingsStore.setState({ loaded: true, overrides: {} });
});

describe("keybindings store", () => {
  it("resolve returns the default when no override", () => {
    const combo = useKeybindingsStore.getState().resolve("editor.save");
    expect(comboToCanonical(combo)).toBe("primary+keys");
  });

  it("resolve returns the override when set", () => {
    useKeybindingsStore.setState({ overrides: { "editor.save": "primary+alt+keys" } });
    const combo = useKeybindingsStore.getState().resolve("editor.save");
    expect(comboToCanonical(combo)).toBe("primary+alt+keys");
  });

  it("resolve returns null when unbound", () => {
    useKeybindingsStore.setState({ overrides: { "editor.save": null } });
    expect(useKeybindingsStore.getState().resolve("editor.save")).toEqual({ key: null });
  });

  it("setOverride reports a conflict with the effective owner", () => {
    // editor.save default is primary+keys; rebinding editor.close to it conflicts.
    const res = useKeybindingsStore
      .getState()
      .setOverride("editor.close", { primary: true, key: "keys" });
    expect(res.conflict?.commandId).toBe("editor.save");
  });

  it("setOverride ignores self-conflict when re-recording same command", () => {
    useKeybindingsStore.setState({ overrides: { "editor.save": "primary+alt+keys" } });
    const res = useKeybindingsStore
      .getState()
      .setOverride("editor.save", { primary: true, alt: true, key: "keys" });
    expect(res.conflict).toBeNull();
  });

  it("setOverride persists and reset clears", () => {
    useKeybindingsStore.getState().setOverride("editor.save", { primary: true, alt: true, key: "keys" });
    expect(setMock).toHaveBeenCalled();
    useKeybindingsStore.getState().reset("editor.save");
    expect(useKeybindingsStore.getState().overrides["editor.save"]).toBeUndefined();
  });

  it("load hydrates overrides from the store", async () => {
    getMock.mockResolvedValueOnce({ "editor.save": null });
    await useKeybindingsStore.getState().load();
    expect(useKeybindingsStore.getState().overrides["editor.save"]).toBeNull();
    expect(useKeybindingsStore.getState().loaded).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/stores/keybindings.store.test.ts`
Expected: FAIL — store 不存在。

- [ ] **Step 3: Write minimal implementation**

```ts
// src/stores/keybindings.store.ts
import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { LazyStore } from "@tauri-apps/plugin-store";
import { canonicalToCombo, comboToCanonical, type KeyCombo } from "../commands/types";
import { getCommand, listCommands } from "../commands/registry";

// Same persistence pattern as settings.store: a LazyStore writes
// keybindings.json in app-data; zustand holds the in-memory mirror.
const store = new LazyStore("keybindings.json", { autoSave: 300 });
const OVERRIDES_KEY = "overrides";

export interface ConflictRef {
  commandId: string;
  commandTitle: string;
}

interface KeybindingsState {
  loaded: boolean;
  /** commandId -> canonical string | null (null = explicitly unbound). Absent = use default. */
  overrides: Record<string, string | null>;

  load: () => Promise<void>;
  resolve: (commandId: string) => KeyCombo | null;
  /** Apply an override; returns the other command that effectively owns the combo, if any. */
  setOverride: (commandId: string, combo: KeyCombo | null) => { conflict: ConflictRef | null };
  reset: (commandId: string) => void;
  /** Commands (other than excludeId) whose effective binding equals the canonical combo. */
  conflictsFor: (canonical: string | null, excludeId?: string) => ConflictRef[];
}

export const useKeybindingsStore = create<KeybindingsState>()(
  immer((set, get) => ({
    loaded: false,
    overrides: {},

    load: async () => {
      try {
        const raw = await store.get<Record<string, string | null>>(OVERRIDES_KEY);
        if (raw && typeof raw === "object") set((s) => { s.overrides = raw; });
      } catch {
        // Unreadable: keep empty overrides (all defaults).
      } finally {
        set((s) => { s.loaded = true; });
      }
    },

    resolve: (commandId) => {
      const { overrides } = get();
      if (commandId in overrides) return canonicalToCombo(overrides[commandId]);
      return getCommand(commandId)?.defaultKey ?? null;
    },

    conflictsFor: (canonical, excludeId) => {
      if (!canonical) return [];
      const out: ConflictRef[] = [];
      for (const c of listCommands()) {
        if (c.id === excludeId) continue;
        const eff = comboToCanonical(get().resolve(c.id));
        if (eff === canonical) out.push({ commandId: c.id, commandTitle: c.title });
      }
      return out;
    },

    setOverride: (commandId, combo) => {
      const canonical = comboToCanonical(combo);
      const conflict = get().conflictsFor(canonical, commandId)[0] ?? null;
      set((s) => {
        const def = comboToCanonical(getCommand(commandId)?.defaultKey ?? null);
        if (canonical === def) delete s.overrides[commandId]; // back to default
        else s.overrides[commandId] = canonical; // null canonical = unbound
      });
      void store.set(OVERRIDES_KEY, get().overrides).catch(() => {});
      return { conflict };
    },

    reset: (commandId) => {
      set((s) => { delete s.overrides[commandId]; });
      void store.set(OVERRIDES_KEY, get().overrides).catch(() => {});
    },
  }))
);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/stores/keybindings.store.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/stores/keybindings.store.ts src/stores/keybindings.store.test.ts
git commit -m "feat(keybindings): 覆盖表 store + 冲突检测 + 持久化

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: 全局按键分发器 KeybindingHost

**Files:**
- Create: `src/commands/KeybindingHost.tsx`
- Test: `src/commands/KeybindingHost.test.tsx`

**Interfaces:**
- Consumes: `useKeybindingsStore`、`listCommands`/`getCommand`、`eventToLogicalCombo`/`comboToCanonical`/`isModifierOnly`/`detectPlatform`。
- Produces: `KeybindingHost`（无 UI 组件，挂载单个 capture 监听）。导出 `INPUT_SELECTOR` 与 `isInputContext(el)` 供测试。

- [ ] **Step 1: Write the failing test**

```tsx
// src/commands/KeybindingHost.test.tsx
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { KeybindingHost, isInputContext } from "./KeybindingHost";

vi.mock("../stores/keybindings.store", () => ({
  useKeybindingsStore: {
    getState: () => ({
      loaded: true,
      resolve: (id: string) => {
        // Mirror a couple of defaults so the host can match without the real registry store.
        if (id === "view.toggleSidebar") return { primary: true, key: "keyb" };
        if (id === "editor.save") return { primary: true, key: "keys" };
        return null;
      },
    }),
  },
}));

const toggle = vi.fn();
const save = vi.fn();
vi.mock("../commands/registry", () => ({
  listCommands: () => [
    { id: "view.toggleSidebar", title: "t", category: "c", defaultKey: null, run: toggle },
    { id: "editor.save", title: "s", category: "c", defaultKey: null, run: save },
  ],
  getCommand: () => undefined,
}));

function fire(target: EventTarget, init: KeyboardEventInit) {
  target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ...init }));
}

beforeEach(() => {
  vi.clearAllMocks();
  render(<KeybindingHost />);
});
afterEach(() => {
  document.body.innerHTML = "";
});

describe("KeybindingHost", () => {
  it("dispatches a matching combo on window", () => {
    fire(window, { key: "b", code: "KeyB", ctrlKey: true });
    expect(toggle).toHaveBeenCalledTimes(1);
  });

  it("yields when focus is in an input", () => {
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    fire(window, { key: "b", code: "KeyB", ctrlKey: true });
    expect(toggle).not.toHaveBeenCalled();
  });

  it("allow-listed command (editor.save) still fires from an input", () => {
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    fire(window, { key: "s", code: "KeyS", ctrlKey: true });
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("ignores bare modifier presses", () => {
    fire(window, { key: "Control", code: "ControlLeft", ctrlKey: true });
    expect(toggle).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it("yields when a dialog is open", () => {
    const dlg = document.createElement("div");
    dlg.setAttribute("role", "dialog");
    document.body.appendChild(dlg);
    fire(window, { key: "b", code: "KeyB", ctrlKey: true });
    expect(toggle).not.toHaveBeenCalled();
  });

  it("isInputContext recognises editable elements", () => {
    const ta = document.createElement("textarea");
    const ce = document.createElement("div");
    ce.setAttribute("contenteditable", "true");
    expect(isInputContext(ta)).toBe(true);
    expect(isInputContext(ce)).toBe(true);
    expect(isInputContext(document.createElement("div"))).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/commands/KeybindingHost.test.tsx`
Expected: FAIL — 组件不存在。

- [ ] **Step 3: Write minimal implementation**

```tsx
// src/commands/KeybindingHost.tsx
import { useEffect } from "react";
import {
  comboToCanonical,
  detectPlatform,
  eventToLogicalCombo,
  isModifierOnly,
} from "./types";
import { listCommands } from "./registry";
import { useKeybindingsStore } from "../stores/keybindings.store";

// Commands that must work even while typing (VSCode semantics).
const ALLOW_IN_INPUT = new Set(["editor.save", "editor.close"]);

export const INPUT_SELECTOR = "input, textarea, select, [contenteditable=''], [contenteditable='true']";

export function isInputContext(el: EventTarget | null): boolean {
  return el instanceof HTMLElement ? !!el.closest(INPUT_SELECTOR) : false;
}

function dialogOpen(): boolean {
  return !!document.querySelector('[role="dialog"], [role="alertdialog"]');
}

export function KeybindingHost() {
  useEffect(() => {
    const platform = detectPlatform();
    // Pre-resolve canonical combo -> command each dispatch (cheap; registry is tiny).
    const onKeyDown = (e: KeyboardEvent) => {
      if (isModifierOnly(e)) return;
      const inInput = isInputContext(e.target);
      const dlg = dialogOpen();

      const combo = eventToLogicalCombo(e, platform);
      const canonical = comboToCanonical(combo);
      if (!canonical) return;

      const { resolve } = useKeybindingsStore.getState();
      for (const cmd of listCommands()) {
        if (comboToCanonical(resolve(cmd.id)) !== canonical) continue;
        if ((inInput || dlg) && !ALLOW_IN_INPUT.has(cmd.id)) continue;
        if (cmd.when && !cmd.when()) continue;
        e.preventDefault();
        e.stopImmediatePropagation();
        cmd.run();
        return;
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/commands/KeybindingHost.test.tsx`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/commands/KeybindingHost.tsx src/commands/KeybindingHost.test.tsx
git commit -m "feat(commands): 全局捕获阶段按键分发器

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 5: ui.store 增 settingsOpen + 挂载 Host/Dialog 桩

**Files:**
- Modify: `src/stores/ui.store.ts`
- Modify: `src/App.tsx`

**Interfaces:**
- Produces（ui.store 新增，**不**加入 partialize）：`settingsOpen: boolean`、`openSettings()`、`closeSettings()`、`toggleSettings()`。

- [ ] **Step 1: Add the failing assertion (type-level) via a tiny test**

```ts
// append to src/stores/keybindings.store.test.ts is wrong place; create:
// src/stores/ui.settings.test.ts
import { describe, expect, it } from "vitest";
import { useUiStore } from "./ui.store";

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

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/stores/ui.settings.test.ts`
Expected: FAIL — `settingsOpen`/方法不存在（TS 报错或 undefined）。

- [ ] **Step 3: Modify ui.store**

在 `UiState` 接口加 `settingsOpen: boolean;` 与三方法签名；在 `immer` 初始值加 `settingsOpen: false,`；加实现：

```ts
openSettings: () => set((s) => { s.settingsOpen = true; }),
closeSettings: () => set((s) => { s.settingsOpen = false; }),
toggleSettings: () => set((s) => { s.settingsOpen = !s.settingsOpen; }),
```

**不要**把 `settingsOpen` 加入 `partialize`（弹窗开关不持久化）。

- [ ] **Step 4: Mount host + dialog stub in App.tsx and load overrides**

在 `App.tsx`：import `KeybindingHost`、`useKeybindingsStore`；在启动 `useEffect` 的 `loadProjects()` 前/后加 `void useKeybindingsStore.getState().load();`；在 return 的 JSX 顶层包一层 fragment，加入 `<KeybindingHost />` 与 `<SettingsDialogStub />`（临时桩，Task 8 替换为真实 `SettingsDialog`）：

```tsx
function SettingsDialogStub() {
  const open = useUiStore((s) => s.settingsOpen);
  const close = useUiStore((s) => s.closeSettings);
  return open ? (
    <div role="dialog" className="fixed inset-0 z-50 grid place-items-center bg-black/20" onClick={close}>
      <div className="rounded-lg border bg-background p-6" onClick={(e) => e.stopPropagation()}>
        设置弹窗（Task 8 实现）
      </div>
    </div>
  ) : null;
}
```

并在 `MainLayout` 同级渲染 `<KeybindingHost />`。

- [ ] **Step 5: Run tests + typecheck**

Run: `pnpm test src/stores/ui.settings.test.ts && pnpm build`
Expected: PASS；`tsc` 无错（`toggleSettings` 现已存在，registry 的 `view.toggleSettings` 命令将在 Task 7 加入——若 Task 2 已暂不含该命令则此处无影响）。

- [ ] **Step 6: Commit**

```bash
git add src/stores/ui.store.ts src/stores/ui.settings.test.ts src/App.tsx
git commit -m "feat(ui): settingsOpen 开关 + 挂载按键分发器与设置弹窗桩

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 6: 迁移 EditorPanel 的 Ctrl+S / 双 Esc 到骨架

**Files:**
- Modify: `src/features/editor/EditorPanel.tsx`

**Interfaces:**
- Consumes: `registerFindBarAccessor`（`../../commands/editorKeybindings`）。

- [ ] **Step 1: Write/extend a regression test for the accessor**

```ts
// src/commands/editorKeybindings.test.ts
import { afterEach, describe, expect, it } from "vitest";
import { registerFindBarAccessor } from "./editorKeybindings";

afterEach(() => registerFindBarAccessor(null));

describe("editor find-bar accessor", () => {
  it("reports closed when no view registered", () => {
    expect(isFindBarOpen()).toBe(false);
  });
  it("delegates to the registered view", () => {
    registerFindBarAccessor(() => ({ state: {} } as never));
    // searchPanelOpen on an empty state is false; assert wiring returns a boolean.
    expect(typeof isFindBarOpen()).toBe("boolean");
  });
});
```

- [ ] **Step 2: Run test to verify it fails/passes appropriately**

Run: `pnpm test src/commands/editorKeybindings.test.ts`
Expected: PASS（accessor 已在 Task 2 创建；此 Task 仅补测 + 改 EditorPanel）。若已 PASS 直接进入 Step 3。

- [ ] **Step 3: Edit EditorPanel.tsx — remove window listener, register accessor**

删除 EditorPanel 中整段 `useEffect(() => { const onKeyDown = ... window.addEventListener("keydown", onKeyDown, true); ... }, [])`（即处理 `Escape` 与 `Ctrl/Cmd+S` 的那个 effect）。

新增：import `registerFindBarAccessor`；新增一个 effect 注册/注销访问器：

```tsx
useEffect(() => {
  registerFindBarAccessor(() => viewRef.current);
  return () => registerFindBarAccessor(null);
}, []);
```

保留 `viewRef`、`lastEscRef` 可删（逻辑已迁入 `keybindingHostState`）——删除 `lastEscRef` 及其引用。保留 `useMemo` 的 extensions、`requestMeasure` effect、其余 UI 不变。

> 说明：`Ctrl+F` 仍由 CodeMirror 的 `editorSearchExtensions` 处理，不受影响（分发器对输入焦点让行，且未把 `Ctrl+F` 注册为全局命令）。

- [ ] **Step 4: Run full suite + typecheck**

Run: `pnpm test && pnpm build`
Expected: 全绿；`Ctrl+S` 保存、双 Esc 关编辑器、Esc 关查找栏的行为由分发器接管（手动冒烟在 Task 11）。

- [ ] **Step 5: Commit**

```bash
git add src/features/editor/EditorPanel.tsx src/commands/editorKeybindings.test.ts
git commit -m "refactor(editor): Ctrl+S 与双 Esc 迁移到按键分发器

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 7: 注册 view.toggleSettings 命令 + 补断言

**Files:**
- Modify: `src/commands/registry.ts`
- Modify: `src/commands/registry.test.ts`

- [ ] **Step 1: Add the failing assertion**

在 `registry.test.ts` 的 “seeds the core VSCode-style defaults” 用例内加：

```ts
expect(byId("view.toggleSettings")).toBe("primary+comma");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/commands/registry.test.ts`
Expected: FAIL — 命令未注册。

- [ ] **Step 3: Add the command to registry.ts**

在 `COMMANDS` 加入（`ui.store` 现已有 `toggleSettings`）：

```ts
{
  id: "view.toggleSettings",
  title: "打开设置",
  category: "视图",
  defaultKey: k("comma", { primary: true }),
  run: () => useUiStore.getState().toggleSettings(),
},
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/commands/registry.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/commands/registry.ts src/commands/registry.test.ts
git commit -m "feat(commands): 注册 view.toggleSettings (Ctrl/Cmd+,)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 8: 设置弹窗壳 + 竖向页签 + 五个页签（含快捷键）

**Files:**
- Create: `src/features/settings/SettingsDialog.tsx`
- Create: `src/features/settings/KeybindingsEditor.tsx`
- Create: `src/features/settings/sections/AppearanceSection.tsx`
- Create: `src/features/settings/sections/EditorSection.tsx`
- Create: `src/features/settings/sections/TerminalSection.tsx`
- Create: `src/features/settings/sections/AgentsSection.tsx`
- Delete: `src/features/settings/SettingsPanel.tsx`
- Modify: `src/App.tsx`（桩→真实 dialog）

**Interfaces:**
- Consumes: `useUiStore`（settingsOpen/closeSettings）；`useSettingsStore`、`useAgentStore`、`useUiStore.resetLayoutDims`（sections，沿用现 `SettingsPanel` 的 hooks）；`useKeybindingsStore`、`listCommands`、`comboToLabel`/`detectPlatform`/`comboToCanonical`（编辑器）。
- Produces: `SettingsDialog`（受 `settingsOpen` 控制的 radix Dialog）。

- [ ] **Step 1: Move the four existing sections verbatim**

把现 `SettingsPanel.tsx` 的四个 `<section>` 分别搬入 `sections/*.tsx`，每个文件导出一个组件，**逻辑/状态/文案原样**（智能体的 `showForm`/`customName`/`handleAddCustom`/`error` 等 state 全部进入 `AgentsSection`；`useEffect(loadAllServers)` 也在该组件内）。共享常量 `SECTION_HEADER` 复制到各文件或抽到 `sections/_shared.ts`（实现时择一，保持 DRY 即可）。外观/编辑器/终端/布局分别取自己用到的 store 字段。布局页签＝现 “④ 布局” section（恢复默认按钮 + 说明）。

> 此步为“搬移”，不改变行为；无新单测，靠 `pnpm build` 保证类型与 import 正确。

- [ ] **Step 2: Implement KeybindingsEditor.tsx**

```tsx
// src/features/settings/KeybindingsEditor.tsx
import { useMemo, useState } from "react";
import { AlertTriangle, Pencil, RotateCcw } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { listCommands } from "../../../commands/registry";
import { useKeybindingsStore, type ConflictRef } from "../../../stores/keybindings.store";
import { comboToCanonical, comboToLabel, detectPlatform, type KeyCombo } from "../../../commands/types";

const platform = detectPlatform();

export function KeybindingsEditor() {
  const resolve = useKeybindingsStore((s) => s.resolve);
  const overrides = useKeybindingsStore((s) => s.overrides);
  const setOverride = useKeybindingsStore((s) => s.setOverride);
  const reset = useKeybindingsStore((s) => s.reset);
  const conflictsFor = useKeybindingsStore((s) => s.conflictsFor);

  const [query, setQuery] = useState("");
  const [recordingId, setRecordingId] = useState<string | null>(null);
  const [pendingConflict, setPendingConflict] = useState<{ id: string; conflict: ConflictRef } | null>(null);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return listCommands()
      .filter((c) => !q || c.title.toLowerCase().includes(q) || c.category.toLowerCase().includes(q) || c.id.toLowerCase().includes(q))
      .map((c) => ({ cmd: c, eff: resolve(c.id), isUser: c.id in overrides }));
  }, [query, resolve, overrides]);

  return (
    <div className="space-y-3">
      <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索命令…" />
      <div className="overflow-hidden rounded-[var(--radius-md)] border border-[color:var(--color-border)]">
        <div className="grid grid-cols-[1fr_auto_auto] gap-2 px-3 py-2 text-xs uppercase tracking-wide text-[var(--text-tertiary)] bg-[var(--overlay-ghost)]">
          <span>命令</span><span className="text-right">键位</span><span className="w-16" />
        </div>
        <div className="divide-y divide-[color:var(--border-subtle)] max-h-[50vh] overflow-y-auto">
          {rows.map(({ cmd, eff, isUser }) => {
            const canonical = comboToCanonical(eff);
            const conflict = conflictsFor(canonical, cmd.id)[0];
            const recording = recordingId === cmd.id;
            return (
              <div key={cmd.id} className="grid grid-cols-[1fr_auto_auto] items-center gap-2 px-3 py-2 text-sm hover:bg-[var(--overlay-hover)]">
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5 truncate">
                    <span className="truncate">{cmd.title}</span>
                    {conflict && <AlertTriangle size={13} className="text-[var(--warning)]" title={`与「${conflict.commandTitle}」冲突`} />}
                  </div>
                  <div className="text-xs text-[var(--text-tertiary)] truncate">{cmd.category} · {cmd.id}</div>
                </div>
                <div className="text-right">
                  {recording ? (
                    <KeyRecorder
                      onRecord={(combo) => {
                        const { conflict: c } = setOverride(cmd.id, combo);
                        setRecordingId(null);
                        if (c) setPendingConflict({ id: cmd.id, conflict: c });
                      }}
                      onCancel={() => setRecordingId(null)}
                    />
                  ) : (
                    <kbd className="font-mono text-xs px-1.5 py-0.5 rounded bg-[var(--overlay-ghost)] border border-[color:var(--color-border)]">
                      {comboToLabel(eff, platform)}
                    </kbd>
                  )}
                </div>
                <div className="flex w-16 justify-end gap-1">
                  <Button size="sm" variant="ghost" title="改键" onClick={() => { setRecordingId(cmd.id); setPendingConflict(null); }}>
                    <Pencil size={12} />
                  </Button>
                  {isUser && (
                    <Button size="sm" variant="ghost" title="重置为默认" onClick={() => reset(cmd.id)}>
                      <RotateCcw size={12} />
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
      {pendingConflict && (
        <p className="text-xs text-[var(--warning)]">
          该键位已被「{pendingConflict.conflict.commandTitle}」使用，两者冲突（后触发者生效）。
        </p>
      )}
    </div>
  );
}

/** Records a single combo on the next non-modifier keydown; Esc cancels. */
function KeyRecorder({ onRecord, onCancel }: { onRecord: (c: KeyCombo) => void; onCancel: () => void }) {
  const [hint] = useState("请按键…");
  // Capture locally so the global host (which yields to dialogs) won't steal it.
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); onCancel(); return; }
    if (["Control", "Meta", "Shift", "Alt"].includes(e.key)) return;
    e.preventDefault();
    const combo: KeyCombo = {
      primary: e.ctrlKey || e.metaKey,
      alt: e.altKey,
      shift: e.shiftKey,
      key: normalize(e.code, e.key),
    };
    onRecord(combo);
  };
  return (
    // autofocus + tabIndex so it receives key events without a real input element.
    <span
      tabIndex={0}
      autoFocus
      onKeyDown={onKey}
      className="inline-block outline-none text-xs text-[var(--accent)] animate-pulse"
    >
      {hint}
    </span>
  );
}

function normalize(code: string, key: string): string {
  if (/^Key[A-Z]$/.test(code)) return code.toLowerCase();
  if (/^Digit[0-9]$/.test(code)) return code.toLowerCase();
  return key.toLowerCase();
}
```

- [ ] **Step 3: Implement SettingsDialog.tsx (left vertical nav + tabs)**

```tsx
// src/features/settings/SettingsDialog.tsx
import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useUiStore } from "../../stores/ui.store";
import { AppearanceSection } from "./sections/AppearanceSection";
import { EditorSection } from "./sections/EditorSection";
import { TerminalSection } from "./sections/TerminalSection";
import { AgentsSection } from "./sections/AgentsSection";
import { KeybindingsEditor } from "./KeybindingsEditor";
import { LayoutSection } from "./sections/LayoutSection";

type TabId = "appearance" | "editor" | "terminal" | "agents" | "keybindings" | "layout";
const TABS: { id: TabId; label: string }[] = [
  { id: "appearance", label: "外观" },
  { id: "editor", label: "编辑器" },
  { id: "terminal", label: "终端" },
  { id: "agents", label: "智能体" },
  { id: "keybindings", label: "快捷键" },
  { id: "layout", label: "布局" },
];

export function SettingsDialog() {
  const open = useUiStore((s) => s.settingsOpen);
  const close = useUiStore((s) => s.closeSettings);
  const [tab, setTab] = useState<TabId>("appearance");

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) close(); }}>
      <DialogContent className="sm:max-w-3xl h-[70vh] flex flex-col p-0 gap-0 overflow-hidden">
        <DialogHeader className="px-6 pt-5 pb-3 border-b border-[color:var(--border-subtle)]">
          <DialogTitle>设置</DialogTitle>
        </DialogHeader>
        <div className="flex flex-1 min-h-0">
          <nav className="w-40 shrink-0 border-r border-[color:var(--border-subtle)] p-2 space-y-0.5 overflow-y-auto">
            {TABS.map((t) => (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={`w-full text-left px-3 py-1.5 rounded-[var(--radius-sm)] text-sm transition-colors ${
                  tab === t.id
                    ? "bg-[var(--accent)]/15 text-[var(--accent)]"
                    : "text-[var(--text-secondary)] hover:bg-[var(--overlay-hover)]"
                }`}
              >
                {t.label}
              </button>
            ))}
          </nav>
          <div className="flex-1 min-w-0 overflow-y-auto p-6">
            {tab === "appearance" && <AppearanceSection />}
            {tab === "editor" && <EditorSection />}
            {tab === "terminal" && <TerminalSection />}
            {tab === "agents" && <AgentsSection />}
            {tab === "keybindings" && <KeybindingsEditor />}
            {tab === "layout" && <LayoutSection />}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
```

并补 `sections/LayoutSection.tsx`（恢复默认按钮 + 现说明文案）。

- [ ] **Step 4: Replace the stub in App.tsx and delete SettingsPanel + side-panel branch**

`App.tsx`：import `SettingsDialog`，删除 `SettingsDialogStub`，渲染 `<SettingsDialog />`（与 `<KeybindingHost />` 同层）。
`SidePanel.tsx`：删除 `import { SettingsPanel }` 与 `{sidePanelTab === "settings" && <SettingsPanel />}`。
删除文件 `src/features/settings/SettingsPanel.tsx`。

> `ui.store` 的 `SidePanelTab` 类型暂**保留** `"settings"` 字面量不删（避免 IconBar 类型报错）；IconBar 的改线在 Task 9 做，本 Task 不动 IconBar。若 `setSidePanelTab("settings")` 仍被 IconBar 调用而 SidePanel 不再渲染它，行为是“点齿轮切到一个空页签”——仅一个 commit 的瞬态，Task 9 立刻修。可接受。

- [ ] **Step 5: Run build + suite**

Run: `pnpm build && pnpm test`
Expected: 通过；无未用 import 报错（oxlint 在 `pnpm lint`，构建不含 lint，但请一并 `pnpm lint` 确认无 dead import）。

- [ ] **Step 6: Commit**

```bash
git add src/features/settings src/App.tsx src/features/layout/SidePanel.tsx
git commit -m "feat(settings): 设置改为弹窗 + 竖向页签 + 快捷键编辑器

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 9: IconBar 齿轮改开弹窗 + 清理 SidePanelTab 的 settings

**Files:**
- Modify: `src/features/layout/IconBar.tsx`
- Modify: `src/stores/ui.store.ts`

- [ ] **Step 1: Rewire the gear**

`IconBar.tsx`：齿轮 `Button` 的 `onClick` 由 `() => setSidePanelTab("settings")` 改为 `() => useUiStore.getState().openSettings()`；其高亮 className 由 `sidePanelTab === "settings"` 改为 `useUiStore((s) => s.settingsOpen)`（订阅该布尔）。

- [ ] **Step 2: Drop "settings" from SidePanelTab**

`ui.store.ts`：`export type SidePanelTab = "files" | "git" | "search";`。若 `setSidePanelTab` 仍被传 `"settings"` 会类型报错——确认全仓无其它 `setSidePanelTab("settings")`（`rg setSidePanelTab` 检查；IconBar 已在 Step 1 改掉）。

- [ ] **Step 3: Run build + lint + suite**

Run: `pnpm build && pnpm lint && pnpm test`
Expected: 全绿；无 `"settings"` 残留在 `SidePanelTab` 使用处。

- [ ] **Step 4: Commit**

```bash
git add src/features/layout/IconBar.tsx src/stores/ui.store.ts
git commit -m "refactor(layout): 齿轮改开设置弹窗，移除侧栏设置页签

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 10: 端到端接线自测（无 UI 的集成测）

**Files:**
- Create: `src/commands/integration.test.tsx`

> 目的：验证“覆盖表 → 分发器 → 命令 run”链路，以及让行规则与持久化的协同，补足单组件测之外的接缝。

- [ ] **Step 1: Write the integration test**

```tsx
// src/commands/integration.test.tsx
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { KeybindingHost } from "./KeybindingHost";

const toggle = vi.fn();
vi.mock("../commands/registry", () => ({
  listCommands: () => [{ id: "view.toggleSidebar", title: "t", category: "c", defaultKey: null, run: toggle }],
  getCommand: () => undefined,
}));

let overrides: Record<string, string | null> = {};
vi.mock("../stores/keybindings.store", () => ({
  useKeybindingsStore: {
    getState: () => ({
      loaded: true,
      resolve: (id: string) => {
        if (id !== "view.toggleSidebar") return null;
        // default primary+keyb unless overridden
        if (id in overrides) return overrides[id] === null ? { key: null } : parse(overrides[id]!);
        return { primary: true, key: "keyb" };
      },
    }),
  },
}));
function parse(s: string) {
  const c: Record<string, boolean | string> = { key: "" };
  for (const t of s.split("+")) {
    if (t === "primary") c.primary = true;
    else if (t === "alt") c.alt = true;
    else if (t === "shift") c.shift = true;
    else c.key = t;
  }
  return c;
}
const fire = (init: KeyboardEventInit) =>
  window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ...init }));

beforeEach(() => { overrides = {}; vi.clearAllMocks(); render(<KeybindingHost />); });
afterEach(() => { document.body.innerHTML = ""; });

describe("keybinding integration", () => {
  it("default binding dispatches", () => {
    fire({ key: "b", code: "KeyB", ctrlKey: true });
    expect(toggle).toHaveBeenCalledTimes(1);
  });
  it("override changes the dispatch key", () => {
    overrides = { "view.toggleSidebar": "primary+alt+keyb" };
    fire({ key: "b", code: "KeyB", ctrlKey: true });
    expect(toggle).not.toHaveBeenCalled();
    fire({ key: "b", code: "KeyB", ctrlKey: true, altKey: true });
    expect(toggle).toHaveBeenCalledTimes(1);
  });
  it("unbound disables the command", () => {
    overrides = { "view.toggleSidebar": null };
    fire({ key: "b", code: "KeyB", ctrlKey: true });
    expect(toggle).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `pnpm test src/commands/integration.test.tsx`
Expected: PASS。

- [ ] **Step 3: Commit**

```bash
git add src/commands/integration.test.tsx
git commit -m "test(commands): 覆盖→分发→执行 端到端接线测试

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 11: 全量校验 + 手动冒烟清单

**Files:** 无新增。

- [ ] **Step 1: 全量自动化**

Run: `pnpm lint && pnpm build && pnpm test`
Expected: 三者全绿，无 lint/类型/测试失败。

- [ ] **Step 2: 手动冒烟（`pnpm dev` / `pnpm tauri dev`）**

逐项核对并记录结果：
1. 齿轮按钮 / `Ctrl+,`(`Cmd+,`) 打开设置弹窗；左 nav 六页签可切；Esc 与遮罩可关。
2. 快捷键页签：搜索过滤有效；点铅笔进入“请按键”，按 `Ctrl+Alt+B` 改 `切换侧栏`，行内显示新键且标来源＝用户；与已有键冲突时出现 ⚠ 与提示文案；点重置恢复默认。
3. 改键后**立即**生效：把 `切换侧栏` 改到 `Ctrl+Alt+B`，按之侧栏切换；原 `Ctrl+B` 不再触发。
4. `Ctrl+S` 在编辑器输入框内仍可保存（让行白名单）；普通输入框内按 `Ctrl+B` 不触发侧栏（让行）。
5. 编辑器：`Esc` 关查找栏；查找栏已关时双 `Esc` 关编辑器面板。
6. `Ctrl+Shift+F`/`Ctrl+Shift+G`/`Ctrl+Shift+E` 切到对应侧栏页签；`` Ctrl+` `` 切终端。
7. 侧栏不再有设置页签；IconBar 齿轮高亮随弹窗开/关。
8. 重启应用后改键仍在（`keybindings.json` 持久化）。

- [ ] **Step 3: 修复冒烟中发现的问题并提交**

若有修复：`git add -A && git commit -m "fix(keybindings): 冒烟修复 <简述>"`（结尾 Co-Authored-By）。无问题则跳过。

- [ ] **Step 4: 计划完成确认**

确认 `pnpm lint && pnpm build && pnpm test` 仍全绿；本计划交付物＝可用的命令/键位骨架 + 设置弹窗（含快捷键编辑器）+ EditorPanel 迁移完成。

---

## 自检（写完后对照 spec）

- **spec §1 覆盖**：注册表(Task2)、覆盖 store+冲突+持久化(Task3)、全局分发器+让行(Task4)、设置快捷键页签编辑器(Task8)、迁移 EditorPanel(Task6) —— 全覆盖。
- **spec F1 结构覆盖**：弹窗壳+竖向 nav+六页签(Task8)、侧栏移除+齿轮改线(Task8/9)、现有四 section 搬移(Task8) —— 全覆盖。F1 视觉精修明确延后到 Plan 2（计划头已注明）。
- **占位符扫描**：无 TBD/TODO/“类似 Task N”；每步含代码或确切命令。`workbench.newConversation` 的 run 为有意空实现并注释“wired in Plan 6”，属跨计划接缝而非占位。
- **类型一致性**：`KeyCombo`/`Command`/`comboToCanonical`/`canonicalToCombo`/`comboToLabel`/`eventToLogicalCombo`/`isModifierOnly`/`normalizeKeyToken`/`detectPlatform` 在 Task 1 定义，后续 Task 引用同名同签名；store 的 `resolve/setOverride/reset/conflictsFor` 在 Task 3 定义，Task 4/8/10 一致使用；`registerFindBarAccessor/isFindBarOpen` 在 Task 2 定义，Task 6 使用；`noteCloseEsc` 在 Task 2 定义并被 registry 的 `editor.close` 使用。
- **跨任务顺序**：Task 2 暂不含 `view.toggleSettings`（避免 ui.store 未就绪的类型错），Task 5 加 `toggleSettings`，Task 7 补命令与断言——顺序自洽。
