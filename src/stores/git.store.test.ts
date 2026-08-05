import { beforeEach, describe, expect, it, vi } from "vitest";

const gitStatusMock = vi.fn();
const gitDiffContentsMock = vi.fn();
const gitCommitPatchMock = vi.fn();
const gitStageMock = vi.fn();
const gitUnstageMock = vi.fn();
const gitCommitMock = vi.fn();
const gitLogMock = vi.fn();
const gitListBranchesMock = vi.fn();
const gitCheckoutMock = vi.fn();
const gitCreateBranchMock = vi.fn();
const gitDeleteBranchMock = vi.fn();
const gitDiscardMock = vi.fn();
const gitRevertStagedMock = vi.fn();
const gitStashSaveMock = vi.fn();
const gitStashListMock = vi.fn();
const gitStashApplyMock = vi.fn();
const gitStashPopMock = vi.fn();
const gitStashDropMock = vi.fn();
const gitFetchMock = vi.fn();
const gitPullMock = vi.fn();
const gitPushMock = vi.fn();
const gitCloneMock = vi.fn();
const gitMergeMock = vi.fn();

vi.mock("../bridge/tauri", () => ({
  gitStatus: (...a: unknown[]) => gitStatusMock(...a),
  gitDiffContents: (...a: unknown[]) => gitDiffContentsMock(...a),
  gitCommitPatch: (...a: unknown[]) => gitCommitPatchMock(...a),
  gitStage: (...a: unknown[]) => gitStageMock(...a),
  gitUnstage: (...a: unknown[]) => gitUnstageMock(...a),
  gitCommit: (...a: unknown[]) => gitCommitMock(...a),
  gitLog: (...a: unknown[]) => gitLogMock(...a),
  gitListBranches: (...a: unknown[]) => gitListBranchesMock(...a),
  gitCheckout: (...a: unknown[]) => gitCheckoutMock(...a),
  gitCreateBranch: (...a: unknown[]) => gitCreateBranchMock(...a),
  gitDeleteBranch: (...a: unknown[]) => gitDeleteBranchMock(...a),
  gitDiscard: (...a: unknown[]) => gitDiscardMock(...a),
  gitRevertStaged: (...a: unknown[]) => gitRevertStagedMock(...a),
  gitStashSave: (...a: unknown[]) => gitStashSaveMock(...a),
  gitStashList: (...a: unknown[]) => gitStashListMock(...a),
  gitStashApply: (...a: unknown[]) => gitStashApplyMock(...a),
  gitStashPop: (...a: unknown[]) => gitStashPopMock(...a),
  gitStashDrop: (...a: unknown[]) => gitStashDropMock(...a),
  gitFetch: (...a: unknown[]) => gitFetchMock(...a),
  gitPull: (...a: unknown[]) => gitPullMock(...a),
  gitPush: (...a: unknown[]) => gitPushMock(...a),
  gitClone: (...a: unknown[]) => gitCloneMock(...a),
  gitMerge: (...a: unknown[]) => gitMergeMock(...a),
}));

const openDiffTabMock = vi.fn();
vi.mock("./fs.store", () => ({
  useFsStore: { getState: () => ({ openDiffTab: openDiffTabMock }) },
}));

import { useGitStore } from "./git.store";

beforeEach(() => {
  vi.clearAllMocks();
  useGitStore.setState({
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
    commitMessage: "",
    treeView: false,
    historyOpen: false,
    opLogOpen: false,
  });
});

const STATUS = { branch: "main", ahead: 0, behind: 0, files: [] };

describe("git.store loading granularity", () => {
  it("refresh toggles statusLoading only", async () => {
    gitStatusMock.mockResolvedValue(STATUS);
    const p = useGitStore.getState().refresh("/p");
    expect(useGitStore.getState().statusLoading).toBe(true);
    await p;
    const s = useGitStore.getState();
    expect(s.statusLoading).toBe(false);
    expect(s.branchesLoading).toBe(false);
    expect(s.status?.branch).toBe("main");
  });

  it("loadBranches toggles branchesLoading only", async () => {
    gitListBranchesMock.mockResolvedValue([]);
    const p = useGitStore.getState().loadBranches("/p");
    expect(useGitStore.getState().branchesLoading).toBe(true);
    await p;
    expect(useGitStore.getState().branchesLoading).toBe(false);
    expect(useGitStore.getState().statusLoading).toBe(false);
  });
});

describe("git.store opLog", () => {
  it("fetch success appends a completion line and clears opRunning", async () => {
    gitFetchMock.mockResolvedValue(undefined);
    gitStatusMock.mockResolvedValue(STATUS);
    gitListBranchesMock.mockResolvedValue([]);
    gitLogMock.mockResolvedValue([]);
    await useGitStore.getState().fetch("/p");
    const s = useGitStore.getState();
    expect(s.opRunning).toBeNull();
    expect(s.opLog.some((l) => l.includes("同步") && l.includes("完成"))).toBe(true);
  });

  it("pull success refreshes status and history", async () => {
    gitPullMock.mockResolvedValue(undefined);
    gitStatusMock.mockResolvedValue(STATUS);
    gitListBranchesMock.mockResolvedValue([]);
    gitLogMock.mockResolvedValue([{ hash: "abc", message: "m", author: "a", time: 1 }]);
    const ok = await useGitStore.getState().pull("/p");
    expect(ok).toBe(true);
    expect(gitLogMock).toHaveBeenCalled();
    expect(useGitStore.getState().commits).toHaveLength(1);
  });

  it("pull failure opens the operation log", async () => {
    gitPullMock.mockRejectedValue({ type: "Git", message: "did not specify a branch" });
    const ok = await useGitStore.getState().pull("/p");
    expect(ok).toBe(false);
    expect(useGitStore.getState().opLogOpen).toBe(true);
  });

  it("fetch failure records the backend message and still clears opRunning", async () => {
    gitFetchMock.mockRejectedValue({ type: "Git", message: "推送被拒绝：非快进，请先拉取合并" });
    gitStatusMock.mockResolvedValue(STATUS);
    await useGitStore.getState().fetch("/p");
    const s = useGitStore.getState();
    expect(s.error).toBe("推送被拒绝：非快进，请先拉取合并");
    expect(s.opRunning).toBeNull();
    expect(s.opLog.some((l) => l.includes("同步") && l.includes("失败"))).toBe(true);
  });

  it("opLog trims to 100 entries (ring buffer)", () => {
    for (let i = 0; i < 105; i++) useGitStore.getState().appendLog(`line ${i}`);
    const log = useGitStore.getState().opLog;
    expect(log).toHaveLength(100);
    expect(log[log.length - 1]).toContain("line 104");
    expect(log[0]).toContain("line 5");
  });
});

describe("git.store commitWith", () => {
  it("push mode commits then pushes on the current branch", async () => {
    gitCommitMock.mockResolvedValue("oid");
    gitPushMock.mockResolvedValue(undefined);
    gitStatusMock.mockResolvedValue(STATUS);
    useGitStore.setState({ commitMessage: "hello", status: STATUS });
    await useGitStore.getState().commitWith("/p", "push");
    expect(gitCommitMock).toHaveBeenCalledWith("/p", "hello");
    expect(gitPushMock).toHaveBeenCalledWith("/p", "origin", "main");
    expect(useGitStore.getState().commitMessage).toBe("");
  });

  it("empty message is a no-op", async () => {
    useGitStore.setState({ commitMessage: "   " });
    await useGitStore.getState().commitWith("/p", "commit");
    expect(gitCommitMock).not.toHaveBeenCalled();
  });

  it("failed commit does not clear the message nor push", async () => {
    gitCommitMock.mockRejectedValue({ type: "Git", message: "nothing to commit" });
    useGitStore.setState({ commitMessage: "hello", status: STATUS });
    await useGitStore.getState().commitWith("/p", "push");
    expect(useGitStore.getState().commitMessage).toBe("hello");
    expect(gitPushMock).not.toHaveBeenCalled();
  });

  it("auto-stages all unstaged files when nothing is staged, then commits", async () => {
    gitStageMock.mockResolvedValue(undefined);
    gitCommitMock.mockResolvedValue("oid");
    gitStatusMock.mockResolvedValue(STATUS);
    useGitStore.setState({
      commitMessage: "wip",
      status: {
        branch: "main",
        ahead: 0,
        behind: 0,
        files: [
          { path: "a.txt", status: "modified", staged: false },
          { path: "b.txt", status: "untracked", staged: false },
        ],
      },
    });
    await useGitStore.getState().commitWith("/p", "commit");
    expect(gitStageMock).toHaveBeenCalledWith("/p", ["a.txt", "b.txt"]);
    expect(gitCommitMock).toHaveBeenCalledWith("/p", "wip");
    expect(useGitStore.getState().commitMessage).toBe("");
  });

  it("does not auto-stage when some files are already staged", async () => {
    gitCommitMock.mockResolvedValue("oid");
    gitStatusMock.mockResolvedValue(STATUS);
    useGitStore.setState({
      commitMessage: "partial",
      status: {
        branch: "main",
        ahead: 0,
        behind: 0,
        files: [
          { path: "staged.txt", status: "modified", staged: true },
          { path: "left.txt", status: "modified", staged: false },
        ],
      },
    });
    await useGitStore.getState().commitWith("/p", "commit");
    expect(gitStageMock).not.toHaveBeenCalled();
    expect(gitCommitMock).toHaveBeenCalledWith("/p", "partial");
  });

  it("skips commit when auto-stage fails", async () => {
    gitStageMock.mockRejectedValue({ type: "Git", message: "stage failed" });
    useGitStore.setState({
      commitMessage: "wip",
      status: {
        branch: "main",
        ahead: 0,
        behind: 0,
        files: [{ path: "a.txt", status: "modified", staged: false }],
      },
    });
    await useGitStore.getState().commitWith("/p", "commit");
    expect(gitCommitMock).not.toHaveBeenCalled();
    expect(useGitStore.getState().commitMessage).toBe("wip");
    expect(useGitStore.getState().error).toBe("stage failed");
  });
});

describe("git.store push guard", () => {
  it("push without a known branch sets a Chinese error and skips the backend", async () => {
    const ok = await useGitStore.getState().push("/p");
    expect(ok).toBe(false);
    expect(gitPushMock).not.toHaveBeenCalled();
    expect(useGitStore.getState().error).toBe("无法确定当前分支名，不能推送");
  });

  it("discard with an empty file list skips the backend entirely", async () => {
    const ok = await useGitStore.getState().discard("/p", []);
    expect(ok).toBe(false);
    expect(gitDiscardMock).not.toHaveBeenCalled();
  });

  it("revertStaged with an empty file list skips the backend entirely", async () => {
    const ok = await useGitStore.getState().revertStaged("/p", []);
    expect(ok).toBe(false);
    expect(gitRevertStagedMock).not.toHaveBeenCalled();
  });
});

describe("git.store clearError", () => {
  it("clears the error slot so the panel error bar can be dismissed", () => {
    useGitStore.setState({ error: "推送被拒绝：非快进，请先拉取合并" });
    useGitStore.getState().clearError();
    expect(useGitStore.getState().error).toBeNull();
  });
});

describe("git.store loadHistory", () => {
  it("stores commits returned by gitLog", async () => {
    gitLogMock.mockResolvedValue([{ hash: "abc1234", message: "init", author: "a", time: 1 }]);
    await useGitStore.getState().loadHistory("/p");
    expect(gitLogMock).toHaveBeenCalledWith("/p", 20);
    expect(useGitStore.getState().commits).toHaveLength(1);
    expect(useGitStore.getState().historyLoading).toBe(false);
  });

  it("records the backend error on failure", async () => {
    gitLogMock.mockRejectedValue({ type: "Git", message: "reference not found" });
    await useGitStore.getState().loadHistory("/p");
    expect(useGitStore.getState().error).toBe("reference not found");
    expect(useGitStore.getState().commits).toHaveLength(0);
    expect(useGitStore.getState().historyLoading).toBe(false);
  });
});

describe("git.store diff tabs", () => {
  it("openDiffInEditor opens a merge diff tab from the two-version command", async () => {
    gitDiffContentsMock.mockResolvedValue({ original: "v1", revised: "v2", binary: false });
    await useGitStore.getState().openDiffInEditor("/p", "a.txt", false);
    expect(gitDiffContentsMock).toHaveBeenCalledWith("/p", "a.txt", false);
    expect(openDiffTabMock).toHaveBeenCalledWith("diff:unstaged:a.txt", {
      mode: "merge",
      title: "a.txt",
      languageHint: "a.txt",
      original: "v1",
      revised: "v2",
      binary: false,
    });
  });

  it("openCommitDiff opens a patch tab from the commit patch command", async () => {
    gitCommitPatchMock.mockResolvedValue("+v1\n");
    useGitStore.getState().openCommitDiff("/p", "abc1234");
    await vi.waitFor(() => expect(openDiffTabMock).toHaveBeenCalled());
    expect(gitCommitPatchMock).toHaveBeenCalledWith("/p", "abc1234");
    expect(openDiffTabMock).toHaveBeenCalledWith("diff:commit:abc1234", {
      mode: "patch",
      title: "提交 abc1234",
      languageHint: "",
      original: "",
      revised: "+v1\n",
      binary: false,
    });
  });
});
