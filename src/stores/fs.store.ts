import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { enableMapSet } from "immer";
import { fsReadTree, fsExpandDir, fsReadFile, fsSearch, type FsNode, type SearchMatch } from "../bridge/tauri";

// Required by immer before a Set can be drafted (expandedDirs).
enableMapSet();

interface FsStore {
  nodesByDir: Record<string, FsNode[]>;
  expandedDirs: Set<string>;
  previewFile: { path: string; content: string | null; isText: boolean; size: number } | null;
  searchResults: SearchMatch[];
  searching: boolean;
  loading: boolean;
  error: string | null;

  loadRoot: (projectPath: string) => Promise<void>;
  expandDir: (dirPath: string) => Promise<void>;
  collapseDir: (dirPath: string) => void;
  openFile: (filePath: string) => Promise<void>;
  closePreview: () => void;
  search: (projectPath: string, query: string) => Promise<void>;
  clearSearch: () => void;
}

// Backend errors arrive as { type, message }; fall back to String(err).
function errorMessage(err: unknown): string {
  if (err && typeof err === "object" && "message" in err && typeof (err as { message: unknown }).message === "string") {
    return (err as { message: string }).message;
  }
  return String(err);
}

export const useFsStore = create<FsStore>()(
  immer((set) => ({
    nodesByDir: {},
    expandedDirs: new Set(),
    previewFile: null,
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
      set((s) => { s.loading = true; s.error = null; });
      try {
        const result = await fsReadFile(filePath);
        set((s) => {
          s.previewFile = { path: filePath, content: result.content ?? null, isText: result.is_text, size: result.size };
        });
      } catch (err) {
        set((s) => { s.error = errorMessage(err); });
      } finally {
        set((s) => { s.loading = false; });
      }
    },

    closePreview: () => {
      set((s) => { s.previewFile = null; });
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
  }))
);
