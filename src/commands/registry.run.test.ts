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
