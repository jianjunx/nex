/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Module-level mutable bindings; mock factories read them lazily (TDZ-safe),
// same pattern as KeybindingHost.test.tsx.
let setEditorVisible: ReturnType<typeof vi.fn>;
let requestSearchFocus: ReturnType<typeof vi.fn>;
let fsState: {
  openFiles: { path: string; dirty: boolean }[];
  activePath: string | null;
  saveFile: ReturnType<typeof vi.fn>;
};
let findBarOpen = false;
let projectState: { projects: { id: string; path: string }[]; activeProjectId: string | null };
let gitCmdState: { commitWith: ReturnType<typeof vi.fn> };

vi.mock("../stores/ui.store", () => ({
  useUiStore: { getState: () => ({ setEditorVisible, requestSearchFocus }) },
}));
vi.mock("../stores/fs.store", () => ({
  useFsStore: { getState: () => fsState },
}));
vi.mock("./editorKeybindings", () => ({
  isFindBarOpen: () => findBarOpen,
  closeFindBar: () => findBarOpen,
}));
vi.mock("../stores/project.store", () => ({
  useProjectStore: { getState: () => projectState },
}));
vi.mock("../stores/git.store", () => ({
  useGitStore: { getState: () => gitCmdState },
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
  requestSearchFocus = vi.fn();
  fsState = { openFiles: [], activePath: null, saveFile: vi.fn() };
  findBarOpen = false;
  projectState = { projects: [], activeProjectId: null };
  gitCmdState = { commitWith: vi.fn() };
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

describe("scm.commit run", () => {
  it("commits via the git store for the active project", () => {
    projectState = { projects: [{ id: "p1", path: "/proj" }], activeProjectId: "p1" };
    getCommand("scm.commit")!.run();
    expect(gitCmdState.commitWith).toHaveBeenCalledWith("/proj", "commit");
  });

  it("is a no-op without an active project", () => {
    getCommand("scm.commit")!.run();
    expect(gitCmdState.commitWith).not.toHaveBeenCalled();
  });

  it("when() matches only the commit input", () => {
    const commitInput = document.createElement("input");
    commitInput.setAttribute("data-scm-commit-input", "");
    document.body.appendChild(commitInput);
    const other = document.createElement("input");
    document.body.appendChild(other);

    const when = getCommand("scm.commit")!.when!;
    commitInput.focus();
    expect(when()).toBe(true);
    other.focus();
    expect(when()).toBe(false);
    document.body.innerHTML = "";
  });
});

describe("search.focus run", () => {
  it("requests search focus through the ui store (counter trigger)", () => {
    getCommand("search.focus")!.run();
    expect(requestSearchFocus).toHaveBeenCalledTimes(1);
  });
});
