import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { persist } from "zustand/middleware";
import { enableMapSet } from "immer";
import { fsReadTree, fsExpandDir, fsReadFile, fsSearch, fsSearchReplace, fsApplyReplace, fsWriteFile, fsCreateFile, fsCreateDir, fsDeleteEntry, fsRenameEntry, fsCopyEntry, fsMoveEntry, fsImportFiles, type FsNode, type SearchMatch, type SearchOptions, type ReplacePreview, type ReplaceResult } from "../bridge/tauri";
import { useUiStore } from "./ui.store";
import { useSettingsStore } from "./settings.store";
import {
  clearAllAutoSaveTimers,
  clearAutoSaveTimer,
  scheduleAutoSaveTimer,
} from "./editorAutosave";

export { clearAllAutoSaveTimers };

// Required by immer before a Set can be drafted (expandedDirs).
enableMapSet();

function scheduleAutoSave(path: string) {
  if (!useSettingsStore.getState().editorAutoSave) return;
  scheduleAutoSaveTimer(path, () => {
    if (!useSettingsStore.getState().editorAutoSave) return;
    void useFsStore.getState().saveFile(path);
  });
}

async function flushAutoSave(path: string) {
  clearAutoSaveTimer(path);
  const file = useFsStore.getState().openFiles.find((f) => f.path === path);
  if (file?.dirty) await useFsStore.getState().saveFile(path);
}

/** 只读 diff 标签载荷。mode=merge：双版本统一合并视图；mode=patch：提交补丁全文。 */
export type DiffMode = "merge" | "patch";

export type DiffPayload = {
  mode: DiffMode;
  /** 标签名，如 "src/a.ts（已暂存）" 或 "提交 abc1234"。 */
  title: string;
  /** 语法高亮的文件路径提示（合成路径不能用于语言检测）。 */
  languageHint: string;
  original: string;
  revised: string;
  binary: boolean;
};

export type EditorFile = {
  path: string;
  content: string | null; // disk snapshot at last load/save
  isText: boolean;
  size: number;
  draft: string;          // editable text (== content until the user types)
  dirty: boolean;         // draft !== disk snapshot
  stale: boolean;         // file changed on disk while dirty
  pinned: boolean;        // true = permanent tab, false = preview (replaced on next single-click)
  /** 存在即为只读 diff 标签：合成路径（diff: 前缀）、永久固定、永不 dirty、不进冷恢复持久化。 */
  diff?: DiffPayload;
};

/** Persisted per-project editor layout — only file paths, content is re-read from disk on restore. */
export type EditorLayout = { paths: string[]; activePath: string | null };

/** In-memory per-project editor cache — full EditorFile[] preserving dirty drafts within a session. */
export type EditorCache = { openFiles: EditorFile[]; activePath: string | null };

/** 「打开并跳到行」的待消费目标；EditorPanel 读出即清。 */
export type PendingLine = { path: string; line: number };

/** openFile 第二参的对象形式（布尔形式保持后向兼容）。 */
export type OpenFileOptions = { pin?: boolean; line?: number };

interface FsStore {
  nodesByDir: Record<string, FsNode[]>;
  expandedDirs: Set<string>;
  openFiles: EditorFile[];
  activePath: string | null;
  selectedPath: string | null;
  searchResults: SearchMatch[];
  searching: boolean;
  searchOptions: SearchOptions;
  searchError: string | null;
  replacePreview: ReplacePreview | null;
  replacing: boolean;
  pendingLine: PendingLine | null;
  /** Set by keyboard shortcut (F2) to trigger inline rename on the selected node. */
  pendingRenamePath: string | null;
  loading: boolean;
  error: string | null;
  /** Per-project open-file paths + active path, persisted to localStorage. */
  editorLayoutByProject: Record<string, EditorLayout>;
  /** Per-project full EditorFile[] + active path, in-memory only (survives switches within a session). */
  editorCacheByProject: Record<string, EditorCache>;

  loadRoot: (projectPath: string) => Promise<void>;
  expandDir: (dirPath: string) => Promise<void>;
  collapseDir: (dirPath: string) => void;
  collapseAll: (projectPath: string) => void;
  openFile: (filePath: string, opts?: boolean | OpenFileOptions) => Promise<void>;
  /** 打开只读 diff 标签（upsert：同 id 重开就地替换载荷并激活）。合成路径 diff: 前缀，不进冷恢复持久化。 */
  openDiffTab: (id: string, payload: DiffPayload) => void;
  switchFile: (filePath: string) => Promise<void>;
  closeFile: (filePath: string) => Promise<void>;
  /** Reorder editor tabs by index. */
  reorderOpenFiles: (fromIndex: number, toIndex: number) => void;
  closeEditor: () => Promise<void>;
  setDraft: (draft: string) => void;
  setSelectedPath: (path: string | null) => void;
  createFile: (parentDir: string, name: string) => Promise<void>;
  createDir: (parentDir: string, name: string) => Promise<void>;
  deleteEntry: (path: string) => Promise<void>;
  renameEntry: (path: string, newName: string) => Promise<void>;
  copyEntries: (sources: string[], targetDir: string) => Promise<void>;
  moveEntries: (sources: string[], targetDir: string) => Promise<void>;
  /** Import external files (e.g. OS drag-and-drop) into a target directory. */
  importFiles: (sources: string[], targetDir: string) => Promise<void>;
  refreshDir: (dirPath: string) => Promise<void>;
  /** @returns false when a write was attempted and failed */
  saveFile: (filePath?: string) => Promise<boolean>;
  syncExternalChange: (paths: string[]) => Promise<void>;
  reloadEditor: () => Promise<void>;
  dismissStale: () => void;
  search: (projectPath: string, query: string) => Promise<void>;
  clearSearch: () => void;
  setSearchOptions: (patch: Partial<SearchOptions>) => void;
  previewReplace: (projectPath: string, query: string, replacement: string) => Promise<void>;
  applyReplace: (projectPath: string, query: string, replacement: string, scope?: { paths?: string[]; limitPerFile?: number }) => Promise<ReplaceResult | null>;
  clearReplacePreview: () => void;
  consumePendingLine: () => PendingLine | null;
  /** Set a path to trigger inline rename in FileTree; consumed once. */
  setPendingRename: (path: string | null) => void;
  consumePendingRename: () => string | null;
  clearError: () => void;
  /** Flush dirty files, cache full EditorFile[] + paths for the project. Call before switching away. */
  saveCurrentEditorState: (projectId: string) => Promise<void>;
  /** Restore editor for a project — from in-memory cache (instant) or persisted layout (re-reads disk). */
  loadEditorState: (projectId: string) => Promise<void>;
  /** Synchronously persist current open-file paths for the project (for beforeunload). */
  persistEditorLayout: (projectId: string) => void;
  /** Drop file-tree nodes that do not belong under `projectPath`. */
  clearTreeExcept: (projectPath: string) => void;
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
  persist(
    immer((set, get) => ({
    nodesByDir: {},
    expandedDirs: new Set(),
    openFiles: [],
    activePath: null,
    selectedPath: null,
    searchResults: [],
    searching: false,
    searchOptions: { caseSensitive: false, wholeWord: false, regex: false },
    searchError: null,
    replacePreview: null,
    replacing: false,
    pendingLine: null,
    pendingRenamePath: null,
    loading: false,
    error: null,
    editorLayoutByProject: {},
    editorCacheByProject: {},

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

    collapseAll: (projectPath: string) => {
      set((s) => {
        s.expandedDirs = new Set([projectPath]);
        s.selectedPath = null;
      });
    },

    openFile: async (filePath, opts) => {
      const { pin, line } = typeof opts === "boolean"
        ? { pin: opts, line: undefined as number | undefined }
        : { pin: opts?.pin ?? false, line: opts?.line };
      // Re-showing an already-open file must not clobber the draft/undo
      // history (B4: Esc hides, re-click re-shows, edits survive). Disk
      // freshness for an open file is syncExternalChange's job; a forced
      // re-read stays available via the stale banner's 重新加载.
      const previous = get().activePath;
      if (previous && previous !== filePath) {
        await flushAutoSave(previous);
      }
      // If file already open, just switch to it (and optionally pin).
      const existingIndex = get().openFiles.findIndex((f) => f.path === filePath);
      if (existingIndex >= 0) {
        set((s) => {
          s.activePath = filePath;
          if (pin) s.openFiles[existingIndex].pinned = true;
          if (line != null) s.pendingLine = { path: filePath, line };
        });
        useUiStore.getState().setEditorVisible(true);
        return;
      }
      set((s) => { s.loading = true; s.error = null; });
      try {
        const result = await fsReadFile(filePath);
        if (!pin) {
          // Preview mode: replace the first unpinned tab if one exists.
          const previewIndex = get().openFiles.findIndex((f) => !f.pinned);
          if (previewIndex >= 0) {
            set((s) => {
              s.openFiles[previewIndex] = {
                path: filePath,
                content: result.content ?? null,
                isText: result.is_text,
                size: result.size,
                draft: result.content ?? "",
                dirty: false,
                stale: false,
                pinned: false,
              };
              s.activePath = filePath;
              if (line != null) s.pendingLine = { path: filePath, line };
            });
            useUiStore.getState().setEditorVisible(true);
            return;
          }
        }
        set((s) => {
          s.openFiles.push({
            path: filePath,
            content: result.content ?? null,
            isText: result.is_text,
            size: result.size,
            draft: result.content ?? "",
            dirty: false,
            stale: false,
            pinned: pin,
          });
          s.activePath = filePath;
          if (line != null) s.pendingLine = { path: filePath, line };
        });
        // Opening a file always reveals the panel, even if Esc hid it.
        useUiStore.getState().setEditorVisible(true);
      } catch (err) {
        set((s) => { s.error = errorMessage(err); });
      } finally {
        set((s) => { s.loading = false; });
      }
    },

    openDiffTab: (id, payload) => {
      // 与 openFile 同契：切走前冲刷上一个活动文件的自动保存。
      const previous = get().activePath;
      if (previous && previous !== id) void flushAutoSave(previous);
      const existingIndex = get().openFiles.findIndex((f) => f.path === id);
      set((s) => {
        if (existingIndex >= 0) {
          // 重开同一 diff：暂存状态可能已变，就地替换载荷，标签保持一个。
          s.openFiles[existingIndex].diff = payload;
        } else {
          s.openFiles.push({
            path: id,
            content: null,
            isText: true,
            size: 0,
            draft: "",
            dirty: false,
            stale: false,
            pinned: true, // diff 标签永远固定，不参与预览替换
            diff: payload,
          });
        }
        s.activePath = id;
      });
      useUiStore.getState().setEditorVisible(true);
    },

    switchFile: async (filePath: string) => {
      if (!get().openFiles.some((f) => f.path === filePath)) return;
      const previous = get().activePath;
      if (previous && previous !== filePath) {
        await flushAutoSave(previous);
      }
      set((s) => { s.activePath = filePath; });
    },

    closeFile: async (filePath: string) => {
      const index = get().openFiles.findIndex((f) => f.path === filePath);
      if (index < 0) return;

      clearAutoSaveTimer(filePath);
      const file = get().openFiles[index];
      if (file.dirty) {
        const saved = await get().saveFile(filePath);
        if (!saved) return; // keep dirty tab + error bar
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

    reorderOpenFiles: (fromIndex, toIndex) => {
      set((s) => {
        if (fromIndex < 0 || fromIndex >= s.openFiles.length || toIndex < 0 || toIndex >= s.openFiles.length) return;
        if (fromIndex === toIndex) return;
        const [item] = s.openFiles.splice(fromIndex, 1);
        s.openFiles.splice(toIndex, 0, item);
      });
    },

    closeEditor: async () => {
      const dirtyPaths = get().openFiles.filter((f) => f.dirty).map((f) => f.path);
      for (const path of dirtyPaths) {
        await get().saveFile(path);
      }
      // Drop only clean / successfully saved files; keep any that remain dirty.
      set((s) => {
        s.openFiles = s.openFiles.filter((f) => f.dirty);
        if (s.openFiles.length === 0) {
          s.activePath = null;
        } else if (!s.openFiles.some((f) => f.path === s.activePath)) {
          s.activePath = s.openFiles[0].path;
        }
      });
      if (get().openFiles.length === 0) {
        useUiStore.getState().setEditorVisible(false);
      }
    },

    setDraft: (draft) => {
      const path = get().activePath;
      let dirty = false;
      set((s) => {
        const active = s.activePath ? findOpenFile(s.openFiles, s.activePath) : undefined;
        if (!active || active.diff) return; // diff 标签只读：绝不写 draft、绝不 dirty
        active.draft = draft;
        const wasDirty = active.dirty;
        active.dirty = active.isText && draft !== (active.content ?? "");
        dirty = active.dirty;
        // Auto-pin the tab the moment the user starts typing.
        if (!wasDirty && dirty) active.pinned = true;
      });
      if (!path) return;
      if (dirty) scheduleAutoSave(path);
      else clearAutoSaveTimer(path);
    },

    setSelectedPath: (path) => {
      set((s) => { s.selectedPath = path; });
    },

    createFile: async (parentDir, name) => {
      set((s) => { s.error = null; });
      try {
        await fsCreateFile(parentDir, name);
        await get().refreshDir(parentDir);
      } catch (err) {
        set((s) => { s.error = errorMessage(err); });
      }
    },

    createDir: async (parentDir, name) => {
      set((s) => { s.error = null; });
      try {
        await fsCreateDir(parentDir, name);
        await get().refreshDir(parentDir);
      } catch (err) {
        set((s) => { s.error = errorMessage(err); });
      }
    },

    deleteEntry: async (path) => {
      set((s) => { s.error = null; });
      try {
        const parent = path.replace(/[/\\][^/\\]*$/, "");
        // Close the file in editor if it was open
        const openIndex = get().openFiles.findIndex((f) => f.path === path);
        if (openIndex >= 0) {
          await get().closeFile(path);
        }
        await fsDeleteEntry(path);
        await get().refreshDir(parent);
        // Also refresh subdirs that had this path as parent
        if (parent) {
          const parentInNodes = parent in get().nodesByDir;
          if (!parentInNodes) {
            // Attempt to refresh the project root
            const projects = get().nodesByDir;
            for (const dir of Object.keys(projects)) {
              if (path.startsWith(dir)) {
                await get().refreshDir(dir);
                break;
              }
            }
          }
        }
      } catch (err) {
        set((s) => { s.error = errorMessage(err); });
      }
    },

    renameEntry: async (path, newName) => {
      set((s) => { s.error = null; });
      try {
        const parent = path.replace(/[/\\][^/\\]*$/, "");
        const newPath = parent ? `${parent}\\${newName}` : newName;
        await fsRenameEntry(path, newName);
        // Update open file path if the renamed file was open
        const openIndex = get().openFiles.findIndex((f) => f.path === path);
        if (openIndex >= 0) {
          set((s) => {
            s.openFiles[openIndex].path = newPath;
            if (s.activePath === path) s.activePath = newPath;
          });
        }
        // Update expanded dirs
        const dirs = new Set(get().expandedDirs);
        if (dirs.has(path)) {
          dirs.delete(path);
          dirs.add(newPath);
          set((s) => { s.expandedDirs = dirs; });
        }
        // Refresh parent
        await get().refreshDir(parent);
      } catch (err) {
        set((s) => { s.error = errorMessage(err); });
      }
    },

    copyEntries: async (sources, targetDir) => {
      set((s) => { s.error = null; });
      try {
        for (const src of sources) {
          await fsCopyEntry(src, targetDir);
        }
        await get().refreshDir(targetDir);
      } catch (err) {
        set((s) => { s.error = errorMessage(err); });
      }
    },

    moveEntries: async (sources, targetDir) => {
      set((s) => { s.error = null; });
      try {
        for (const src of sources) {
          // Close any open editor tabs for moved files
          const openIndex = get().openFiles.findIndex((f) => f.path === src);
          if (openIndex >= 0) {
            const name = src.replace(/^.*[/\\]/, "");
            const newPath = `${targetDir}\\${name}`;
            set((s) => {
              s.openFiles[openIndex].path = newPath;
              if (s.activePath === src) s.activePath = newPath;
            });
          }
          // Refresh source parent before move
          const srcParent = src.replace(/[/\\][^/\\]*$/, "");
          await fsMoveEntry(src, targetDir);
          await get().refreshDir(srcParent);
        }
        await get().refreshDir(targetDir);
      } catch (err) {
        set((s) => { s.error = errorMessage(err); });
      }
    },

    importFiles: async (sources, targetDir) => {
      set((s) => { s.error = null; });
      try {
        await fsImportFiles(sources, targetDir);
        await get().refreshDir(targetDir);
      } catch (err) {
        set((s) => { s.error = errorMessage(err); });
      }
    },

    refreshDir: async (dirPath) => {
      set((s) => { s.loading = true; s.error = null; });
      try {
        const nodes = await fsReadTree(dirPath);
        set((s) => { s.nodesByDir[dirPath] = nodes; });
      } catch (err) {
        set((s) => { s.error = errorMessage(err); });
      } finally {
        set((s) => { s.loading = false; });
      }
    },

    saveFile: async (filePath?) => {
      const target = filePath ?? get().activePath;
      if (!target) return true;
      const cur = findOpenFile(get().openFiles, target);
      if (!cur || !cur.dirty) return true;
      // R1：stale＝外部改动（替换/拉取/外部进程）待决策；任何写盘（含 autosave）
      // 都会静默回滚该改动——用户须先在黄条上「重新加载/保留」，故直接拒绝
      if (cur.stale) return false;
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
        clearAutoSaveTimer(cur.path);
        return true;
      } catch (err) {
        set((s) => { s.error = errorMessage(err); });
        return false;
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
      if (!cur || cur.diff) return; // diff 标签无对应磁盘文件，重载会产生无效读取错误
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
        set((s) => { s.searchResults = []; s.searching = false; s.searchError = null; });
        return;
      }
      set((s) => { s.searching = true; s.searchError = null; });
      try {
        const results = await fsSearch(projectPath, query.trim(), get().searchOptions);
        set((s) => { s.searchResults = results; });
      } catch (err) {
        // 独立错误槽：共享 error 会在 EditorPanel 渲染红条，搜索错误不该出现在那里。
        set((s) => { s.searchError = errorMessage(err); });
      } finally {
        set((s) => { s.searching = false; });
      }
    },

    clearSearch: () => {
      set((s) => { s.searchResults = []; s.searching = false; s.searchError = null; });
    },

    setSearchOptions: (patch) => {
      set((s) => { s.searchOptions = { ...s.searchOptions, ...patch }; });
    },

    previewReplace: async (projectPath, query, replacement) => {
      if (!query.trim()) {
        set((s) => { s.replacePreview = null; });
        return;
      }
      set((s) => { s.replacing = true; s.searchError = null; });
      try {
        const preview = await fsSearchReplace(projectPath, query.trim(), replacement, get().searchOptions);
        set((s) => { s.replacePreview = preview; });
      } catch (err) {
        set((s) => { s.searchError = errorMessage(err); s.replacePreview = null; });
      } finally {
        set((s) => { s.replacing = false; });
      }
    },

    applyReplace: async (projectPath, query, replacement, scope) => {
      set((s) => { s.replacing = true; s.searchError = null; });
      try {
        const result = await fsApplyReplace(
          projectPath,
          query.trim(),
          replacement,
          get().searchOptions,
          scope?.paths ?? null,
          scope?.limitPerFile ?? null,
        );
        set((s) => { s.replacePreview = null; });
        return result;
      } catch (err) {
        set((s) => { s.searchError = errorMessage(err); });
        return null;
      } finally {
        set((s) => { s.replacing = false; });
      }
    },

    clearReplacePreview: () => {
      set((s) => { s.replacePreview = null; });
    },

    consumePendingLine: () => {
      const cur = get().pendingLine;
      if (cur) set((s) => { s.pendingLine = null; });
      return cur;
    },

    setPendingRename: (path) => {
      set((s) => { s.pendingRenamePath = path; });
    },

    consumePendingRename: () => {
      const cur = get().pendingRenamePath;
      if (cur) set((s) => { s.pendingRenamePath = null; });
      return cur;
    },

    clearError: () => {
      set((s) => { s.error = null; });
    },

    saveCurrentEditorState: async (projectId: string) => {
      // Flush auto-save timers and persist dirty drafts to disk before
      // swapping — mirrors closeFile's save-on-close contract.
      const dirtyPaths = get().openFiles.filter((f) => f.dirty).map((f) => f.path);
      for (const path of dirtyPaths) {
        clearAutoSaveTimer(path);
        await get().saveFile(path);
      }
      set((s) => {
        // Cache the full EditorFile[] so switching back is instant and
        // preserves any drafts that failed to save.
        s.editorCacheByProject[projectId] = {
          openFiles: s.openFiles,
          activePath: s.activePath,
        };
        // Persist only paths — content is re-read from disk on cold restore.
        s.editorLayoutByProject[projectId] = {
          paths: s.openFiles.filter((f) => !f.diff).map((f) => f.path), // diff 标签不进冷恢复
          activePath: s.activePath,
        };
      });
    },

    loadEditorState: async (projectId: string) => {
      // Kill any pending auto-save timers for the outgoing files.
      clearAllAutoSaveTimers();

      // 1. In-memory cache (instant, preserves unsaved drafts).
      const cached = get().editorCacheByProject[projectId];
      if (cached) {
        set((s) => {
          s.openFiles = cached.openFiles;
          s.activePath = cached.activePath;
        });
        useUiStore.getState().setEditorVisible(cached.openFiles.length > 0);
        return;
      }

      // 2. Persisted layout — re-open each file from disk as a pinned tab.
      const layout = get().editorLayoutByProject[projectId];
      if (layout && layout.paths.length > 0) {
        set((s) => {
          s.openFiles = [];
          s.activePath = null;
        });
        // Dedupe in case a prior buggy persist wrote the same path twice
        // (React keys would collide and remount editors incorrectly).
        const uniquePaths = [...new Set(layout.paths)];
        const CONCURRENCY = 4;
        for (let i = 0; i < uniquePaths.length; i += CONCURRENCY) {
          const chunk = uniquePaths.slice(i, i + CONCURRENCY);
          await Promise.all(
            chunk.map(async (path) => {
              try {
                await get().openFile(path, true);
              } catch {
                // File may have been deleted/moved since last session — skip.
              }
            }),
          );
        }
        // Restore the saved active tab if it survived re-opening.
        if (layout.activePath && get().openFiles.some((f) => f.path === layout.activePath)) {
          set((s) => { s.activePath = layout.activePath; });
        }
        useUiStore.getState().setEditorVisible(get().openFiles.length > 0);
        return;
      }

      // 3. No saved state for this project — start with a clean editor.
      set((s) => {
        s.openFiles = [];
        s.activePath = null;
      });
      useUiStore.getState().setEditorVisible(false);
    },

    persistEditorLayout: (projectId: string) => {
      const { openFiles, activePath } = get();
      set((s) => {
        s.editorLayoutByProject[projectId] = {
          paths: openFiles.filter((f) => !f.diff).map((f) => f.path), // diff 标签不进冷恢复
          activePath,
        };
      });
    },

    clearTreeExcept: (projectPath: string) => {
      set((s) => {
        const nextNodes: Record<string, typeof s.nodesByDir[string]> = {};
        for (const [dir, nodes] of Object.entries(s.nodesByDir)) {
          if (dir === projectPath || dir.startsWith(projectPath + "/") || dir.startsWith(projectPath + "\\")) {
            nextNodes[dir] = nodes;
          }
        }
        s.nodesByDir = nextNodes;
        const nextExpanded = new Set<string>();
        for (const dir of s.expandedDirs) {
          if (dir === projectPath || dir.startsWith(projectPath + "/") || dir.startsWith(projectPath + "\\")) {
            nextExpanded.add(dir);
          }
        }
        s.expandedDirs = nextExpanded;
      });
    },
    })),
    {
      name: "nex-fs",
      // Only the per-project open-file paths are persisted; file content,
      // tree state, and the in-memory EditorFile cache are ephemeral.
      partialize: (s) => ({
        editorLayoutByProject: s.editorLayoutByProject,
      }),
    }
  )
);
