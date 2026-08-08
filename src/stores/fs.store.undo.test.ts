import { beforeEach, describe, expect, it, vi } from "vitest";

const fsReadFile = vi.fn();
const fsWriteFile = vi.fn();
const fsCreateFile = vi.fn();
const fsCreateDir = vi.fn();
const fsDeleteEntry = vi.fn();
const fsRenameEntry = vi.fn();
const fsCopyEntry = vi.fn();
const fsMoveEntry = vi.fn();
const fsReadTree = vi.fn();
const fsExpandDir = vi.fn();
const fsSearch = vi.fn();
const fsSearchReplace = vi.fn();
const fsApplyReplace = vi.fn();
const fsImportFiles = vi.fn();

vi.mock("../bridge/tauri", () => ({
  fsReadTree: (...a: unknown[]) => fsReadTree(...a),
  fsExpandDir: (...a: unknown[]) => fsExpandDir(...a),
  fsReadFile: (...a: unknown[]) => fsReadFile(...a),
  fsSearch: (...a: unknown[]) => fsSearch(...a),
  fsSearchReplace: (...a: unknown[]) => fsSearchReplace(...a),
  fsApplyReplace: (...a: unknown[]) => fsApplyReplace(...a),
  fsWriteFile: (...a: unknown[]) => fsWriteFile(...a),
  fsCreateFile: (...a: unknown[]) => fsCreateFile(...a),
  fsCreateDir: (...a: unknown[]) => fsCreateDir(...a),
  fsDeleteEntry: (...a: unknown[]) => fsDeleteEntry(...a),
  fsRenameEntry: (...a: unknown[]) => fsRenameEntry(...a),
  fsCopyEntry: (...a: unknown[]) => fsCopyEntry(...a),
  fsMoveEntry: (...a: unknown[]) => fsMoveEntry(...a),
  fsImportFiles: (...a: unknown[]) => fsImportFiles(...a),
}));

let activeProjectId = "proj-a";
vi.mock("./project.store", () => ({
  useProjectStore: {
    getState: () => ({ activeProjectId }),
  },
}));

vi.mock("./ui.store", () => ({
  useUiStore: {
    getState: () => ({}),
  },
}));

vi.mock("./settings.store", () => ({
  useSettingsStore: {
    getState: () => ({}),
  },
}));

vi.mock("./editorAutosave", () => ({
  clearAllAutoSaveTimers: vi.fn(),
  clearAutoSaveTimer: vi.fn(),
  scheduleAutoSaveTimer: vi.fn(),
}));

vi.mock("./searchProjectQuery", () => ({
  focusSearchQueryProject: vi.fn(),
}));

import { useFsStore, __resetFsUndoForTest } from "./fs.store";

describe("fs.store undo", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetFsUndoForTest();
    activeProjectId = "proj-a";
    fsReadTree.mockResolvedValue([]);
    fsReadFile.mockResolvedValue({ is_text: true, content: "", size: 0 });
    useFsStore.setState({ error: null, nodesByDir: {}, openFiles: [], activePath: null });
  });

  it("undo create removes the created file", async () => {
    fsCreateFile.mockResolvedValue(undefined);
    await useFsStore.getState().createFile("/p", "a.txt");
    expect(fsCreateFile).toHaveBeenCalledWith("/p", "a.txt");

    await useFsStore.getState().undoFsOperation();
    expect(fsDeleteEntry).toHaveBeenCalledWith("/p/a.txt");
  });

  it("undo rename restores the original name", async () => {
    fsRenameEntry.mockResolvedValue(undefined);
    await useFsStore.getState().renameEntry("/p/a.txt", "b.txt");
    expect(fsRenameEntry).toHaveBeenCalledWith("/p/a.txt", "b.txt");

    await useFsStore.getState().undoFsOperation();
    expect(fsRenameEntry).toHaveBeenLastCalledWith("/p/b.txt", "a.txt");
  });

  it("undo deleteFile restores content (text file snapshot)", async () => {
    // deleteEntry snapshots the file content before deletion; the file must
    // be visible in the tree for the snapshot lookup.
    useFsStore.setState({
      nodesByDir: {
        "/p": [{ name: "a.txt", path: "/p/a.txt", is_dir: false }],
      },
    });
    fsReadFile.mockResolvedValueOnce({ is_text: true, content: "hello", size: 5 });
    fsDeleteEntry.mockResolvedValue(undefined);
    await useFsStore.getState().deleteEntry("/p/a.txt");
    expect(fsDeleteEntry).toHaveBeenCalledWith("/p/a.txt");

    fsCreateFile.mockResolvedValue(undefined);
    fsWriteFile.mockResolvedValue(undefined);
    await useFsStore.getState().undoFsOperation();
    expect(fsCreateFile).toHaveBeenCalledWith("/p", "a.txt");
    expect(fsWriteFile).toHaveBeenCalledWith("/p/a.txt", "hello");
  });

  it("deleteEntry skips undo snapshot for binary/oversized files", async () => {
    fsReadFile.mockResolvedValueOnce({ is_text: false, content: null, size: 2048 });
    fsDeleteEntry.mockResolvedValue(undefined);
    await useFsStore.getState().deleteEntry("/p/bin.dat");
    // Deletion happened, but nothing pushed to the undo stack.
    await useFsStore.getState().undoFsOperation();
    expect(fsCreateFile).not.toHaveBeenCalled();
  });

  it("undo stack is isolated per project", async () => {
    fsCreateFile.mockResolvedValue(undefined);
    await useFsStore.getState().createFile("/p", "a.txt");
    // Switch project: undo must not pop proj-a's stack.
    activeProjectId = "proj-b";
    await useFsStore.getState().undoFsOperation();
    expect(fsDeleteEntry).not.toHaveBeenCalled();

    activeProjectId = "proj-a";
    await useFsStore.getState().undoFsOperation();
    expect(fsDeleteEntry).toHaveBeenCalledWith("/p/a.txt");
  });

  it("undo move moves the file back to its source dir", async () => {
    fsMoveEntry.mockResolvedValue(undefined);
    await useFsStore.getState().moveEntries(["/p/src/a.txt"], "/p/dest");
    expect(fsMoveEntry).toHaveBeenCalledWith("/p/src/a.txt", "/p/dest");

    await useFsStore.getState().undoFsOperation();
    // Undo moves /p/dest/a.txt back into /p/src.
    expect(fsMoveEntry).toHaveBeenLastCalledWith("/p/dest/a.txt", "/p/src");
  });
  it("rapid double undo is serialized (in-flight guard)", async () => {
    fsCreateFile.mockResolvedValue(undefined);
    await useFsStore.getState().createFile("/p", "a.txt");
    fsCreateFile.mockResolvedValue(undefined);
    await useFsStore.getState().createFile("/p", "b.txt");

    // First undo deletes b.txt; second (issued while first in flight) must be
    // a no-op so the stack is not double-popped.
    let resolveDelete: (v: unknown) => void = () => {};
    fsDeleteEntry.mockImplementationOnce(() => new Promise((r) => { resolveDelete = r; }));
    const p1 = useFsStore.getState().undoFsOperation();
    const p2 = useFsStore.getState().undoFsOperation();
    resolveDelete(undefined);
    await Promise.all([p1, p2]);

    // Only b.txt was deleted; a.txt's undo entry survives.
    expect(fsDeleteEntry).toHaveBeenCalledTimes(1);
    expect(fsDeleteEntry).toHaveBeenCalledWith("/p/b.txt");
    await useFsStore.getState().undoFsOperation();
    expect(fsDeleteEntry).toHaveBeenLastCalledWith("/p/a.txt");
  });
});
