import { beforeEach, describe, expect, it, vi } from "vitest";

const gitStatusMock = vi.fn();
const gitDiffMock = vi.fn();
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

vi.mock("../bridge/tauri", () => ({
  gitStatus: (...a: unknown[]) => gitStatusMock(...a),
  gitDiff: (...a: unknown[]) => gitDiffMock(...a),
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
}));

import { useGitStore } from "./git.store";

beforeEach(() => {
  vi.clearAllMocks();
  useGitStore.setState({
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
    await useGitStore.getState().fetch("/p");
    const s = useGitStore.getState();
    expect(s.opRunning).toBeNull();
    expect(s.opLog.some((l) => l.includes("获取") && l.includes("完成"))).toBe(true);
  });

  it("fetch failure records the backend message and still clears opRunning", async () => {
    gitFetchMock.mockRejectedValue({ type: "Git", message: "推送被拒绝：非快进，请先拉取合并" });
    gitStatusMock.mockResolvedValue(STATUS);
    await useGitStore.getState().fetch("/p");
    const s = useGitStore.getState();
    expect(s.error).toBe("推送被拒绝：非快进，请先拉取合并");
    expect(s.opRunning).toBeNull();
    expect(s.opLog.some((l) => l.includes("获取") && l.includes("失败"))).toBe(true);
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
