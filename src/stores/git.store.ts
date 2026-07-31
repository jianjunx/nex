import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import {
  gitStatus, gitDiff, gitStage, gitUnstage, gitCommit, gitLog,
  gitListBranches, gitCheckout, gitCreateBranch, gitDeleteBranch,
  gitDiscard, gitRevertStaged,
  gitStashSave, gitStashList, gitStashApply, gitStashPop, gitStashDrop,
  gitFetch, gitPull, gitPush, gitClone,
  type GitStatus, type BranchInfo, type CommitInfo, type StashEntry,
} from "../bridge/tauri";

const OP_LOG_MAX = 100;

function timeStamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

interface GitStore {
  status: GitStatus | null;
  diff: string | null;
  diffFile: string | null;
  branches: BranchInfo[];
  commits: CommitInfo[];
  stashes: StashEntry[];
  statusLoading: boolean;
  branchesLoading: boolean;
  historyLoading: boolean;
  stashesLoading: boolean;
  opRunning: string | null;
  opLog: string[];
  error: string | null;
  commitMessage: string;
  treeView: boolean;
  historyOpen: boolean;
  opLogOpen: boolean;

  refresh: (projectPath: string) => Promise<void>;
  viewDiff: (projectPath: string, file: string, staged: boolean) => Promise<void>;
  stage: (projectPath: string, files: string[]) => Promise<void>;
  unstage: (projectPath: string, files: string[]) => Promise<void>;
  commit: (projectPath: string, message: string) => Promise<boolean>;
  setCommitMessage: (message: string) => void;
  commitWith: (projectPath: string, mode: "commit" | "push" | "sync") => Promise<void>;
  loadBranches: (projectPath: string) => Promise<void>;
  checkout: (projectPath: string, name: string) => Promise<boolean>;
  createBranch: (projectPath: string, name: string) => Promise<boolean>;
  deleteBranch: (projectPath: string, name: string) => Promise<boolean>;
  fetch: (projectPath: string, remote?: string) => Promise<void>;
  pull: (projectPath: string, remote?: string) => Promise<boolean>;
  push: (projectPath: string, remote?: string) => Promise<boolean>;
  clone: (url: string, dest: string) => Promise<boolean>;
  loadStashes: (projectPath: string) => Promise<void>;
  stashSave: (projectPath: string, message?: string) => Promise<boolean>;
  stashApply: (projectPath: string, index: number) => Promise<boolean>;
  stashPop: (projectPath: string, index: number) => Promise<boolean>;
  stashDrop: (projectPath: string, index: number) => Promise<boolean>;
  discard: (projectPath: string, files: string[]) => Promise<boolean>;
  revertStaged: (projectPath: string, files: string[]) => Promise<boolean>;
  loadHistory: (projectPath: string) => Promise<void>;
  openCommitDiff: (projectPath: string, commitHash: string, path?: string) => void;
  appendLog: (line: string) => void;
  clearLog: () => void;
  setTreeView: (v: boolean) => void;
  setHistoryOpen: (v: boolean) => void;
  setOpLogOpen: (v: boolean) => void;
}

// Backend errors arrive as { type, message }; fall back to String(err).
function errorMessage(err: unknown): string {
  if (err && typeof err === "object" && "message" in err && typeof (err as { message: unknown }).message === "string") {
    return (err as { message: string }).message;
  }
  return String(err);
}

export const useGitStore = create<GitStore>()(
  immer((set, get) => {
    // Append one op-log line; trim from the front beyond OP_LOG_MAX.
    const logOp = (op: string, failure?: string) =>
      set((s) => {
        s.opLog.push(failure ? `${timeStamp()} ${op}：失败 — ${failure}` : `${timeStamp()} ${op}：完成`);
        if (s.opLog.length > OP_LOG_MAX) s.opLog.splice(0, s.opLog.length - OP_LOG_MAX);
      });

    // Shared bookkeeping for network/destructive ops: opRunning + error +
    // opLog. Returns false on failure so callers can chain conditionally.
    const runOp = async (name: string, fn: () => Promise<void>): Promise<boolean> => {
      set((s) => { s.opRunning = name; s.error = null; });
      try {
        await fn();
        logOp(name);
        return true;
      } catch (err) {
        const msg = errorMessage(err);
        set((s) => { s.error = msg; });
        logOp(name, msg);
        return false;
      } finally {
        set((s) => { s.opRunning = null; });
      }
    };

    // Status-scope load: statusLoading flag, shared error slot. Does not
    // clear error at start — runOp already does that for op flows, and an
    // unconditional refresh (e.g. after fetch) must not wipe a freshly
    // recorded op failure (see git.store.test.ts opLog failure case).
    const loadStatus = async (fn: () => Promise<void>) => {
      set((s) => { s.statusLoading = true; });
      try {
        await fn();
      } catch (err) {
        set((s) => { s.error = errorMessage(err); });
      } finally {
        set((s) => { s.statusLoading = false; });
      }
    };

    return {
      status: null,
      diff: null,
      diffFile: null,
      branches: [],
      commits: [],
      stashes: [],
      statusLoading: false,
      branchesLoading: false,
      historyLoading: false,
      stashesLoading: false,
      opRunning: null,
      opLog: [],
      error: null,
      commitMessage: "",
      treeView: false,
      historyOpen: false,
      opLogOpen: false,

      refresh: async (projectPath) =>
        loadStatus(async () => {
          const status = await gitStatus(projectPath);
          set((s) => { s.status = status; });
        }),

      viewDiff: async (projectPath, file, staged) =>
        loadStatus(async () => {
          const diff = await gitDiff(projectPath, file, staged);
          set((s) => { s.diff = diff; s.diffFile = file; });
        }),

      stage: async (projectPath, files) =>
        loadStatus(async () => {
          await gitStage(projectPath, files);
        }),

      unstage: async (projectPath, files) =>
        loadStatus(async () => {
          await gitUnstage(projectPath, files);
        }),

      commit: (projectPath, message) => runOp("提交", () => gitCommit(projectPath, message).then(() => undefined)),

      setCommitMessage: (message) => set((s) => { s.commitMessage = message; }),

      commitWith: async (projectPath, mode) => {
        const msg = get().commitMessage.trim();
        if (!msg || get().opRunning) return;
        const ok = await get().commit(projectPath, msg);
        if (!ok) return;
        set((s) => { s.commitMessage = ""; });
        if (mode === "push") {
          await get().push(projectPath);
        } else if (mode === "sync") {
          const pulled = await get().pull(projectPath);
          if (pulled) await get().push(projectPath);
        }
        await get().refresh(projectPath);
      },

      loadBranches: async (projectPath) => {
        set((s) => { s.branchesLoading = true; });
        try {
          const branches = await gitListBranches(projectPath);
          set((s) => { s.branches = branches; });
        } catch (err) {
          set((s) => { s.error = errorMessage(err); });
        } finally {
          set((s) => { s.branchesLoading = false; });
        }
      },

      checkout: async (projectPath, name) => {
        const ok = await runOp("签出", () => gitCheckout(projectPath, name));
        if (ok) {
          await get().refresh(projectPath);
          await get().loadBranches(projectPath);
        }
        return ok;
      },

      createBranch: async (projectPath, name) => {
        const ok = await runOp("新建分支", () => gitCreateBranch(projectPath, name));
        if (ok) await get().loadBranches(projectPath);
        return ok;
      },

      deleteBranch: async (projectPath, name) => {
        const ok = await runOp("删除分支", () => gitDeleteBranch(projectPath, name));
        if (ok) await get().loadBranches(projectPath);
        return ok;
      },

      fetch: async (projectPath, remote = "origin") => {
        await runOp("获取", () => gitFetch(projectPath, remote));
        await get().refresh(projectPath);
      },

      pull: async (projectPath, remote = "origin") => {
        const ok = await runOp("拉取", () => gitPull(projectPath, remote));
        if (ok) await get().refresh(projectPath);
        return ok;
      },

      push: async (projectPath, remote = "origin") => {
        const branch = get().status?.branch;
        if (!branch || branch === "HEAD") {
          set((s) => { s.error = "无法确定当前分支名，不能推送"; });
          return false;
        }
        const ok = await runOp("推送", () => gitPush(projectPath, remote, branch));
        if (ok) await get().refresh(projectPath);
        return ok;
      },

      clone: (url, dest) => runOp("克隆", () => gitClone(url, dest)),

      loadStashes: async (projectPath) => {
        set((s) => { s.stashesLoading = true; });
        try {
          const stashes = await gitStashList(projectPath);
          set((s) => { s.stashes = stashes; });
        } catch (err) {
          set((s) => { s.error = errorMessage(err); });
        } finally {
          set((s) => { s.stashesLoading = false; });
        }
      },

      stashSave: async (projectPath, message) => {
        const ok = await runOp("存储", () => gitStashSave(projectPath, message ?? ""));
        if (ok) {
          await get().refresh(projectPath);
          await get().loadStashes(projectPath);
        }
        return ok;
      },

      stashApply: async (projectPath, index) => {
        const ok = await runOp("应用存储", () => gitStashApply(projectPath, index));
        if (ok) await get().refresh(projectPath);
        return ok;
      },

      stashPop: async (projectPath, index) => {
        const ok = await runOp("弹出存储", () => gitStashPop(projectPath, index));
        if (ok) {
          await get().refresh(projectPath);
          await get().loadStashes(projectPath);
        }
        return ok;
      },

      stashDrop: async (projectPath, index) => {
        const ok = await runOp("删除存储", () => gitStashDrop(projectPath, index));
        if (ok) await get().loadStashes(projectPath);
        return ok;
      },

      discard: async (projectPath, files) => {
        if (files.length === 0) return false; // 后端 checkout_index 空 paths = 全仓库，严禁下传空数组
        const ok = await runOp("丢弃更改", () => gitDiscard(projectPath, files));
        if (ok) await get().refresh(projectPath);
        return ok;
      },

      revertStaged: async (projectPath, files) => {
        if (files.length === 0) return false; // 后端 reset_default 空 paths = 全仓库，严禁下传空数组
        const ok = await runOp("撤销暂存更改", () => gitRevertStaged(projectPath, files));
        if (ok) await get().refresh(projectPath);
        return ok;
      },

      loadHistory: async (projectPath) => {
        set((s) => { s.historyLoading = true; });
        try {
          const commits = await gitLog(projectPath, 20);
          set((s) => { s.commits = commits; });
        } catch (err) {
          set((s) => { s.error = errorMessage(err); });
        } finally {
          set((s) => { s.historyLoading = false; });
        }
      },

      openCommitDiff: (projectPath, _commitHash, path) => {
        // Plan 4 replaces this with a real read-only diff tab in the editor
        // panel (fs.store.diffTabs + git_diff_commit). Until then, reuse the
        // existing inline diff slot so the click is not dead.
        void get().viewDiff(projectPath, path ?? "", false);
      },

      appendLog: (line) =>
        set((s) => {
          s.opLog.push(`${timeStamp()} ${line}`);
          if (s.opLog.length > OP_LOG_MAX) s.opLog.splice(0, s.opLog.length - OP_LOG_MAX);
        }),

      clearLog: () => set((s) => { s.opLog = []; }),
      setTreeView: (v) => set((s) => { s.treeView = v; }),
      setHistoryOpen: (v) => set((s) => { s.historyOpen = v; }),
      setOpLogOpen: (v) => set((s) => { s.opLogOpen = v; }),
    };
  })
);
