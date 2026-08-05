import { beforeEach, describe, expect, it, vi } from "vitest";

const fsReadFile = vi.fn();
const fsSearch = vi.fn();
const fsSearchReplace = vi.fn();
const fsApplyReplace = vi.fn();
const fsWriteFile = vi.fn();
const setEditorVisible = vi.fn();
const syncEditorVisibleForProject = vi.fn();

vi.mock("../bridge/tauri", () => ({
  fsReadFile: (...args: unknown[]) => fsReadFile(...args),
  fsWriteFile: (...args: unknown[]) => fsWriteFile(...args),
  fsSearch: (...args: unknown[]) => fsSearch(...args),
  fsSearchReplace: (...args: unknown[]) => fsSearchReplace(...args),
  fsApplyReplace: (...args: unknown[]) => fsApplyReplace(...args),
  fsReadTree: vi.fn(),
  fsExpandDir: vi.fn(),
  fsCreateFile: vi.fn(),
  fsCreateDir: vi.fn(),
}));

vi.mock("./ui.store", () => ({
  useUiStore: { getState: () => ({ setEditorVisible, syncEditorVisibleForProject }) },
}));

let editorAutoSave = false;
vi.mock("./settings.store", () => ({
  useSettingsStore: { getState: () => ({ editorAutoSave }) },
}));

import { clearAllAutoSaveTimers, useFsStore } from "./fs.store";

beforeEach(() => {
  vi.clearAllMocks();
  editorAutoSave = false;
  clearAllAutoSaveTimers();
  useFsStore.setState({
    openFiles: [],
    activePath: null,
    error: null,
    loading: false,
    searchResults: [],
    searching: false,
    searchError: null,
    searchOptions: { caseSensitive: false, wholeWord: false, regex: false },
    replacePreview: null,
    replacing: false,
    pendingLine: null,
  });
});

describe("search options", () => {
  it("setSearchOptions merges a partial patch", () => {
    useFsStore.getState().setSearchOptions({ caseSensitive: true });
    expect(useFsStore.getState().searchOptions).toEqual({
      caseSensitive: true,
      wholeWord: false,
      regex: false,
    });
  });

  it("search forwards the stored options (camelCase) to the bridge", async () => {
    useFsStore.getState().setSearchOptions({ wholeWord: true });
    fsSearch.mockResolvedValueOnce([]);
    await useFsStore.getState().search("/proj", " foo ");
    expect(fsSearch).toHaveBeenCalledWith("/proj", "foo", {
      caseSensitive: false,
      wholeWord: true,
      regex: false,
    });
  });

  it("blank query clears results without calling the bridge", async () => {
    await useFsStore.getState().search("/proj", "   ");
    expect(fsSearch).not.toHaveBeenCalled();
    expect(useFsStore.getState().searchResults).toEqual([]);
    expect(useFsStore.getState().searching).toBe(false);
  });

  it("bridge rejection lands in searchError, not the shared error slot", async () => {
    useFsStore.getState().setSearchOptions({ regex: true });
    fsSearch.mockRejectedValueOnce({ type: "FileSystem", message: "无效的正则表达式: [" });
    await useFsStore.getState().search("/proj", "[");
    expect(useFsStore.getState().searchError).toBe("无效的正则表达式: [");
    expect(useFsStore.getState().error).toBeNull();
    expect(useFsStore.getState().searching).toBe(false);
  });

  it("clearSearch resets results, flag and search error", async () => {
    fsSearch.mockRejectedValueOnce(new Error("boom"));
    await useFsStore.getState().search("/proj", "x");
    expect(useFsStore.getState().searchError).toBeTruthy();
    useFsStore.getState().clearSearch();
    const s = useFsStore.getState();
    expect(s.searchResults).toEqual([]);
    expect(s.searchError).toBeNull();
    expect(s.searching).toBe(false);
  });
});

describe("replace preview / apply", () => {
  it("previewReplace stores the backend preview", async () => {
    const preview = { files: [{ path: "/proj/a.ts", count: 2 }], total: 2, truncated: false };
    fsSearchReplace.mockResolvedValueOnce(preview);
    await useFsStore.getState().previewReplace("/proj", "foo ", "bar");
    expect(fsSearchReplace).toHaveBeenCalledWith("/proj", "foo", "bar", {
      caseSensitive: false,
      wholeWord: false,
      regex: false,
    });
    expect(useFsStore.getState().replacePreview).toEqual(preview);
    expect(useFsStore.getState().replacing).toBe(false);
  });

  it("previewReplace on blank query clears any stale preview without calling the bridge", async () => {
    await useFsStore.getState().previewReplace("/proj", "  ", "bar");
    expect(fsSearchReplace).not.toHaveBeenCalled();
    expect(useFsStore.getState().replacePreview).toBeNull();
  });

  it("applyReplace passes scope through, clears the preview, returns the result", async () => {
    useFsStore.setState({ replacePreview: { files: [], total: 1, truncated: false } });
    const result = { filesChanged: 1, replacements: 1 };
    fsApplyReplace.mockResolvedValueOnce(result);
    const out = await useFsStore.getState().applyReplace("/proj", "foo", "bar", {
      paths: ["/proj/a.ts"],
      limitPerFile: 1,
    });
    expect(fsApplyReplace).toHaveBeenCalledWith(
      "/proj",
      "foo",
      "bar",
      { caseSensitive: false, wholeWord: false, regex: false },
      ["/proj/a.ts"],
      1,
    );
    expect(out).toEqual(result);
    expect(useFsStore.getState().replacePreview).toBeNull();
  });

  it("applyReplace without scope sends nulls (whole project)", async () => {
    fsApplyReplace.mockResolvedValueOnce({ filesChanged: 0, replacements: 0 });
    await useFsStore.getState().applyReplace("/proj", "foo", "bar");
    expect(fsApplyReplace).toHaveBeenCalledWith(
      "/proj",
      "foo",
      "bar",
      { caseSensitive: false, wholeWord: false, regex: false },
      null,
      null,
    );
  });

  it("applyReplace failure reports searchError and returns null", async () => {
    fsApplyReplace.mockRejectedValueOnce({ type: "FileSystem", message: "磁盘错误" });
    const out = await useFsStore.getState().applyReplace("/proj", "foo", "bar");
    expect(out).toBeNull();
    expect(useFsStore.getState().searchError).toBe("磁盘错误");
  });
});

describe("openFile line targeting", () => {
  it("openFile with { line } stores a pendingLine (preview tab by default)", async () => {
    fsReadFile.mockResolvedValueOnce({ is_text: true, content: "a", size: 1 });
    await useFsStore.getState().openFile("/p/a.ts", { line: 4 });
    expect(useFsStore.getState().pendingLine).toEqual({ path: "/p/a.ts", line: 4 });
    expect(useFsStore.getState().openFiles[0].pinned).toBe(false);
  });

  it("openFile with { pin: true, line } pins and targets", async () => {
    fsReadFile.mockResolvedValueOnce({ is_text: true, content: "a", size: 1 });
    await useFsStore.getState().openFile("/p/a.ts", { pin: true, line: 2 });
    expect(useFsStore.getState().openFiles[0].pinned).toBe(true);
    expect(useFsStore.getState().pendingLine).toEqual({ path: "/p/a.ts", line: 2 });
  });

  it("legacy boolean form keeps working and sets no pendingLine", async () => {
    fsReadFile.mockResolvedValueOnce({ is_text: true, content: "a", size: 1 });
    await useFsStore.getState().openFile("/p/a.ts", true);
    expect(useFsStore.getState().openFiles[0].pinned).toBe(true);
    expect(useFsStore.getState().pendingLine).toBeNull();
  });

  it("consumePendingLine returns the pending line once, then null", async () => {
    fsReadFile.mockResolvedValueOnce({ is_text: true, content: "a", size: 1 });
    await useFsStore.getState().openFile("/p/a.ts", { line: 7 });
    expect(useFsStore.getState().consumePendingLine()).toEqual({ path: "/p/a.ts", line: 7 });
    expect(useFsStore.getState().pendingLine).toBeNull();
    expect(useFsStore.getState().consumePendingLine()).toBeNull();
  });
});

it("saveFile refuses to write a stale file (external change pending)", async () => {
  useFsStore.setState({
    openFiles: [
      { path: "/proj/a.ts", content: "old", isText: true, size: 3, draft: "old-draft", dirty: true, stale: true, pinned: false },
    ],
    activePath: "/proj/a.ts",
  });
  const ok = await useFsStore.getState().saveFile();
  expect(ok).toBe(false);
  expect(fsWriteFile).not.toHaveBeenCalled();
});
