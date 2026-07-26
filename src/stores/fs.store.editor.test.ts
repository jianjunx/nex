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
});
