import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { gitStatus, gitDiff, gitStage, gitUnstage, gitCommit, type GitStatus } from "../bridge/tauri";

interface GitStore {
  status: GitStatus | null;
  diff: string | null;
  diffFile: string | null;
  loading: boolean;
  error: string | null;

  refresh: (projectPath: string) => Promise<void>;
  viewDiff: (projectPath: string, file: string, staged: boolean) => Promise<void>;
  stage: (projectPath: string, files: string[]) => Promise<void>;
  unstage: (projectPath: string, files: string[]) => Promise<void>;
  commit: (projectPath: string, message: string) => Promise<void>;
}

// Backend errors arrive as { type, message }; fall back to String(err).
function errorMessage(err: unknown): string {
  if (err && typeof err === "object" && "message" in err && typeof (err as { message: unknown }).message === "string") {
    return (err as { message: string }).message;
  }
  return String(err);
}

export const useGitStore = create<GitStore>()(
  immer((set) => ({
    status: null,
    diff: null,
    diffFile: null,
    loading: false,
    error: null,

    refresh: async (projectPath: string) => {
      set((s) => { s.loading = true; s.error = null; });
      try {
        const status = await gitStatus(projectPath);
        set((s) => { s.status = status; });
      } catch (err) {
        set((s) => { s.error = errorMessage(err); });
      } finally {
        set((s) => { s.loading = false; });
      }
    },

    viewDiff: async (projectPath: string, file: string, staged: boolean) => {
      set((s) => { s.loading = true; s.error = null; });
      try {
        const diff = await gitDiff(projectPath, file, staged);
        set((s) => { s.diff = diff; s.diffFile = file; });
      } catch (err) {
        set((s) => { s.error = errorMessage(err); });
      } finally {
        set((s) => { s.loading = false; });
      }
    },

    stage: async (projectPath: string, files: string[]) => {
      set((s) => { s.loading = true; s.error = null; });
      try {
        await gitStage(projectPath, files);
      } catch (err) {
        set((s) => { s.error = errorMessage(err); });
      } finally {
        set((s) => { s.loading = false; });
      }
    },

    unstage: async (projectPath: string, files: string[]) => {
      set((s) => { s.loading = true; s.error = null; });
      try {
        await gitUnstage(projectPath, files);
      } catch (err) {
        set((s) => { s.error = errorMessage(err); });
      } finally {
        set((s) => { s.loading = false; });
      }
    },

    commit: async (projectPath: string, message: string) => {
      set((s) => { s.loading = true; s.error = null; });
      try {
        await gitCommit(projectPath, message);
      } catch (err) {
        set((s) => { s.error = errorMessage(err); });
      } finally {
        set((s) => { s.loading = false; });
      }
    },
  }))
);
