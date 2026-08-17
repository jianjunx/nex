/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Module-level mutable bindings; mock factories read them lazily (TDZ-safe),
// same pattern as KeybindingHost.test.tsx.
let setEditorVisible: ReturnType<typeof vi.fn>;
let requestSearchFocus: ReturnType<typeof vi.fn>;
let requestCloseActiveTab: ReturnType<typeof vi.fn>;
let fsState: {
  openFiles: { path: string; dirty: boolean; isText?: boolean; diff?: unknown; draft?: string }[];
  activePath: string | null;
  saveFile: ReturnType<typeof vi.fn>;
  closeFile: ReturnType<typeof vi.fn>;
  setDraft: ReturnType<typeof vi.fn>;
  error?: string | null;
};

let findBarOpen = false;
let currentView: { state: { doc: { length: number }; selection: { main: { from: number; to: number } } }; dispatch: ReturnType<typeof vi.fn> } | null = null;
let projectState: { projects: { id: string; path: string }[]; activeProjectId: string | null };
let gitCmdState: { commitWith: ReturnType<typeof vi.fn> };
const canFormatPath = vi.fn((path: string) => /\.(ts|tsx|js|jsx|json|css|html|md|yaml|yml)$/i.test(path));
const formatTextForPath = vi.fn(async (_path: string, text: string) => text);
const replaceWholeDocument = vi.fn();

vi.mock("../stores/ui.store", () => ({
  useUiStore: { getState: () => ({ setEditorVisible, requestSearchFocus, requestCloseActiveTab, editorVisible: true }) },
}));
vi.mock("../stores/fs.store", () => ({
  useFsStore: {
    getState: () => fsState,
    setState: (patch: Partial<typeof fsState>) => {
      fsState = { ...fsState, ...patch };
    },
  },
}));
vi.mock("./editorKeybindings", () => ({
  isFindBarOpen: () => findBarOpen,
  closeFindBar: () => findBarOpen,
  viewForFindBar: () => currentView,
}));
vi.mock("../stores/project.store", () => ({
  useProjectStore: { getState: () => projectState },
}));
vi.mock("../stores/git.store", () => ({
  useGitStore: { getState: () => gitCmdState },
}));
vi.mock("../features/editor/format", () => ({
  canFormatPath: (path: string) => canFormatPath(path),
  formatTextForPath: (path: string, text: string) => formatTextForPath(path, text),
  replaceWholeDocument: (view: unknown, text: string) => replaceWholeDocument(view, text),
}));

import { getCommand } from "./registry";
import { _resetCloseEscForTest } from "./keybindingHostState";

const runClose = () => getCommand("editor.close")!.run();
const runSave = () => getCommand("editor.save")!.run();
const runFormat = () => getCommand("editor.formatDocument")!.run();
const runCloseActiveTab = () => getCommand("workbench.closeActiveTab")!.run();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(10_000);
  _resetCloseEscForTest();
  setEditorVisible = vi.fn();
  requestSearchFocus = vi.fn();
  requestCloseActiveTab = vi.fn();
  fsState = { openFiles: [], activePath: null, saveFile: vi.fn(), closeFile: vi.fn(), setDraft: vi.fn(), error: null };
  findBarOpen = false;
  currentView = null;
  projectState = { projects: [], activeProjectId: null };
  gitCmdState = { commitWith: vi.fn() };
  canFormatPath.mockClear();
  formatTextForPath.mockReset();
  formatTextForPath.mockImplementation(async (_path: string, text: string) => text);
  replaceWholeDocument.mockClear();
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

describe("editor.formatDocument run", () => {
  it("formats the active file through the current editor view", async () => {
    fsState.openFiles = [{ path: "/p/a.ts", dirty: false, isText: true, draft: "const   x=1" }];
    fsState.activePath = "/p/a.ts";
    currentView = {
      state: { doc: { length: 11 }, selection: { main: { from: 3, to: 3 } } },
      dispatch: vi.fn(),
    };
    formatTextForPath.mockResolvedValueOnce("const x = 1;\n");

    runFormat();
    await Promise.resolve();
    await Promise.resolve();

    expect(formatTextForPath).toHaveBeenCalledWith("/p/a.ts", "const   x=1");
    expect(replaceWholeDocument).toHaveBeenCalledWith(currentView, "const x = 1;\n");
    expect(fsState.setDraft).not.toHaveBeenCalled();
  });

  it("falls back to fs.setDraft when no live editor view is registered", async () => {
    fsState.openFiles = [{ path: "/p/data.json", dirty: false, isText: true, draft: '{"a":1}' }];
    fsState.activePath = "/p/data.json";
    currentView = null;
    formatTextForPath.mockResolvedValueOnce('{\n  "a": 1\n}\n');

    runFormat();
    await Promise.resolve();
    await Promise.resolve();

    expect(fsState.setDraft).toHaveBeenCalledWith('{\n  "a": 1\n}\n');
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

describe("workbench.closeActiveTab run", () => {
  it("closes the active file when the editor is visible, even if focus left the editor", () => {
    fsState.openFiles = [{ path: "/p/a.ts", dirty: false }];
    fsState.activePath = "/p/a.ts";
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    outside.focus();

    runCloseActiveTab();

    expect(fsState.closeFile).toHaveBeenCalledWith("/p/a.ts");
    expect(requestCloseActiveTab).not.toHaveBeenCalled();
  });

  it("prefers closing the conversation tab when focus is in the conversation area", () => {
    fsState.openFiles = [{ path: "/p/a.ts", dirty: false }];
    fsState.activePath = "/p/a.ts";
    const composer = document.createElement("textarea");
    const host = document.createElement("div");
    host.setAttribute("data-conversation-area", "");
    host.appendChild(composer);
    document.body.appendChild(host);
    composer.focus();

    runCloseActiveTab();

    expect(requestCloseActiveTab).toHaveBeenCalledTimes(1);
    expect(fsState.closeFile).not.toHaveBeenCalled();
  });
});

describe("search.focus run", () => {
  it("requests search focus through the ui store (counter trigger)", () => {
    getCommand("search.focus")!.run();
    expect(requestSearchFocus).toHaveBeenCalledTimes(1);
  });
});
