import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { enableMapSet } from "immer";
import { fsReadTree, fsExpandDir, fsReadFile, fsSearch, fsWriteFile, type FsNode, type SearchMatch } from "../bridge/tauri";
import { useUiStore } from "./ui.store";

// Required by immer before a Set can be drafted (expandedDirs).
enableMapSet();

interface FsStore {
  nodesByDir: Record<string, FsNode[]>;
  expandedDirs: Set<string>;
  editorFile: {
    path: string;
    content: string | null; // disk snapshot at last load/save
    isText: boolean;
    size: number;
    draft: string;          // editable text (== content until the user types)
    dirty: boolean;         // draft !== disk snapshot
    stale: boolean;         // file changed on disk while dirty
  } | null;
  searchResults: SearchMatch[];
  searching: boolean;
  loading: boolean;
  error: string | null;

  loadRoot: (projectPath: string) => Promise<void>;
  expandDir: (dirPath: string) => Promise<void>;
  collapseDir: (dirPath: string) => void;
  openFile: (filePath: string) => Promise<void>;
  closeEditor: () => void;
  setDraft: (draft: string) => void;
  saveFile: () => Promise<void>;
  syncExternalChange: (paths: string[]) => Promise<void>;
  reloadEditor: () => Promise<void>;
  dismissStale: () => void;
  search: (projectPath: string, query: string) => Promise<void>;
  clearSearch: () => void;
  clearError: () => void;
}

// Backend errors arrive as { type, message }; fall back to String(err).
function errorMessage(err: unknown): string {
  if (err && typeof err === "object" && "message" in err && typeof (err as { message: unknown }).message === "string") {
    return (err as { message: string }).message;
  }
  return String(err);
}

export const useFsStore = create<FsStore>()(
  immer((set, get) => ({
    nodesByDir: {},
    expandedDirs: new Set(),
    editorFile: null,
    searchResults: [],
    searching: false,
    loading: false,
    error: null,

    loadRoot: async (projectPath: string) => {
      set((s) => { s.loading = true; s.error = null; });
      try {
        const nodes = await fsReadTree(projectPath);
        set((s) => {
          s.nodesByDir[projectPath] = nodes;
          s.expandedDirs.add(projectPath);
        });
      } catch (err) {
        set((s) => { s.error = errorMessage(err); });
      } finally {
        set((s) => { s.loading = false; });
      }
    },

    expandDir: async (dirPath: string) => {
      set((s) => { s.loading = true; s.error = null; });
      try {
        const nodes = await fsExpandDir(dirPath);
        set((s) => {
          s.nodesByDir[dirPath] = nodes;
          s.expandedDirs.add(dirPath);
        });
      } catch (err) {
        set((s) => { s.error = errorMessage(err); });
      } finally {
        set((s) => { s.loading = false; });
      }
    },

    collapseDir: (dirPath: string) => {
      set((s) => { s.expandedDirs.delete(dirPath); });
    },

    openFile: async (filePath: string) => {
      // Re-showing an already-open file must not clobber the draft/undo
      // history (B4: Esc hides, re-click re-shows, edits survive). Disk
      // freshness for an open file is syncExternalChange's job; a forced
      // re-read stays available via the stale banner's 重新加载.
      if (get().editorFile?.path === filePath) {
        useUiStore.getState().setEditorVisible(true);
        return;
      }
      set((s) => { s.loading = true; s.error = null; });
      try {
        const result = await fsReadFile(filePath);
        set((s) => {
          s.editorFile = {
            path: filePath,
            content: result.content ?? null,
            isText: result.is_text,
            size: result.size,
            draft: result.content ?? "",
            dirty: false,
            stale: false,
          };
        });
        // Opening a file always reveals the panel, even if Esc hid it.
        useUiStore.getState().setEditorVisible(true);
      } catch (err) {
        set((s) => { s.error = errorMessage(err); });
      } finally {
        set((s) => { s.loading = false; });
      }
    },

    closeEditor: () => {
      set((s) => { s.editorFile = null; });
      useUiStore.getState().setEditorVisible(false);
    },

    setDraft: (draft) => {
      set((s) => {
        if (!s.editorFile) return;
        s.editorFile.draft = draft;
        s.editorFile.dirty = s.editorFile.isText && draft !== (s.editorFile.content ?? "");
      });
    },

    saveFile: async () => {
      const cur = get().editorFile;
      if (!cur || !cur.dirty) return;
      set((s) => { s.loading = true; s.error = null; });
      try {
        await fsWriteFile(cur.path, cur.draft);
        // The user may have switched files while the write was in flight.
        if (get().editorFile?.path !== cur.path) return;
        set((s) => {
          if (!s.editorFile) return;
          s.editorFile.content = s.editorFile.draft;
          s.editorFile.dirty = false;
        });
      } catch (err) {
        set((s) => { s.error = errorMessage(err); });
      } finally {
        set((s) => { s.loading = false; });
      }
    },

    syncExternalChange: async (paths) => {
      const cur = get().editorFile;
      if (!cur || !paths.includes(cur.path)) return;
      if (cur.dirty) {
        // Unsaved edits: keep them, surface the stale banner instead.
        set((s) => { if (s.editorFile) s.editorFile.stale = true; });
        return;
      }
      // Clean file: silently pick up the new disk content.
      try {
        const result = await fsReadFile(cur.path);
        if (get().editorFile?.path !== cur.path) return;
        set((s) => {
          if (!s.editorFile) return;
          s.editorFile.content = result.content ?? null;
          s.editorFile.draft = result.content ?? "";
          s.editorFile.isText = result.is_text;
          s.editorFile.size = result.size;
        });
      } catch {
        // Reload failure is non-fatal; keep showing the old content.
      }
    },

    reloadEditor: async () => {
      const cur = get().editorFile;
      if (!cur) return;
      try {
        const result = await fsReadFile(cur.path);
        // Unconditional: the draft is discarded whatever it contained.
        if (get().editorFile?.path !== cur.path) return;
        set((s) => {
          if (!s.editorFile) return;
          s.editorFile.content = result.content ?? null;
          s.editorFile.draft = result.content ?? "";
          s.editorFile.isText = result.is_text;
          s.editorFile.size = result.size;
          s.editorFile.dirty = false;
          s.editorFile.stale = false;
        });
      } catch (err) {
        set((s) => { s.error = errorMessage(err); });
      }
    },

    dismissStale: () => {
      set((s) => { if (s.editorFile) s.editorFile.stale = false; });
    },

    search: async (projectPath: string, query: string) => {
      if (!query.trim()) {
        set((s) => { s.searchResults = []; s.searching = false; });
        return;
      }
      set((s) => { s.searching = true; s.error = null; });
      try {
        const results = await fsSearch(projectPath, query.trim());
        set((s) => { s.searchResults = results; });
      } catch (err) {
        set((s) => { s.error = errorMessage(err); });
      } finally {
        set((s) => { s.searching = false; });
      }
    },

    clearSearch: () => {
      set((s) => { s.searchResults = []; s.searching = false; });
    },

    clearError: () => {
      set((s) => { s.error = null; });
    },
  }))
);
