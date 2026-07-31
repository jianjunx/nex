/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

let gitState: {
  commits: { hash: string; message: string; author: string; time: number }[];
  historyLoading: boolean;
  historyOpen: boolean;
  setHistoryOpen: ReturnType<typeof vi.fn>;
  loadHistory: ReturnType<typeof vi.fn>;
  openCommitDiff: ReturnType<typeof vi.fn>;
};
vi.mock("../../stores/git.store", () => ({
  useGitStore: (selector?: (s: typeof gitState) => unknown) => (selector ? selector(gitState) : gitState),
}));

import { HistorySection } from "./HistorySection";

const NOW_S = Math.floor(Date.now() / 1000);
const COMMIT = { hash: "abc1234", message: "fix: bug", author: "张三", time: NOW_S - 3600 };

beforeEach(() => {
  vi.clearAllMocks();
  gitState = {
    commits: [],
    historyLoading: false,
    historyOpen: true,
    setHistoryOpen: vi.fn(),
    loadHistory: vi.fn().mockResolvedValue(undefined),
    openCommitDiff: vi.fn(),
  };
});
afterEach(() => cleanup());

describe("HistorySection", () => {
  it("auto-loads on mount only when the history is empty", () => {
    render(<HistorySection projectPath="/p" />);
    expect(gitState.loadHistory).toHaveBeenCalledWith("/p");

    cleanup();
    gitState.commits = [COMMIT];
    render(<HistorySection projectPath="/p" />);
    // 第二次挂载时 commits 非空：仍是同一次调用，未重复请求
    expect(gitState.loadHistory).toHaveBeenCalledTimes(1);
  });

  it("reloads when the project path changes even if history is non-empty (R1)", () => {
    gitState.commits = [COMMIT];
    const utils = render(<HistorySection projectPath="/a" />);
    // commits 非空且路径未变 → 不加载
    expect(gitState.loadHistory).not.toHaveBeenCalled();
    utils.rerender(<HistorySection projectPath="/b" />);
    expect(gitState.loadHistory).toHaveBeenCalledWith("/b");
  });

  it("renders commit rows with hash, message, author and relative time", () => {
    gitState.commits = [COMMIT];
    render(<HistorySection projectPath="/p" />);
    expect(screen.getByText("abc1234")).toBeTruthy();
    expect(screen.getByText("fix: bug")).toBeTruthy();
    expect(screen.getByText("张三")).toBeTruthy();
    expect(screen.getByText("1 小时前")).toBeTruthy();
  });

  it("header click toggles the collapsed state via the store", () => {
    gitState.commits = [COMMIT];
    render(<HistorySection projectPath="/p" />);
    fireEvent.click(screen.getByText("历史"));
    expect(gitState.setHistoryOpen).toHaveBeenCalledWith(false);
  });

  it("clicking a commit highlights it and opens the commit patch in the editor", () => {
    gitState.commits = [COMMIT];
    render(<HistorySection projectPath="/p" />);
    fireEvent.click(screen.getByTestId("commit-abc1234"));
    expect(gitState.openCommitDiff).toHaveBeenCalledWith("/p", "abc1234");
    expect(screen.getByTestId("commit-abc1234").className).toContain("accent");
  });
});
