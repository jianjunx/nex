import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { enableMapSet } from "immer";
import { fsReadTree, fsExpandDir, fsReadFile, fsSearch, fsWriteFile, type FsNode, type SearchMatch } from "../bridge/tauri";
import { useUiStore } from "./ui.store";

// Required by immer before a Set can be drafted (expandedDirs).
enableMapSet();

export type EditorFile = {
  path: string;
  content: string | null; // disk snapshot at last load/save
  isText: boolean;
  size: number;
  draft: string;          // editable text (== content until the user types)
  dirty: boolean;         // draft !== disk snapshot
  stale: boolean;         // file changed on disk while dirty
};

interface FsStore {
  nodesByDir: Record<string, FsNode[]>;
  expandedDirs: Set<string>;
  openFiles: EditorFile[];
  activePath: string | null;
  searchResults: SearchMatch[];
  searching: boolean;
  loading: boolean;
  error: string | null;

  loadRoot: (projectPath: string) => Promise<void>;
  expandDir: (dirPath: string) => Promise<void>;
  collapseDir: (dirPath: string) => void;
  openFile: (filePath: string) => Promise<void>;
  switchFile: (filePath: string) => Promise<void>;
  closeFile: (filePath: string) => Promise<void>;
  closeEditor: () => Promise<void>;
  setDraft: (draft: string) => void;
  saveFile: (filePath?: string) => Promise<void>;
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

function findOpenFile(openFiles: EditorFile[], path: string): EditorFile | undefined {
  return openFiles.find((f) => f.path === path);
}

export const useFsStore = create<FsStore>()(
  immer((set, get) => ({
    nodesByDir: {},
    expandedDirs: new Set(),
    openFiles: [],
    activePath: null,
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
      if (get().openFiles.some((f) => f.path === filePath)) {
        set((s) => { s.activePath = filePath; });
        useUiStore.getState().setEditorVisible(true);
        return;
      }
      set((s) => { s.loading = true; s.error = null; });
      try {
        const result = await fsReadFile(filePath);
        set((s) => {
          s.openFiles.push({
            path: filePath,
            content: result.content ?? null,
            isText: result.is_text,
            size: result.size,
            draft: result.content ?? "",
            dirty: false,
            stale: false,
          });
          s.activePath = filePath;
        });
        // Opening a file always reveals the panel, even if Esc hid it.
        useUiStore.getState().setEditorVisible(true);
      } catch (err) {
        set((s) => { s.error = errorMessage(err); });
      } finally {
        set((s) => { s.loading = false; });
      }
    },

    switchFile: async (filePath: string) => {
      if (!get().openFiles.some((f) => f.path === filePath)) return;
      set((s) => { s.activePath = filePath; });
    },

    closeFile: async (filePath: string) => {
      const index = get().openFiles.findIndex((f) => f.path === filePath);
      if (index < 0) return;

      const file = get().openFiles[index];
      if (file.dirty) {
        await get().saveFile(filePath);
      }

      const wasActive = get().activePath === filePath;
      set((s) => {
        const i = s.openFiles.findIndex((f) => f.path === filePath);
        if (i < 0) return;
        s.openFiles.splice(i, 1);
        if (!wasActive) return;
        if (s.openFiles.length === 0) {
          s.activePath = null;
        } else {
          // Prefer right neighbor, else left.
          const next = s.openFiles[Math.min(i, s.openFiles.length - 1)];
          s.activePath = next.path;
        }
      });

      if (get().openFiles.length === 0) {
        useUiStore.getState().setEditorVisible(false);
      }
    },

    closeEditor: async () => {
      const dirtyPaths = get().openFiles.filter((f) => f.dirty).map((f) => f.path);
      for (const path of dirtyPaths) {
        await get().saveFile(path);
      }
      set((s) => {
        s.openFiles = [];
        s.activePath = null;
      });
      useUiStore.getState().setEditorVisible(false);
    },

    setDraft: (draft) => {
      set((s) => {
        const active = s.activePath ? findOpenFile(s.openFiles, s.activePath) : undefined;
        if (!active) return;
        active.draft = draft;
        active.dirty = active.isText && draft !== (active.content ?? "");
      });
    },

    saveFile: async (filePath?) => {
      const target = filePath ?? get().activePath;
      if (!target) return;
      const cur = findOpenFile(get().openFiles, target);
      if (!cur || !cur.dirty) return;
      const intendedDraft = cur.draft;
      set((s) => { s.loading = true; s.error = null; });
      try {
        await fsWriteFile(cur.path, intendedDraft);
        // Only clear dirty if the path is still open and draft still matches
        // the write intent (user may have kept typing during the write).
        set((s) => {
          const f = findOpenFile(s.openFiles, cur.path);
          if (!f || f.draft !== intendedDraft) return;
          f.content = intendedDraft;
          f.dirty = false;
        });
      } catch (err) {
        set((s) => { s.error = errorMessage(err); });
      } finally {
        set((s) => { s.loading = false; });
      }
    },

    syncExternalChange: async (paths) => {
      const affected = get().openFiles.filter((f) => paths.includes(f.path));
      for (const cur of affected) {
        if (cur.dirty) {
          // Unsaved edits: keep them, surface the stale banner instead.
          set((s) => {
            const f = findOpenFile(s.openFiles, cur.path);
            if (f) f.stale = true;
          });
          continue;
        }
        // Clean file: silently pick up the new disk content.
        try {
          const result = await fsReadFile(cur.path);
          set((s) => {
            const f = findOpenFile(s.openFiles, cur.path);
            if (!f || f.dirty) return;
            f.content = result.content ?? null;
            f.draft = result.content ?? "";
            f.isText = result.is_text;
            f.size = result.size;
          });
        } catch {
          // Reload failure is non-fatal; keep showing the old content.
        }
      }
    },

    reloadEditor: async () => {
      const activePath = get().activePath;
      if (!activePath) return;
      const cur = findOpenFile(get().openFiles, activePath);
      if (!cur) return;
      try {
        const result = await fsReadFile(cur.path);
        // Unconditional: the draft is discarded whatever it contained.
        set((s) => {
          const f = findOpenFile(s.openFiles, cur.path);
          if (!f) return;
          f.content = result.content ?? null;
          f.draft = result.content ?? "";
          f.isText = result.is_text;
          f.size = result.size;
          f.dirty = false;
          f.stale = false;
        });
      } catch (err) {
        set((s) => { s.error = errorMessage(err); });
      }
    },

    dismissStale: () => {
      set((s) => {
        const active = s.activePath ? findOpenFile(s.openFiles, s.activePath) : undefined;
        if (active) active.stale = false;
      });
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
