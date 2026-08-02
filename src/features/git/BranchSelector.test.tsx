/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

let gitState: {
  branches: { name: string; isHead: boolean; isRemote: boolean; ahead: number | null; behind: number | null }[];
  opRunning: string | null;
  loadBranches: ReturnType<typeof vi.fn>;
  checkout: ReturnType<typeof vi.fn>;
  createBranch: ReturnType<typeof vi.fn>;
  deleteBranch: ReturnType<typeof vi.fn>;
};
vi.mock("../../stores/git.store", () => ({
  useGitStore: (selector?: (s: typeof gitState) => unknown) => (selector ? selector(gitState) : gitState),
}));

import { BranchSelector } from "./BranchSelector";

beforeEach(() => {
  vi.clearAllMocks();
  gitState = {
    branches: [
      { name: "main", isHead: true, isRemote: false, ahead: 0, behind: 0 },
      { name: "feature", isHead: false, isRemote: false, ahead: null, behind: null },
      { name: "origin/main", isHead: false, isRemote: true, ahead: null, behind: null },
    ],
    opRunning: null,
    loadBranches: vi.fn().mockResolvedValue(undefined),
    checkout: vi.fn().mockResolvedValue(true),
    createBranch: vi.fn().mockResolvedValue(true),
    deleteBranch: vi.fn().mockResolvedValue(true),
  };
});
afterEach(() => cleanup());

describe("BranchSelector", () => {
  it("loads branches on open and marks the head branch", () => {
    render(<BranchSelector projectPath="/p" open onOpenChange={() => {}} />);
    expect(gitState.loadBranches).toHaveBeenCalledWith("/p");
    // HEAD 行带 ✓ 图标（lucide Check 渲染为 svg），用分支名行的 data-testid 定位
    expect(screen.getByTestId("branch-main")).toBeTruthy();
  });

  it("checking out a branch closes the selector on success", async () => {
    const onOpenChange = vi.fn();
    render(<BranchSelector projectPath="/p" open onOpenChange={onOpenChange} />);
    fireEvent.click(screen.getByTestId("branch-feature"));
    await waitFor(() => expect(gitState.checkout).toHaveBeenCalledWith("/p", "feature"));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it("creates a new branch via the dropdown item then the dialog", async () => {
    render(<BranchSelector projectPath="/p" open onOpenChange={() => {}} />);
    // 下拉面板中的「新建分支…」项 → 弹小窗
    fireEvent.click(screen.getByTestId("new-branch-item"));
    fireEvent.change(screen.getByPlaceholderText("新分支名"), { target: { value: "hotfix" } });
    fireEvent.click(screen.getByRole("button", { name: "创建" }));
    await waitFor(() => expect(gitState.createBranch).toHaveBeenCalledWith("/p", "hotfix"));
    await waitFor(() => expect(gitState.checkout).toHaveBeenCalledWith("/p", "hotfix"));
  });

  it("deleting a branch goes through the confirm dialog", async () => {
    render(<BranchSelector projectPath="/p" open onOpenChange={() => {}} />);
    fireEvent.click(screen.getByTestId("delete-feature"));
    expect(screen.getByText(/确定删除分支「feature」/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    await waitFor(() => expect(gitState.deleteBranch).toHaveBeenCalledWith("/p", "feature"));
  });
});
