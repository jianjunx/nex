import { beforeEach, describe, expect, it, vi } from "vitest";

const fsReadFile = vi.fn();
const fsWriteFile = vi.fn();
const setEditorVisible = vi.fn();
const syncEditorVisibleForProject = vi.fn();

vi.mock("../bridge/tauri", () => ({
  fsReadFile: (...args: unknown[]) => fsReadFile(...args),
  fsWriteFile: (...args: unknown[]) => fsWriteFile(...args),
  fsReadTree: vi.fn(),
  fsExpandDir: vi.fn(),
  fsSearch: vi.fn(),
}));

vi.mock("./ui.store", () => ({
  useUiStore: {
    getState: () => ({
      setEditorVisible,
      syncEditorVisibleForProject,
      editorVisibleByProject: {},
    }),
  },
}));

let editorAutoSave = false;
vi.mock("./settings.store", () => ({
  useSettingsStore: {
    getState: () => ({ editorAutoSave }),
  },
}));

import { clearAllAutoSaveTimers, EDITOR_CACHE_MAX_PROJECTS, useFsStore, __resetEditorCacheLru, __resetSelfWriteForTest } from "./fs.store";

describe("fs.store multi-tab editor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    editorAutoSave = false;
    clearAllAutoSaveTimers();
    __resetSelfWriteForTest();
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

  it("syncExternalChange marks dirty stale only when disk truly diverges", async () => {
    fsReadFile.mockResolvedValueOnce({ is_text: true, content: "a", size: 1 });
    await useFsStore.getState().openFile("/p/a.ts");
    useFsStore.getState().setDraft("edit");
    fsReadFile.mockResolvedValueOnce({ is_text: true, content: "external", size: 8 });
    await useFsStore.getState().syncExternalChange(["/p/a.ts"]);
    expect(useFsStore.getState().openFiles[0].stale).toBe(true);

    // clean file silent reload
    useFsStore.setState((s) => {
      s.openFiles[0].draft = "a";
      s.openFiles[0].content = "a";
      s.openFiles[0].dirty = false;
      s.openFiles[0].stale = false;
    });
    fsReadFile.mockResolvedValueOnce({ is_text: true, content: "disk", size: 4 });
    await useFsStore.getState().syncExternalChange(["/p/a.ts"]);
    expect(useFsStore.getState().openFiles[0].draft).toBe("disk");
  });

  it("syncExternalChange ignores autosave echo while user kept typing", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fsReadFile.mockResolvedValueOnce({ is_text: true, content: "a", size: 1 });
    await useFsStore.getState().openFile("/p/a.ts");
    useFsStore.getState().setDraft("saved");
    fsWriteFile.mockResolvedValueOnce(undefined);
    await useFsStore.getState().saveFile();
    // 继续输入：dirty 再次为 true，但磁盘仍是刚写的内容。
    useFsStore.getState().setDraft("saved+more");
    // 宽限期过后再收到 watcher（autosave 回声晚到）。
    await vi.advanceTimersByTimeAsync(700);
    fsReadFile.mockResolvedValueOnce({ is_text: true, content: "saved", size: 5 });
    await useFsStore.getState().syncExternalChange(["/p/a.ts"]);
    const f = useFsStore.getState().openFiles[0];
    expect(f.stale).toBe(false);
    expect(f.dirty).toBe(true);
    expect(f.draft).toBe("saved+more");
    vi.useRealTimers();
  });

  it("syncExternalChange does not mark stale when disk still matches known snapshot", async () => {
    fsReadFile.mockResolvedValueOnce({ is_text: true, content: "a", size: 1 });
    await useFsStore.getState().openFile("/p/a.ts");
    useFsStore.getState().setDraft("edit");
    // 磁盘未变（误报 watcher / 无实质变更）
    fsReadFile.mockResolvedValueOnce({ is_text: true, content: "a", size: 1 });
    await useFsStore.getState().syncExternalChange(["/p/a.ts"]);
    expect(useFsStore.getState().openFiles[0].stale).toBe(false);
    expect(useFsStore.getState().openFiles[0].draft).toBe("edit");
  });

  it("syncExternalChange adopts disk when it already matches draft", async () => {
    fsReadFile.mockResolvedValueOnce({ is_text: true, content: "a", size: 1 });
    await useFsStore.getState().openFile("/p/a.ts");
    useFsStore.getState().setDraft("same");
    fsReadFile.mockResolvedValueOnce({ is_text: true, content: "same", size: 4 });
    await useFsStore.getState().syncExternalChange(["/p/a.ts"]);
    const f = useFsStore.getState().openFiles[0];
    expect(f.stale).toBe(false);
    expect(f.dirty).toBe(false);
    expect(f.content).toBe("same");
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

  it("snapshots a dirty editor before the disk write, then flushes that draft", async () => {
    __resetEditorCacheLru();
    fsReadFile.mockResolvedValueOnce({ is_text: true, content: "a", size: 1 });
    await useFsStore.getState().openFile("/p/a.ts", true);
    useFsStore.getState().setDraft("a!");
    let resolveWrite: (value?: unknown) => void = () => {};
    fsWriteFile.mockReturnValue(new Promise((resolve) => {
      resolveWrite = resolve;
    }));

    const pending = useFsStore.getState().saveCurrentEditorState("proj-swap");
    expect(useFsStore.getState().editorCacheByProject["proj-swap"]?.openFiles[0]?.draft).toBe("a!");
    useFsStore.setState({ openFiles: [], activePath: null });
    resolveWrite();
    await pending;

    expect(fsWriteFile).toHaveBeenCalledWith("/p/a.ts", "a!");
    expect(useFsStore.getState().editorCacheByProject["proj-swap"]?.openFiles[0]?.dirty).toBe(false);
  });

  it("drops a cold editor restore once a newer switch has taken over", async () => {
    let resolveRead: (value: unknown) => void = () => {};
    fsReadFile.mockReturnValue(new Promise((resolve) => {
      resolveRead = resolve;
    }));
    useFsStore.setState({
      editorCacheByProject: {},
      editorLayoutByProject: {
        slow: { paths: ["/slow.ts"], activePath: "/slow.ts" },
      },
      openFiles: [],
      activePath: null,
    });
    let current = true;
    const pending = useFsStore.getState().loadEditorState("slow", () => current);
    expect(useFsStore.getState().openFiles).toEqual([]);

    current = false;
    const kept = {
      path: "/kept.ts",
      content: "k",
      isText: true,
      size: 1,
      draft: "k",
      dirty: false,
      stale: false,
      pinned: true,
    };
    useFsStore.setState({ openFiles: [kept], activePath: "/kept.ts" });
    resolveRead({ is_text: true, content: "slow", size: 4 });
    await pending;

    expect(useFsStore.getState().activePath).toBe("/kept.ts");
    expect(useFsStore.getState().openFiles.map((f) => f.path)).toEqual(["/kept.ts"]);
  });

  it("editorCacheByProject evicts LRU projects beyond the cap (layout kept for cold restore)", async () => {
    __resetEditorCacheLru();
    useFsStore.setState({
      editorCacheByProject: {},
      editorLayoutByProject: {},
      openFiles: [],
      activePath: null,
    });
    const g = useFsStore.getState();
    // Save cap+1 projects → the oldest (proj-0) must be evicted.
    for (let i = 0; i <= EDITOR_CACHE_MAX_PROJECTS; i++) {
      await g.saveCurrentEditorState(`proj-${i}`);
    }
    let s = useFsStore.getState();
    expect(Object.keys(s.editorCacheByProject)).toHaveLength(EDITOR_CACHE_MAX_PROJECTS);
    expect(s.editorCacheByProject["proj-0"]).toBeUndefined();
    expect(s.editorCacheByProject[`proj-${EDITOR_CACHE_MAX_PROJECTS}`]).toBeDefined();
    // Evicted project keeps its persisted layout so cold restore still works.
    expect(s.editorLayoutByProject["proj-0"]).toBeDefined();

    // Touch proj-1 (re-save), then add one more → proj-2 is evicted, proj-1 kept.
    await g.saveCurrentEditorState("proj-1");
    await g.saveCurrentEditorState("proj-new");
    s = useFsStore.getState();
    expect(Object.keys(s.editorCacheByProject)).toHaveLength(EDITOR_CACHE_MAX_PROJECTS);
    expect(s.editorCacheByProject["proj-1"]).toBeDefined();
    expect(s.editorCacheByProject["proj-2"]).toBeUndefined();
  });
});

describe("fs.store editor restore races", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    editorAutoSave = false;
    clearAllAutoSaveTimers();
    __resetSelfWriteForTest();
    __resetEditorCacheLru();
    useFsStore.setState({
      openFiles: [],
      activePath: null,
      error: null,
      loading: false,
      editorCacheByProject: {},
      editorLayoutByProject: {},
      nodesByDir: {},
      expandedDirs: new Set(),
      selectedPath: null,
      pendingRenamePath: null,
      pendingDeletePath: null,
    });
  });

  const file = (path: string, draft = "", over: Partial<{ dirty: boolean; stale: boolean }> = {}) => ({
    path,
    content: draft,
    isText: true,
    size: 0,
    draft,
    dirty: false,
    stale: false,
    pinned: true,
    ...over,
  });

  // 快速连切两个项目时，中间那个项目的冷恢复还没落地，openFiles 是空的。
  // 这次快照曾把空布局持久化下去，该项目的页签就永久没了。
  it("does not persist an empty layout for a project whose restore is in flight", async () => {
    useFsStore.setState({
      editorLayoutByProject: { p1: { paths: ["/p1/a.ts"], activePath: "/p1/a.ts" } },
    });
    // 让 p1 的冷恢复卡住，模拟"读盘还没回来"
    let release!: () => void;
    fsReadFile.mockImplementation(() => new Promise((r) => { release = () => r({ is_text: true, content: "x", size: 1 }); }));

    const restoring = useFsStore.getState().loadEditorState("p1");
    await Promise.resolve();
    expect(useFsStore.getState().openFiles).toEqual([]);

    // 用户在恢复落地前又切走了 → saveCurrentEditorState(p1) 必须拒绝做快照
    await useFsStore.getState().saveCurrentEditorState("p1");

    expect(useFsStore.getState().editorLayoutByProject.p1).toEqual({
      paths: ["/p1/a.ts"],
      activePath: "/p1/a.ts",
    });
    expect(useFsStore.getState().editorCacheByProject.p1).toBeUndefined();

    release();
    await restoring;
  });

  it("still saves normally once the restore has finished", async () => {
    useFsStore.setState({ openFiles: [file("/p1/a.ts", "v")], activePath: "/p1/a.ts" });
    await useFsStore.getState().saveCurrentEditorState("p1");
    expect(useFsStore.getState().editorLayoutByProject.p1).toEqual({
      paths: ["/p1/a.ts"],
      activePath: "/p1/a.ts",
    });
  });

  // 冷恢复跨多个 await，这期间用户手动打开的文件不能被整体赋值丢掉。
  it("keeps tabs the user opened while a cold restore was still reading", async () => {
    useFsStore.setState({
      editorLayoutByProject: { p1: { paths: ["/p1/a.ts", "/p1/b.ts"], activePath: "/p1/a.ts" } },
    });
    fsReadFile.mockImplementation((p: string) =>
      Promise.resolve({ is_text: true, content: `content of ${p}`, size: 4 }),
    );

    const restoring = useFsStore.getState().loadEditorState("p1");
    await Promise.resolve();
    // 恢复进行中，用户从文件树点开了一个不在布局里的文件
    useFsStore.setState((s) => {
      s.openFiles.push(file("/p1/user-picked.ts", "mine"));
      s.activePath = "/p1/user-picked.ts";
    });

    await restoring;

    const paths = useFsStore.getState().openFiles.map((f) => f.path);
    expect(paths).toContain("/p1/user-picked.ts");
    expect(paths).toContain("/p1/a.ts");
    expect(paths).toContain("/p1/b.ts");
    // 用户已经停在自已打开的文件上，别把焦点抢回布局里的活动页签
    expect(useFsStore.getState().activePath).toBe("/p1/user-picked.ts");
  });

  // 快照之后磁盘被外部改动（stale），flush 不能把它静默回滚。
  it("skips a draft whose file went stale after the snapshot", async () => {
    useFsStore.setState({
      openFiles: [
        file("/p1/a.ts", "v2", { dirty: true }),
        file("/p1/b.ts", "w2", { dirty: true }),
      ],
      activePath: "/p1/a.ts",
    });
    const snapshotted = useFsStore.getState().saveCurrentEditorState("p1");
    // 第一个写盘还在飞，第二个文件被外部改动了
    useFsStore.setState((s) => {
      const b = s.openFiles.find((f) => f.path === "/p1/b.ts");
      if (b) b.stale = true;
    });
    await snapshotted;

    const written = fsWriteFile.mock.calls.map((c) => c[0]);
    expect(written).toContain("/p1/a.ts");
    expect(written).not.toContain("/p1/b.ts");
  });
});
