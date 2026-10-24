import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import {
  gitStatus, gitStage, gitUnstage, gitCommit, gitLog,
  gitListBranches, gitCheckout, gitCreateBranch, gitDeleteBranch,
  gitDiscard, gitRevertStaged,
  gitStashSave, gitStashList, gitStashApply, gitStashPop, gitStashDrop,
  gitFetch, gitPull, gitPush, gitClone, gitMerge,
  gitDiffContents, gitCommitPatch,
  type GitStatus, type BranchInfo, type CommitInfo, type StashEntry,
} from "../bridge/tauri";
import { useFsStore } from "./fs.store";
import { toast } from "./toast.store";

const OP_LOG_MAX = 100;

/** git stderr / libgit2 报错常常是多行，提示里只留第一行（完整内容在操作日志）。 */
function firstLine(msg: string): string {
  return msg.split(/\r?\n/).find((l) => l.trim().length > 0)?.trim() ?? msg;
}

function timeStamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

interface GitStore {
  status: GitStatus | null;
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
  /** `null` until the first status probe; `false` means the project has no git repo. */
  hasRepo: boolean | null;
  /** Project path the current git slot belongs to; used to drop stale state on switch. */
  repoPath: string | null;
  commitMessage: string;
  treeView: boolean;
  historyOpen: boolean;
  opLogOpen: boolean;

  refresh: (projectPath: string) => Promise<void>;
  openDiffInEditor: (projectPath: string, file: string, staged: boolean) => Promise<void>;
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
  merge: (projectPath: string, branch: string) => Promise<boolean>;
  loadStashes: (projectPath: string) => Promise<void>;
  stashSave: (projectPath: string, message?: string) => Promise<boolean>;
  stashApply: (projectPath: string, id: string) => Promise<boolean>;
  stashPop: (projectPath: string, id: string) => Promise<boolean>;
  stashDrop: (projectPath: string, id: string) => Promise<boolean>;
  discard: (projectPath: string, files: string[]) => Promise<boolean>;
  revertStaged: (projectPath: string, files: string[]) => Promise<boolean>;
  loadHistory: (projectPath: string) => Promise<void>;
  openCommitDiff: (projectPath: string, commitHash: string) => void;
  appendLog: (line: string) => void;
  clearLog: () => void;
  clearError: () => void;
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

/** libgit2 / git CLI messages for a directory that is not a repository. */
export function isMissingGitRepo(err: unknown): boolean {
  const msg = errorMessage(err);
  return /could not find repository|not a git repository|NotFound \(-3\)|当前项目不是 Git 仓库/i.test(msg);
}

export const useGitStore = create<GitStore>()(
  immer((set, get) => {
    const markMissingRepo = () =>
      set((s) => {
        s.status = null;
        s.hasRepo = false;
        s.branches = [];
        s.commits = [];
        s.stashes = [];
        s.error = null;
      });
    const adoptPath = (projectPath: string) => {
      if (get().repoPath === projectPath) return;
      const switching = get().repoPath != null;
      set((s) => {
        s.repoPath = projectPath;
        s.status = null;
        s.hasRepo = null;
        s.branches = [];
        s.commits = [];
        s.stashes = [];
        // Keep a freshly recorded op failure when the slot is first bound
        // (e.g. fetch → refresh). Only drop errors when leaving another project.
        if (switching) s.error = null;
      });
    };
    // Append one op-log line; trim from the front beyond OP_LOG_MAX.
    const logOp = (op: string, failure?: string) =>
      set((s) => {
        s.opLog.push(failure ? `${timeStamp()} ${op}：失败 — ${failure}` : `${timeStamp()} ${op}：完成`);
        if (s.opLog.length > OP_LOG_MAX) s.opLog.splice(0, s.opLog.length - OP_LOG_MAX);
      });

    // Shared bookkeeping for network/destructive ops: opRunning + error +
    // opLog. Returns false on failure so callers can chain conditionally.
    // 每个走这里的操作都会弹一条轻提示：GitPanel 顶栏只有 Push / Refresh 两个
    // 按钮，其余操作全在 ··· 菜单和行内图标里，点完列表刷新是最弱的反馈，
    // 拉取/推送这类网络操作更不能只靠"图标不转了"来暗示成功。
    // `successToast: false` 给编排型调用方用：智能提交会自动先暂存一次，
    // 那一步成功了不该再弹一条，用户点的是「提交」。
    const runOp = async (
      name: string,
      fn: () => Promise<void>,
      opts: { successToast?: boolean } = {},
    ): Promise<boolean> => {
      set((s) => { s.opRunning = name; s.error = null; });
      try {
        await fn();
        logOp(name);
        if (opts.successToast !== false) {
          toast({ variant: "success", message: `${name}成功` });
        }
        return true;
      } catch (err) {
        if (isMissingGitRepo(err)) {
          markMissingRepo();
          return false;
        }
        const msg = errorMessage(err);
        set((s) => { s.error = msg; });
        logOp(name, msg);
        // 失败始终提示：同时有 GitErrorDialog（模态，含完整输出）和操作日志，
        // 提示只给结论。
        toast({ variant: "error", message: `${name}失败`, detail: firstLine(msg) });
        return false;
      } finally {
        set((s) => { s.opRunning = null; });
      }
    };

    // Status-scope load: statusLoading flag, shared error slot. Does not
    // clear error at start — runOp already does that for op flows, and an
    // unconditional refresh (e.g. after fetch) must not wipe a freshly
    // recorded op failure (see git.store.test.ts opLog failure case).
    // `toastLabel` 为空表示静默：refresh 会被文件监听器反复触发，也常跟在别的
    // 操作后面，它的失败由操作日志兜着，不该再弹一条。
    const loadStatus = async (fn: () => Promise<void>, toastLabel?: string, scope?: string) => {
      set((s) => { s.statusLoading = true; });
      try {
        await fn();
      } catch (err) {
        if (scope && get().repoPath !== scope) return;
        if (isMissingGitRepo(err)) {
          markMissingRepo();
          return;
        }
        const msg = errorMessage(err);
        set((s) => { s.error = msg; });
        if (toastLabel) {
          toast({ variant: "error", message: `${toastLabel}失败`, detail: firstLine(msg) });
        }
      } finally {
        if (!scope || get().repoPath === scope) set((s) => { s.statusLoading = false; });
      }
    };

    const statusRequests = new Map<string, Promise<void>>();
    const refreshRequested = new Set<string>();

    return {
      status: null,
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
      hasRepo: null,
      repoPath: null,
      commitMessage: "",
      treeView: false,
      historyOpen: false,
      opLogOpen: false,

      refresh: (projectPath) => {
        adoptPath(projectPath);
        const pending = statusRequests.get(projectPath);
        if (pending) {
          refreshRequested.add(projectPath);
          return pending;
        }
        const request = loadStatus(async () => {
          try {
            const status = await gitStatus(projectPath);
            if (get().repoPath !== projectPath) return;
            if (!status) { markMissingRepo(); return; }
            set((s) => { s.status = status; s.hasRepo = true; });
          } catch (error) {
            if (get().repoPath === projectPath) throw error;
          }
        }, undefined, projectPath).finally(() => {
          statusRequests.delete(projectPath);
          if (refreshRequested.delete(projectPath) && get().repoPath === projectPath) {
            void get().refresh(projectPath);
          }
        });
        statusRequests.set(projectPath, request);
        return request;
      },

      openDiffInEditor: async (projectPath, file, staged) => {
        try {
          const contents = await gitDiffContents(projectPath, file, staged);
          useFsStore.getState().openDiffTab(`diff:${staged ? "staged" : "unstaged"}:${file}`, {
            mode: "merge",
            title: staged ? `${file}（已暂存）` : file,
            languageHint: file,
            original: contents.original,
            revised: contents.revised,
            binary: contents.binary,
          });
        } catch (err) {
          const msg = errorMessage(err);
          set((s) => { s.error = msg; });
          toast({ variant: "error", message: "打开差异失败", detail: firstLine(msg) });
        }
      },

      stage: async (projectPath, files) =>
        loadStatus(async () => {
          await gitStage(projectPath, files);
        }, "暂存"),

      unstage: async (projectPath, files) =>
        loadStatus(async () => {
          await gitUnstage(projectPath, files);
        }, "取消暂存"),

      commit: (projectPath, message) => runOp("提交", () => gitCommit(projectPath, message).then(() => undefined)),

      setCommitMessage: (message) => set((s) => { s.commitMessage = message; }),

      commitWith: async (projectPath, mode) => {
        const msg = get().commitMessage.trim();
        if (!msg || get().opRunning) return;

        // Smart commit (VS Code / Cursor): if the index is empty but there
        // are working-tree changes, stage them all before committing. When
        // the user already staged a subset, leave the rest alone.
        const files = get().status?.files ?? [];
        const hasStaged = files.some((f) => f.staged);
        const unstagedPaths = files.filter((f) => !f.staged).map((f) => f.path);
        if (!hasStaged && unstagedPaths.length > 0) {
          const stagedOk = await runOp("暂存", () => gitStage(projectPath, unstagedPaths), {
            successToast: false,
          });
          if (!stagedOk) return;
        }

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
        adoptPath(projectPath);
        if (get().hasRepo === false) return;
        set((s) => { s.branchesLoading = true; });
        try {
          const branches = await gitListBranches(projectPath);
          set((s) => { s.branches = branches; });
        } catch (err) {
          if (isMissingGitRepo(err)) {
            markMissingRepo();
            return;
          }
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
        const ok = await runOp("同步", () => gitFetch(projectPath, remote));
        await get().refresh(projectPath);
        if (ok) {
          await get().loadBranches(projectPath);
          await get().loadHistory(projectPath);
        }
      },

      pull: async (projectPath, remote = "origin") => {
        const ok = await runOp("拉取", () => gitPull(projectPath, remote));
        if (ok) {
          await get().refresh(projectPath);
          await get().loadBranches(projectPath);
          await get().loadHistory(projectPath);
        } else {
          // 失败时自动展开操作日志，便于看到完整 stderr
          set((s) => { s.opLogOpen = true; });
        }
        return ok;
      },

      push: async (projectPath, remote = "origin") => {
        const branch = get().status?.branch;
        if (!branch || branch === "HEAD") {
          const msg = "无法确定当前分支名，不能推送";
          set((s) => { s.error = msg; });
          toast({ variant: "error", message: "推送失败", detail: msg });
          return false;
        }
        const ok = await runOp("推送", () => gitPush(projectPath, remote, branch));
        if (ok) await get().refresh(projectPath);
        else set((s) => { s.opLogOpen = true; });
        return ok;
      },

      clone: (url, dest) => runOp("克隆", () => gitClone(url, dest)),

      merge: async (projectPath, branch) => {
        const ok = await runOp("合并", () => gitMerge(projectPath, branch));
        if (ok) {
          await get().refresh(projectPath);
          await get().loadHistory(projectPath);
        } else {
          set((s) => { s.opLogOpen = true; });
        }
        return ok;
      },
      loadStashes: async (projectPath) => {
        adoptPath(projectPath);
        if (get().hasRepo === false) return;
        set((s) => { s.stashesLoading = true; });
        try {
          const stashes = await gitStashList(projectPath);
          set((s) => { s.stashes = stashes; });
        } catch (err) {
          if (isMissingGitRepo(err)) {
            markMissingRepo();
            return;
          }
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

      stashApply: async (projectPath, id) => {
        const ok = await runOp("应用存储", () => gitStashApply(projectPath, id));
        if (ok) await get().refresh(projectPath);
        return ok;
      },

      stashPop: async (projectPath, id) => {
        const ok = await runOp("弹出存储", () => gitStashPop(projectPath, id));
        if (ok) {
          await get().refresh(projectPath);
          await get().loadStashes(projectPath);
        }
        return ok;
      },

      stashDrop: async (projectPath, id) => {
        const ok = await runOp("删除存储", () => gitStashDrop(projectPath, id));
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
        adoptPath(projectPath);
        if (get().hasRepo === false) return;
        set((s) => { s.historyLoading = true; });
        try {
          const commits = await gitLog(projectPath, 20);
          set((s) => { s.commits = commits; });
        } catch (err) {
          if (isMissingGitRepo(err)) {
            markMissingRepo();
            return;
          }
          set((s) => { s.error = errorMessage(err); });
        } finally {
          set((s) => { s.historyLoading = false; });
        }
      },

      openCommitDiff: (projectPath, commitHash) => {
        void (async () => {
          try {
            const patch = await gitCommitPatch(projectPath, commitHash);
            useFsStore.getState().openDiffTab(`diff:commit:${commitHash}`, {
              mode: "patch",
              title: `提交 ${commitHash}`,
              languageHint: "",
              original: "",
              revised: patch,
              binary: false,
            });
          } catch (err) {
            const msg = errorMessage(err);
            set((s) => { s.error = msg; });
            toast({ variant: "error", message: "打开提交差异失败", detail: firstLine(msg) });
          }
        })();
      },

      appendLog: (line) =>
        set((s) => {
          s.opLog.push(`${timeStamp()} ${line}`);
          if (s.opLog.length > OP_LOG_MAX) s.opLog.splice(0, s.opLog.length - OP_LOG_MAX);
        }),

      clearLog: () => set((s) => { s.opLog = []; }),
      clearError: () => set((s) => { s.error = null; }),
      setTreeView: (v) => set((s) => { s.treeView = v; }),
      setHistoryOpen: (v) => set((s) => { s.historyOpen = v; }),
      setOpLogOpen: (v) => set((s) => { s.opLogOpen = v; }),
    };
  })
);
