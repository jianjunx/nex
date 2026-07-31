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

let editorAutoSave = false;
vi.mock("./settings.store", () => ({
  useSettingsStore: {
    getState: () => ({ editorAutoSave }),
  },
}));

import { clearAllAutoSaveTimers, useFsStore } from "./fs.store";

describe("fs.store multi-tab editor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    editorAutoSave = false;
    clearAllAutoSaveTimers();
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
    // pin:true —— 固定标签，避免被预览模式（未固定单开）替换
    await useFsStore.getState().openFile("/p/a.ts", true);
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
    // pin:true —— 固定标签，避免被预览模式（未固定单开）替换
    await useFsStore.getState().openFile("/p/a.ts", true);
    await useFsStore.getState().openFile("/p/b.ts");
    useFsStore.getState().setDraft("b!");
    fsWriteFile.mockResolvedValueOnce(undefined);
    await useFsStore.getState().closeFile("/p/b.ts");
    expect(fsWriteFile).toHaveBeenCalledWith("/p/b.ts", "b!");
    expect(useFsStore.getState().openFiles.map((f) => f.path)).toEqual(["/p/a.ts"]);
    expect(useFsStore.getState().activePath).toBe("/p/a.ts");
  });

  it("closeFile keeps dirty tab when save fails", async () => {
    fsReadFile.mockResolvedValueOnce({ is_text: true, content: "a", size: 1 });
    await useFsStore.getState().openFile("/p/a.ts");
    useFsStore.getState().setDraft("a!");
    fsWriteFile.mockRejectedValueOnce(new Error("disk full"));
    await useFsStore.getState().closeFile("/p/a.ts");
    expect(useFsStore.getState().openFiles.map((f) => f.path)).toEqual(["/p/a.ts"]);
    expect(useFsStore.getState().openFiles[0].dirty).toBe(true);
    expect(useFsStore.getState().error).toBeTruthy();
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

  it("disabling autosave cancels already-scheduled timers", async () => {
    vi.useFakeTimers();
    editorAutoSave = true;
    fsReadFile.mockResolvedValueOnce({ is_text: true, content: "a", size: 1 });
    await useFsStore.getState().openFile("/p/a.ts");
    useFsStore.getState().setDraft("a!");
    fsWriteFile.mockResolvedValue(undefined);
    // Simulate setEditorAutoSave(false): flip setting + clear pending timers.
    editorAutoSave = false;
    clearAllAutoSaveTimers();
    await vi.advanceTimersByTimeAsync(2000);
    expect(fsWriteFile).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("timer callback skips save when autosave was turned off", async () => {
    vi.useFakeTimers();
    editorAutoSave = true;
    fsReadFile.mockResolvedValueOnce({ is_text: true, content: "a", size: 1 });
    await useFsStore.getState().openFile("/p/a.ts");
    useFsStore.getState().setDraft("a!");
    fsWriteFile.mockResolvedValue(undefined);
    // Flip setting without clearing timers — callback must re-check.
    editorAutoSave = false;
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
    // pin:true —— 固定标签，避免被预览模式（未固定单开）替换
    await useFsStore.getState().openFile("/p/a.ts", true);
    await useFsStore.getState().openFile("/p/b.ts");
    await useFsStore.getState().switchFile("/p/a.ts");
    useFsStore.getState().setDraft("a!");
    fsWriteFile.mockResolvedValue(undefined);
    await useFsStore.getState().switchFile("/p/b.ts");
    expect(fsWriteFile).toHaveBeenCalledWith("/p/a.ts", "a!");
    vi.useRealTimers();
    editorAutoSave = false;
  });

  it("openFile flushes pending autosave for previous file before 1500ms", async () => {
    vi.useFakeTimers();
    editorAutoSave = true;
    fsReadFile
      .mockResolvedValueOnce({ is_text: true, content: "a", size: 1 })
      .mockResolvedValueOnce({ is_text: true, content: "b", size: 1 });
    await useFsStore.getState().openFile("/p/a.ts");
    useFsStore.getState().setDraft("a!");
    fsWriteFile.mockResolvedValue(undefined);
    await useFsStore.getState().openFile("/p/b.ts");
    expect(fsWriteFile).toHaveBeenCalledWith("/p/a.ts", "a!");
    vi.useRealTimers();
    editorAutoSave = false;
  });
});

describe("fs.store diff tabs", () => {
  const PAYLOAD = {
    mode: "merge" as const,
    title: "a.txt（已暂存）",
    languageHint: "a.txt",
    original: "v1",
    revised: "v2",
    binary: false,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    editorAutoSave = false;
    clearAllAutoSaveTimers();
    useFsStore.setState({ openFiles: [], activePath: null, error: null, loading: false });
  });

  it("openDiffTab adds a permanently pinned diff tab and activates it", () => {
    useFsStore.getState().openDiffTab("diff:staged:a.txt", PAYLOAD);
    const s = useFsStore.getState();
    expect(s.openFiles).toHaveLength(1);
    expect(s.openFiles[0].diff).toEqual(PAYLOAD);
    expect(s.openFiles[0].pinned).toBe(true);
    expect(s.activePath).toBe("diff:staged:a.txt");
    expect(setEditorVisible).toHaveBeenCalledWith(true);
  });

  it("re-opening the same diff id updates the payload in place without adding a tab", () => {
    useFsStore.getState().openDiffTab("diff:staged:a.txt", PAYLOAD);
    useFsStore.getState().openDiffTab("diff:staged:a.txt", { ...PAYLOAD, revised: "v3" });
    const s = useFsStore.getState();
    expect(s.openFiles).toHaveLength(1);
    expect(s.openFiles[0].diff?.revised).toBe("v3");
    expect(s.activePath).toBe("diff:staged:a.txt");
  });

  it("setDraft is a no-op on the active diff tab", () => {
    useFsStore.getState().openDiffTab("diff:staged:a.txt", PAYLOAD);
    useFsStore.getState().setDraft("hacked");
    const f = useFsStore.getState().openFiles[0];
    expect(f.draft).toBe("");
    expect(f.dirty).toBe(false);
  });

  it("saveCurrentEditorState excludes diff tabs from persisted paths but keeps them in the session cache", async () => {
    fsReadFile.mockResolvedValueOnce({ is_text: true, content: "x", size: 1 });
    await useFsStore.getState().openFile("/p/x.ts", true);
    useFsStore.getState().openDiffTab("diff:staged:a.txt", PAYLOAD);

    await useFsStore.getState().saveCurrentEditorState("proj-1");
    const s = useFsStore.getState();
    expect(s.editorLayoutByProject["proj-1"].paths).toEqual(["/p/x.ts"]);
    expect(s.editorCacheByProject["proj-1"].openFiles).toHaveLength(2);
  });

  it("reloadEditor on a diff tab is a no-op (no disk read)", async () => {
    useFsStore.getState().openDiffTab("diff:staged:a.txt", PAYLOAD);
    fsReadFile.mockClear();
    await useFsStore.getState().reloadEditor();
    expect(fsReadFile).not.toHaveBeenCalled();
    expect(useFsStore.getState().openFiles[0].diff?.revised).toBe("v2");
  });
});
