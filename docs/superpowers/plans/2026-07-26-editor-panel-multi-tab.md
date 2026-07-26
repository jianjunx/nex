# Editor Panel Multi-Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让文件编辑面板与侧栏同高并可滚动，支持多标签（文件名 + 悬停项目相对路径）、Ctrl/Cmd+S 与 debounce 自动保存（设置可关），并为常用语言启用 CodeMirror 语法高亮。

**Architecture:** 在现有 `fs.store` 上将单 `editorFile` 升级为 `openFiles[]` + `activePath`；自动保存 debounce 挂在 store 侧（读 `settings.store.editorAutoSave`）；`EditorPanel` 渲染标签栏与当前文件的 CodeMirror（`key=activePath`）；按扩展名选择 `@codemirror/lang-*`（Shell 用 legacy StreamLanguage）。

**Tech Stack:** React 19、Zustand + immer、`@uiw/react-codemirror`、`@codemirror/lang-*`、`@codemirror/legacy-modes`、Vitest、`@glinui/ui` Switch、tauri-plugin-store

**Spec:** `docs/superpowers/specs/2026-07-26-editor-panel-multi-tab-design.md`

## Global Constraints

- 包管理：pnpm（前端）
- 自动保存 debounce：**1500ms**；设置 key：`editor.autoSave`；默认 **`true`**
- 关脏标签：不弹窗，关闭前 flush 保存
- 切标签：若有 pending debounce，先 flush 再切
- Esc：只 `setEditorVisible(false)`，不清空 `openFiles`
- 高亮扩展：`ts/tsx/js/jsx/mjs/cjs`、`json`、`css`、`html/htm`、`md/markdown`、`py`、`rs`、`go`、`toml`、`yml/yaml`、`sh/bash`；其余纯文本
- 路径：basename 同时支持 `/` 与 `\`；tooltip 优先项目相对路径
- 提交信息用简体中文；每任务结束后 commit
- 测试：Vitest；mock `src/bridge/tauri` 与相关 store 的 `getState`

## File Structure

| 文件 | 职责 |
|---|---|
| `src/features/editor/pathUtils.ts` | `fileBasename`、`relativeToProject` |
| `src/features/editor/language.ts` | 扩展名 → CodeMirror extensions |
| `src/features/editor/EditorPanel.tsx` | 多标签 UI、布局滚动、快捷键、高亮 |
| `src/stores/fs.store.ts` | `openFiles` / `activePath`、保存、debounce、外部同步 |
| `src/stores/settings.store.ts` | `editorAutoSave` 持久化 |
| `src/features/settings/SettingsPanel.tsx` | 「编辑器」自动保存开关 |
| `src/App.tsx` | 按 `openFiles.length` 挂载编辑器 |
| `src/features/editor/pathUtils.test.ts` | 路径工具测试 |
| `src/stores/fs.store.editor.test.ts` | 多标签 + 自动保存 store 测试 |
| `vite.config.ts` / `package.json` | Vitest `test` 配置与 `pnpm test` 脚本 |

---

### Task 1: 路径工具 + Vitest 脚手架

**Files:**
- Create: `src/features/editor/pathUtils.ts`
- Create: `src/features/editor/pathUtils.test.ts`
- Modify: `vite.config.ts`
- Modify: `package.json`（scripts.test）

**Interfaces:**
- Produces:
  - `fileBasename(path: string): string`
  - `relativeToProject(filePath: string, projectRoot: string | undefined | null): string`

- [ ] **Step 1: 配置 Vitest**

在 `vite.config.ts` 增加（保留现有字段）：

```ts
/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  server: {
    strictPort: true,
    watch: {
      ignored: ["**/src-tauri/target/**"],
    },
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    target: "esnext",
    minify: !process.env.TAURI_DEBUG ? "esbuild" : false,
    sourcemap: !!process.env.TAURI_DEBUG,
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
```

在 `package.json` 的 `scripts` 中增加：

```json
"test": "vitest run"
```

- [ ] **Step 2: 写失败测试**

`src/features/editor/pathUtils.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { fileBasename, relativeToProject } from "./pathUtils";

describe("fileBasename", () => {
  it("handles posix and windows separators", () => {
    expect(fileBasename("/a/b/c.ts")).toBe("c.ts");
    expect(fileBasename("C:\\a\\b\\c.ts")).toBe("c.ts");
    expect(fileBasename("c.ts")).toBe("c.ts");
  });
});

describe("relativeToProject", () => {
  it("returns project-relative path when under root", () => {
    expect(relativeToProject("/proj/src/a.ts", "/proj")).toBe("src/a.ts");
    expect(relativeToProject("C:\\proj\\src\\a.ts", "C:\\proj")).toBe("src/a.ts");
  });

  it("falls back to absolute when no root or outside root", () => {
    expect(relativeToProject("/other/a.ts", "/proj")).toBe("/other/a.ts");
    expect(relativeToProject("/proj/a.ts", null)).toBe("/proj/a.ts");
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `pnpm test -- src/features/editor/pathUtils.test.ts`

Expected: FAIL（模块不存在或导出缺失）

- [ ] **Step 4: 实现 pathUtils**

`src/features/editor/pathUtils.ts`：

```ts
/** Last path segment; supports `/` and `\`. */
export function fileBasename(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const i = normalized.lastIndexOf("/");
  return i >= 0 ? normalized.slice(i + 1) : normalized;
}

/**
 * Path relative to project root for tooltips.
 * Normalizes separators to `/` in the relative result.
 * Falls back to the original `filePath` when root is missing or file is outside root.
 */
export function relativeToProject(
  filePath: string,
  projectRoot: string | undefined | null,
): string {
  if (!projectRoot) return filePath;
  const file = filePath.replace(/\\/g, "/");
  let root = projectRoot.replace(/\\/g, "/");
  if (root.endsWith("/")) root = root.slice(0, -1);
  // Case-insensitive compare on Windows-style roots (drive letter).
  const fileCmp = /^[a-zA-Z]:/.test(file) ? file.toLowerCase() : file;
  const rootCmp = /^[a-zA-Z]:/.test(root) ? root.toLowerCase() : root;
  if (fileCmp === rootCmp) return ".";
  if (fileCmp.startsWith(rootCmp + "/")) {
    return file.slice(root.length + 1); // keep original casing from `file`
  }
  return filePath;
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm test -- src/features/editor/pathUtils.test.ts`

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add vite.config.ts package.json src/features/editor/pathUtils.ts src/features/editor/pathUtils.test.ts
git commit -m "feat(editor): 添加路径工具与 Vitest 脚手架"
```

---

### Task 2: `fs.store` 多标签

**Files:**
- Modify: `src/stores/fs.store.ts`
- Create: `src/stores/fs.store.editor.test.ts`
- Modify: `src/App.tsx`（挂载条件先改为 `openFiles.length`，避免中间态类型断裂）

**Interfaces:**
- Consumes: `fsReadFile` / `fsWriteFile` from `src/bridge/tauri.ts`；`useUiStore.getState().setEditorVisible`
- Produces（替换 `editorFile`）:
  - `openFiles: EditorFile[]`
  - `activePath: string | null`
  - `openFile(filePath: string): Promise<void>`
  - `switchFile(filePath: string): Promise<void>` — 切前 flush pending autosave（Task 3 接 debounce；本任务可先 sync flush dirty 可选，或空实现等 Task 3）
  - `closeFile(filePath: string): Promise<void>`
  - `closeEditor(): Promise<void>`
  - `setDraft(draft: string): void`
  - `saveFile(filePath?: string): Promise<void>`
  - `EditorFile` 类型导出或内联保持字段：`path, content, isText, size, draft, dirty, stale`

本任务 **先不实现 autosave debounce**（Task 3）。`switchFile` / `closeFile` 对 dirty：**closeFile 必须 await saveFile**；`switchFile` 本任务只切 active（Task 3 再加 flush timer）。

- [ ] **Step 1: 写失败的多标签测试**

`src/stores/fs.store.editor.test.ts`：

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const fsReadFile = vi.fn();
const fsWriteFile = vi.fn();
const setEditorVisible = vi.fn();

vi.mock("../bridge/tauri", () => ({
  fsReadFile: (...args: unknown[]) => fsReadFile(...args),
  fsWriteFile: (...args: unknown[]) => fsWriteFile(...args),
  fsReadTree: vi.fn(),
  fsExpandDir: vi.fn(),
  fsSearch: vi.fn(),
}));

vi.mock("./ui.store", () => ({
  useUiStore: {
    getState: () => ({ setEditorVisible }),
  },
}));

// settings mock — Task 3 will assert autosave; keep default false here so Task 2 stays quiet
vi.mock("./settings.store", () => ({
  useSettingsStore: {
    getState: () => ({ editorAutoSave: false }),
  },
}));

import { useFsStore } from "./fs.store";

describe("fs.store multi-tab editor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useFsStore.setState({
      openFiles: [],
      activePath: null,
      error: null,
      loading: false,
    });
  });

  it("openFile appends and activates; re-open same path only activates", async () => {
    fsReadFile.mockResolvedValueOnce({ is_text: true, content: "a", size: 1 });
    await useFsStore.getState().openFile("/p/a.ts");
    expect(useFsStore.getState().openFiles).toHaveLength(1);
    expect(useFsStore.getState().activePath).toBe("/p/a.ts");
    expect(setEditorVisible).toHaveBeenCalledWith(true);

    fsReadFile.mockClear();
    await useFsStore.getState().openFile("/p/a.ts");
    expect(fsReadFile).not.toHaveBeenCalled();
    expect(useFsStore.getState().openFiles).toHaveLength(1);
  });

  it("openFile second file keeps both; switchFile changes active", async () => {
    fsReadFile
      .mockResolvedValueOnce({ is_text: true, content: "a", size: 1 })
      .mockResolvedValueOnce({ is_text: true, content: "b", size: 1 });
    await useFsStore.getState().openFile("/p/a.ts");
    await useFsStore.getState().openFile("/p/b.ts");
    expect(useFsStore.getState().openFiles.map((f) => f.path)).toEqual(["/p/a.ts", "/p/b.ts"]);
    expect(useFsStore.getState().activePath).toBe("/p/b.ts");

    await useFsStore.getState().switchFile("/p/a.ts");
    expect(useFsStore.getState().activePath).toBe("/p/a.ts");
    expect(useFsStore.getState().openFiles.find((f) => f.path === "/p/a.ts")?.draft).toBe("a");
  });

  it("setDraft marks active dirty; saveFile writes and clears dirty", async () => {
    fsReadFile.mockResolvedValueOnce({ is_text: true, content: "a", size: 1 });
    await useFsStore.getState().openFile("/p/a.ts");
    useFsStore.getState().setDraft("a!");
    expect(useFsStore.getState().openFiles[0].dirty).toBe(true);
    fsWriteFile.mockResolvedValueOnce(undefined);
    await useFsStore.getState().saveFile();
    expect(fsWriteFile).toHaveBeenCalledWith("/p/a.ts", "a!");
    expect(useFsStore.getState().openFiles[0].dirty).toBe(false);
  });

  it("closeFile on dirty flushes save then removes; activates neighbor", async () => {
    fsReadFile
      .mockResolvedValueOnce({ is_text: true, content: "a", size: 1 })
      .mockResolvedValueOnce({ is_text: true, content: "b", size: 1 });
    await useFsStore.getState().openFile("/p/a.ts");
    await useFsStore.getState().openFile("/p/b.ts");
    useFsStore.getState().setDraft("b!");
    fsWriteFile.mockResolvedValueOnce(undefined);
    await useFsStore.getState().closeFile("/p/b.ts");
    expect(fsWriteFile).toHaveBeenCalledWith("/p/b.ts", "b!");
    expect(useFsStore.getState().openFiles.map((f) => f.path)).toEqual(["/p/a.ts"]);
    expect(useFsStore.getState().activePath).toBe("/p/a.ts");
  });

  it("closing last file clears active and hides panel", async () => {
    fsReadFile.mockResolvedValueOnce({ is_text: true, content: "a", size: 1 });
    await useFsStore.getState().openFile("/p/a.ts");
    await useFsStore.getState().closeFile("/p/a.ts");
    expect(useFsStore.getState().openFiles).toEqual([]);
    expect(useFsStore.getState().activePath).toBeNull();
    expect(setEditorVisible).toHaveBeenCalledWith(false);
  });

  it("syncExternalChange marks dirty stale and reloads clean", async () => {
    fsReadFile.mockResolvedValueOnce({ is_text: true, content: "a", size: 1 });
    await useFsStore.getState().openFile("/p/a.ts");
    useFsStore.getState().setDraft("edit");
    await useFsStore.getState().syncExternalChange(["/p/a.ts"]);
    expect(useFsStore.getState().openFiles[0].stale).toBe(true);

    // clean file silent reload
    useFsStore.setState((s) => {
      s.openFiles[0].draft = "a";
      s.openFiles[0].dirty = false;
      s.openFiles[0].stale = false;
    });
    fsReadFile.mockResolvedValueOnce({ is_text: true, content: "disk", size: 4 });
    await useFsStore.getState().syncExternalChange(["/p/a.ts"]);
    expect(useFsStore.getState().openFiles[0].draft).toBe("disk");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test -- src/stores/fs.store.editor.test.ts`

Expected: FAIL（`openFiles` / API 尚不存在）

- [ ] **Step 3: 实现多标签 store**

重写 `src/stores/fs.store.ts` 中编辑器相关部分（保留 tree/search 不变）。关键形状：

```ts
export type EditorFile = {
  path: string;
  content: string | null;
  isText: boolean;
  size: number;
  draft: string;
  dirty: boolean;
  stale: boolean;
};

interface FsStore {
  // ... existing tree/search fields ...
  openFiles: EditorFile[];
  activePath: string | null;
  openFile: (filePath: string) => Promise<void>;
  switchFile: (filePath: string) => Promise<void>;
  closeFile: (filePath: string) => Promise<void>;
  closeEditor: () => Promise<void>;
  setDraft: (draft: string) => void;
  saveFile: (filePath?: string) => Promise<void>;
  // syncExternalChange / reloadEditor / dismissStale 改为遍历或针对 active
}
```

实现要点：

- `openFile`：若 `openFiles.some(f => f.path === filePath)` → `activePath = filePath` + `setEditorVisible(true)`，return；否则 `fsReadFile`，push，设 active，显示面板。失败只设 `error`，不 push。
- `switchFile`：若 path 不在列表则 return；否则 `activePath = filePath`。
- `saveFile(path?)`：解析 `target = path ?? activePath`；找文件；`!dirty` 则 return；`fsWriteFile`；写完后若该 path 仍在列表且仍是同一 draft 意图，清 dirty、更新 content。
- `closeFile`：若 dirty → `await saveFile(path)`；从数组删除；若删的是 active → 选 `index` 右侧否则左侧；空列表 → `activePath=null` + `setEditorVisible(false)`。
- `closeEditor`：对每个 dirty `await saveFile`，然后清空列表 + hide。
- `setDraft`：只改 `activePath` 对应项。
- `syncExternalChange`：对每个命中的 open file 应用现有 dirty/stale 或静默重载逻辑。
- `reloadEditor` / `dismissStale`：作用于 active。

删除所有对 `editorFile` 的引用。

- [ ] **Step 4: 更新 App 挂载条件**

`src/App.tsx`：

```ts
const hasOpenEditors = useFsStore((s) => s.openFiles.length > 0);
// ...
editorPanel={hasOpenEditors ? <EditorPanel /> : null}
```

- [ ] **Step 5: 临时让 EditorPanel 编译通过**

在 Task 4 完整改 UI 前，先把 `EditorPanel.tsx` 改为读 `openFiles` / `activePath`：

```ts
const openFiles = useFsStore((s) => s.openFiles);
const activePath = useFsStore((s) => s.activePath);
const editorFile = openFiles.find((f) => f.path === activePath) ?? null;
// close 按钮改为 closeFile(activePath!) 或先 closeEditor
```

快捷键里把 `fs.editorFile` 换成 active 文件查找。确保 `pnpm exec tsc --noEmit` 可通过（允许 UI 仍是单标签样式，Task 4 再做标签栏）。

- [ ] **Step 6: 跑测试**

Run: `pnpm test -- src/stores/fs.store.editor.test.ts`

Expected: PASS

Run: `pnpm exec tsc --noEmit`

Expected: exit 0

- [ ] **Step 7: Commit**

```bash
git add src/stores/fs.store.ts src/stores/fs.store.editor.test.ts src/App.tsx src/features/editor/EditorPanel.tsx
git commit -m "feat(editor): fs.store 支持多标签打开与关闭"
```

---

### Task 3: 自动保存设置 + debounce

**Files:**
- Modify: `src/stores/settings.store.ts`
- Modify: `src/features/settings/SettingsPanel.tsx`
- Modify: `src/stores/fs.store.ts`（debounce + switch/close flush timer）
- Modify: `src/stores/fs.store.editor.test.ts`

**Interfaces:**
- Produces:
  - `editorAutoSave: boolean`（default `true`）
  - `setEditorAutoSave(v: boolean): void`
  - settings key `"editor.autoSave"`
  - 模块级 `Map<path, ReturnType<typeof setTimeout>>` 或单 active timer；`AUTO_SAVE_MS = 1500`
  - `scheduleAutoSave(path: string)` / `flushAutoSave(path: string): Promise<void>` / `clearAutoSave(path: string)`（可作 store 内部函数，不必导出）

- [ ] **Step 1: 扩展自动保存测试**

在 `fs.store.editor.test.ts` 增加（用可变 mock 控制 `editorAutoSave`）：

```ts
let editorAutoSave = false;
vi.mock("./settings.store", () => ({
  useSettingsStore: {
    getState: () => ({ editorAutoSave }),
  },
}));

it("autosaves dirty active file after 1500ms when enabled", async () => {
  vi.useFakeTimers();
  editorAutoSave = true;
  fsReadFile.mockResolvedValueOnce({ is_text: true, content: "a", size: 1 });
  await useFsStore.getState().openFile("/p/a.ts");
  useFsStore.getState().setDraft("a!");
  fsWriteFile.mockResolvedValue(undefined);
  await vi.advanceTimersByTimeAsync(1499);
  expect(fsWriteFile).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(fsWriteFile).toHaveBeenCalledWith("/p/a.ts", "a!");
  vi.useRealTimers();
  editorAutoSave = false;
});

it("does not autosave when setting is off", async () => {
  vi.useFakeTimers();
  editorAutoSave = false;
  fsReadFile.mockResolvedValueOnce({ is_text: true, content: "a", size: 1 });
  await useFsStore.getState().openFile("/p/a.ts");
  useFsStore.getState().setDraft("a!");
  await vi.advanceTimersByTimeAsync(2000);
  expect(fsWriteFile).not.toHaveBeenCalled();
  vi.useRealTimers();
});

it("switchFile flushes pending autosave for previous file", async () => {
  vi.useFakeTimers();
  editorAutoSave = true;
  fsReadFile
    .mockResolvedValueOnce({ is_text: true, content: "a", size: 1 })
    .mockResolvedValueOnce({ is_text: true, content: "b", size: 1 });
  await useFsStore.getState().openFile("/p/a.ts");
  await useFsStore.getState().openFile("/p/b.ts");
  await useFsStore.getState().switchFile("/p/a.ts");
  useFsStore.getState().setDraft("a!");
  fsWriteFile.mockResolvedValue(undefined);
  await useFsStore.getState().switchFile("/p/b.ts");
  expect(fsWriteFile).toHaveBeenCalledWith("/p/a.ts", "a!");
  vi.useRealTimers();
  editorAutoSave = false;
});
```

- [ ] **Step 2: 跑测试确认新用例失败**

Run: `pnpm test -- src/stores/fs.store.editor.test.ts`

Expected: autosave 相关 FAIL

- [ ] **Step 3: settings.store 增加 autoSave**

在 `KEYS` 增加 `autoSave: "editor.autoSave"`。

State 增加：

```ts
editorAutoSave: boolean; // default true
setEditorAutoSave: (v: boolean) => void;
```

`load` 中读取 boolean；`setEditorAutoSave` 写 zustand + `settingsStore.set(KEYS.autoSave, v)`。

- [ ] **Step 4: fs.store debounce**

在 `fs.store.ts` 文件顶层（store 外）：

```ts
import { useSettingsStore } from "./settings.store";

const AUTO_SAVE_MS = 1500;
const autoSaveTimers = new Map<string, ReturnType<typeof setTimeout>>();

function clearAutoSaveTimer(path: string) {
  const t = autoSaveTimers.get(path);
  if (t) {
    clearTimeout(t);
    autoSaveTimers.delete(path);
  }
}

function scheduleAutoSave(path: string) {
  if (!useSettingsStore.getState().editorAutoSave) return;
  clearAutoSaveTimer(path);
  autoSaveTimers.set(
    path,
    setTimeout(() => {
      autoSaveTimers.delete(path);
      void useFsStore.getState().saveFile(path);
    }, AUTO_SAVE_MS),
  );
}

async function flushAutoSave(path: string) {
  clearAutoSaveTimer(path);
  const file = useFsStore.getState().openFiles.find((f) => f.path === path);
  if (file?.dirty) await useFsStore.getState().saveFile(path);
}
```

- `setDraft` 末尾：对 active path 调用 `scheduleAutoSave(path)`  
- `switchFile`：先 `await flushAutoSave(previousActive)`（若有），再切  
- `closeFile`：先 `clearAutoSaveTimer` + 现有 dirty save（已覆盖）  
- `saveFile` 成功后：`clearAutoSaveTimer(path)`  

注意：`useFsStore` 在 schedule 回调里引用时，需确保 store 已创建（timer 只在用户操作后触发，安全）。若循环引用告警，把 `scheduleAutoSave` 放到 store 工厂内部用 `get`。

- [ ] **Step 5: SettingsPanel UI**

在「外观」与「终端」之间（或终端之后）增加：

```tsx
import { Switch } from "@glinui/ui";
// ...
const { editorAutoSave, setEditorAutoSave, /* existing */ } = useSettingsStore();

<section>
  <div className={SECTION_HEADER}>编辑器</div>
  <div className="flex items-center justify-between gap-3">
    <div className="min-w-0">
      <Label htmlFor="editor-autosave">自动保存</Label>
      <p className="text-xs text-[var(--text-tertiary)]">停止输入约 1.5 秒后写入磁盘</p>
    </div>
    <Switch
      id="editor-autosave"
      checked={editorAutoSave}
      onCheckedChange={setEditorAutoSave}
    />
  </div>
</section>
```

- [ ] **Step 6: 跑测试 + tsc**

Run: `pnpm test -- src/stores/fs.store.editor.test.ts`  
Expected: PASS  

Run: `pnpm exec tsc --noEmit`  
Expected: exit 0

- [ ] **Step 7: Commit**

```bash
git add src/stores/settings.store.ts src/stores/fs.store.ts src/stores/fs.store.editor.test.ts src/features/settings/SettingsPanel.tsx
git commit -m "feat(editor): 设置项自动保存与 1.5s debounce"
```

---

### Task 4: EditorPanel 多标签 UI + 布局滚动

**Files:**
- Modify: `src/features/editor/EditorPanel.tsx`
- Modify: `src/features/layout/MainLayout.tsx`（仅当需要补 `min-h-0` / `h-full`）

**Interfaces:**
- Consumes: `openFiles`, `activePath`, `switchFile`, `closeFile`, `saveFile`, `setDraft`, `fileBasename`, `relativeToProject`；`useProjectStore` 取 active 项目 path；现有 error/stale API

- [ ] **Step 1: 改 EditorPanel 结构**

根节点：

```tsx
<div className={editorVisible ? "flex flex-col h-full min-h-0" : "hidden"}>
```

标签栏（可横向滚动）：

```tsx
<div className="flex items-center gap-1 px-2 py-1.5 border-b border-[color:var(--border-subtle)] overflow-x-auto shrink-0">
  {openFiles.map((f) => {
    const active = f.path === activePath;
    const projectPath = /* active project path from useProjectStore */;
    return (
      <div
        key={f.path}
        className={`flex items-center gap-1 max-w-[160px] rounded-[var(--radius-sm)] px-2 py-1 text-xs cursor-pointer shrink-0 ${
          active
            ? "bg-[var(--glass-2-surface)] text-[var(--text-primary)]"
            : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
        }`}
        title={relativeToProject(f.path, projectPath)}
        onClick={() => void switchFile(f.path)}
      >
        <span className="truncate">{fileBasename(f.path)}</span>
        {f.dirty && <span className="text-[var(--accent)]" title="未保存的修改">●</span>}
        <span
          role="button"
          className="opacity-50 hover:opacity-100"
          onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
          onClick={(e) => {
            e.stopPropagation();
            void closeFile(f.path);
          }}
        >
          <X size={12} />
        </span>
      </div>
    );
  })}
  <div className="flex-1" />
  <Button
    size="sm"
    variant="ghost"
    disabled={!editorFile?.dirty || !editorFile?.isText}
    onClick={() => void saveFile()}
  >
    保存
  </Button>
</div>
```

错误条 / stale 条：`shrink-0`，逻辑针对 `editorFile`（active）。

内容区：

```tsx
<div className="flex-1 min-h-0 overflow-hidden">
  {editorFile?.isText ? (
    <CodeMirror
      key={editorFile.path}
      value={editorFile.draft}
      height="100%"
      // extensions 在 Task 5 加
      ...
    />
  ) : (
    ...
  )}
</div>
```

快捷键：Ctrl/Cmd+S 保存 active；Esc 仍只 hide。

- [ ] **Step 2: MainLayout 核对**

确认编辑器列：

```tsx
<div
  className="flex flex-col h-full border-l ... overflow-hidden ..."
  style={{ width: editorWidth }}
>
  <div className="flex-1 min-h-0 overflow-hidden">{editorPanel}</div>
</div>
```

父行已是 `flex flex-1 overflow-hidden`；若编辑器列缺少 `h-full`/`min-h-0`，补上。

- [ ] **Step 3: 类型检查**

Run: `pnpm exec tsc --noEmit`  
Expected: exit 0

- [ ] **Step 4: Commit**

```bash
git add src/features/editor/EditorPanel.tsx src/features/layout/MainLayout.tsx
git commit -m "feat(editor): 多标签栏与等高可滚动布局"
```

---

### Task 5: 语法高亮

**Files:**
- Create: `src/features/editor/language.ts`
- Create: `src/features/editor/language.test.ts`
- Modify: `src/features/editor/EditorPanel.tsx`
- Modify: `package.json`（依赖）

**Interfaces:**
- Produces: `languageExtensionsForPath(path: string): Extension[]`

- [ ] **Step 1: 安装依赖**

```bash
pnpm add @codemirror/lang-javascript @codemirror/lang-json @codemirror/lang-css @codemirror/lang-html @codemirror/lang-markdown @codemirror/lang-python @codemirror/lang-rust @codemirror/lang-go @codemirror/lang-yaml @codemirror/lang-toml @codemirror/language @codemirror/legacy-modes
```

- [ ] **Step 2: 写 language 测试**

```ts
import { describe, expect, it } from "vitest";
import { languageExtensionsForPath } from "./language";

describe("languageExtensionsForPath", () => {
  it("returns a non-empty extension array for known types", () => {
    expect(languageExtensionsForPath("a.ts").length).toBeGreaterThan(0);
    expect(languageExtensionsForPath("a.py").length).toBeGreaterThan(0);
    expect(languageExtensionsForPath("a.rs").length).toBeGreaterThan(0);
    expect(languageExtensionsForPath("a.sh").length).toBeGreaterThan(0);
  });

  it("returns empty for unknown extensions", () => {
    expect(languageExtensionsForPath("a.unknownext")).toEqual([]);
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `pnpm test -- src/features/editor/language.test.ts`  
Expected: FAIL

- [ ] **Step 4: 实现 language.ts**

```ts
import type { Extension } from "@codemirror/state";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { rust } from "@codemirror/lang-rust";
import { go } from "@codemirror/lang-go";
import { yaml } from "@codemirror/lang-yaml";
import { toml } from "@codemirror/lang-toml";
import { StreamLanguage } from "@codemirror/language";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { fileBasename } from "./pathUtils";

export function languageExtensionsForPath(path: string): Extension[] {
  const name = fileBasename(path);
  const dot = name.lastIndexOf(".");
  const ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
  switch (ext) {
    case "ts":
    case "tsx":
      return [javascript({ typescript: true, jsx: ext === "tsx" })];
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
      return [javascript({ jsx: ext === "jsx" })];
    case "json":
      return [json()];
    case "css":
      return [css()];
    case "html":
    case "htm":
      return [html()];
    case "md":
    case "markdown":
      return [markdown()];
    case "py":
      return [python()];
    case "rs":
      return [rust()];
    case "go":
      return [go()];
    case "toml":
      return [toml()];
    case "yml":
    case "yaml":
      return [yaml()];
    case "sh":
    case "bash":
      return [StreamLanguage.define(shell)];
    default:
      return [];
  }
}
```

若 `@codemirror/state` 未直接安装，从现有 `@uiw/react-codemirror` 传递依赖引用；若 tsc 报缺失则 `pnpm add @codemirror/state`。

- [ ] **Step 5: 接入 EditorPanel**

```tsx
import { languageExtensionsForPath } from "./language";

<CodeMirror
  key={editorFile.path}
  value={editorFile.draft}
  height="100%"
  theme={editorTheme}
  extensions={[editorTheme, ...languageExtensionsForPath(editorFile.path)]}
  // 注意：若 theme 已通过 theme= 传入，不要重复塞进 extensions；保持现有 theme= 写法，extensions 只放 language：
  extensions={languageExtensionsForPath(editorFile.path)}
  onChange={setDraft}
  onCreateEditor={(view) => { viewRef.current = view; }}
/>
```

- [ ] **Step 6: 测试 + tsc**

Run: `pnpm test`  
Expected: all PASS  

Run: `pnpm exec tsc --noEmit`  
Expected: exit 0  

Run: `pnpm lint`（或项目惯用 oxlint）  
Expected: 无新增 error

- [ ] **Step 7: Commit**

```bash
git add package.json pnpm-lock.yaml src/features/editor/language.ts src/features/editor/language.test.ts src/features/editor/EditorPanel.tsx
git commit -m "feat(editor): 按扩展名启用 CodeMirror 语法高亮"
```

---

### Task 6: 手动验收清单

**Files:** 无代码（或仅修验收中发现的小问题）

- [ ] **Step 1: 启动应用**

Run: `pnpm tauri dev`（或使用已在跑的实例，确认 HMR/重编译）

- [ ] **Step 2: 按清单点验**

| # | 检查项 | 期望 |
|---|---|---|
| 1 | 打开长文本文件 | 编辑器高度与侧栏一致，可滚动 |
| 2 | 打开 2+ 文件 | 多标签；只显示文件名；悬停为项目相对路径 |
| 3 | Ctrl/Cmd+S | 清除 dirty ● |
| 4 | 设置 → 自动保存 ON，编辑后停 1.5s | 自动清 dirty |
| 5 | 自动保存 OFF | 停输入不写盘，需手动保存 |
| 6 | 关脏标签 | 无确认框；内容已写入磁盘 |
| 7 | 打开 `.ts` / `.rs` / `.py` / `.md` | 可见语法高亮 |
| 8 | Esc | 面板隐藏；再从文件树打开同文件，草稿仍在 |

- [ ] **Step 3: 若有小修复，单独 commit**

```bash
git commit -m "fix(editor): <简述验收修复>"
```

---

## Spec Coverage Self-Review

| Spec 要求 | Task |
|---|---|
| 等高 + 滚动 | Task 4 |
| 文件名 + 悬停项目路径 | Task 1 + 4 |
| 多标签 | Task 2 + 4 |
| Ctrl/Cmd+S | Task 4（保留，基于 active） |
| 自动保存开关 + 1.5s debounce | Task 3 |
| 关脏 flush | Task 2/3 |
| 切标签 flush pending | Task 3 |
| Esc 只隐藏 | Task 4（保持） |
| 语法高亮语言表 | Task 5 |
| syncExternalChange 多文件 | Task 2 |
| 设置持久化 `editor.autoSave` | Task 3 |
| 非目标（持久化标签/LSP 等） | 未纳入 |

## Placeholder / Consistency Check

- 无 TBD；debounce 固定 1500；API 名在 Task 2/3 一致（`openFiles`/`activePath`/`switchFile`/`closeFile`/`editorAutoSave`）
- Shell 高亮明确用 `@codemirror/legacy-modes`
- Windows 路径在 `pathUtils` 与测试中覆盖

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-26-editor-panel-multi-tab.md`. Two execution options:

**1. Subagent-Driven (recommended)** — 每个 Task 派一个新子代理，Task 间审查，迭代快  

**2. Inline Execution** — 本会话用 executing-plans 按 Task 执行，设检查点  

Which approach?
