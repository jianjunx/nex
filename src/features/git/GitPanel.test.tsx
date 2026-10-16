/** @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const { state, projectState } = vi.hoisted(() => ({
  state: {
    status: { branch: "main", ahead: 0, behind: 0 },
    statusLoading: false, opRunning: null, error: null,
    hasRepo: true, repoPath: "/p", treeView: false,
    clearError: vi.fn(), refresh: vi.fn(), loadBranches: vi.fn(),
    loadStashes: vi.fn(), push: vi.fn(), setTreeView: vi.fn(),
  },
  projectState: { projects: [{ id: "p", path: "/p" }], activeProjectId: "p" },
}));
vi.mock("../../stores/git.store", () => ({ useGitStore: () => state, isMissingGitRepo: () => false }));
vi.mock("../../stores/project.store", () => ({ useProjectStore: (select: (s: typeof projectState) => unknown) => select(projectState) }));
vi.mock("./BranchSelector", () => ({ BranchSelector: () => null }));
vi.mock("./ChangesSection", () => ({ ChangesSection: () => null }));
vi.mock("./HistorySection", () => ({ HistorySection: () => null }));
vi.mock("./GitActionsMenu", () => ({ GitActionsMenu: () => null, OpLogPanel: () => null }));
vi.mock("./GitErrorDialog", () => ({ GitErrorDialog: () => null }));
import { GitPanel } from "./GitPanel";

beforeEach(() => {
  vi.clearAllMocks();
  state.refresh.mockResolvedValue(undefined);
  state.loadBranches.mockResolvedValue(undefined);
  state.loadStashes.mockResolvedValue(undefined);
});
afterEach(cleanup);

it.each([false, true])("spins until every refresh settles, including failure=%s", async (fail) => {
  render(<GitPanel />);
  let finishStatus!: () => void;
  let finishBranches!: () => void;
  let finishStashes!: () => void;
  state.refresh.mockImplementationOnce(() => new Promise<void>((resolve) => { finishStatus = resolve; }));
  state.loadBranches.mockImplementationOnce(() => new Promise<void>((resolve, reject) => {
    finishBranches = () => fail ? reject(new Error("offline")) : resolve();
  }));
  state.loadStashes.mockImplementationOnce(() => new Promise<void>((resolve) => { finishStashes = resolve; }));
  const button = screen.getByTitle("刷新") as HTMLButtonElement;
  fireEvent.click(button);
  expect(button.querySelector(".animate-spin")).toBeTruthy();
  expect(button.disabled).toBe(true);
  fireEvent.click(button);
  expect(state.loadBranches).toHaveBeenCalledTimes(1);
  await act(async () => { finishStatus(); finishBranches(); });
  expect(button.querySelector(".animate-spin")).toBeTruthy();
  await act(async () => finishStashes());
  await waitFor(() => expect(button.querySelector(".animate-spin")).toBeNull());
  expect(button.disabled).toBe(false);
});
