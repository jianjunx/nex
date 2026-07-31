/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

type ChangeFile = {
  path: string;
  status: "modified" | "added" | "deleted" | "untracked";
  staged: boolean;
};
let gitState: {
  status: { files: ChangeFile[] } | null;
  statusLoading: boolean;
  opRunning: string | null;
  treeView: boolean;
  setTreeView: ReturnType<typeof vi.fn>;
  stage: ReturnType<typeof vi.fn>;
  unstage: ReturnType<typeof vi.fn>;
  discard: ReturnType<typeof vi.fn>;
  revertStaged: ReturnType<typeof vi.fn>;
  viewDiff: ReturnType<typeof vi.fn>;
};
vi.mock("../../stores/git.store", () => ({
  useGitStore: (selector?: (s: typeof gitState) => unknown) => (selector ? selector(gitState) : gitState),
}));

const openFileMock = vi.fn();
vi.mock("../../stores/fs.store", () => ({
  useFsStore: { getState: () => ({ openFile: openFileMock }) },
}));

import { ChangesSection } from "./ChangesSection";

beforeEach(() => {
  vi.clearAllMocks();
  gitState = {
    status: {
      files: [
        { path: "a.txt", status: "modified", staged: false },
        { path: "b.txt", status: "untracked", staged: false },
        { path: "c.txt", status: "added", staged: true },
      ],
    },
    statusLoading: false,
    opRunning: null,
    treeView: false,
    setTreeView: vi.fn(),
    stage: vi.fn().mockResolvedValue(undefined),
    unstage: vi.fn().mockResolvedValue(undefined),
    discard: vi.fn().mockResolvedValue(true),
    revertStaged: vi.fn().mockResolvedValue(true),
    viewDiff: vi.fn().mockResolvedValue(undefined),
  };
});
afterEach(() => cleanup());

describe("ChangesSection", () => {
  it("renders both groups with counts", () => {
    render(<ChangesSection projectPath="/p" />);
    expect(screen.getByText("更改 (2)")).toBeTruthy();
    expect(screen.getByText("暂存的更改 (1)")).toBeTruthy();
  });

  it("per-row stage icon stages a single file", () => {
    render(<ChangesSection projectPath="/p" />);
    fireEvent.click(screen.getByTestId("stage-a.txt"));
    expect(gitState.stage).toHaveBeenCalledWith("/p", ["a.txt"]);
  });

  it("group unstage button unstages every staged file", () => {
    render(<ChangesSection projectPath="/p" />);
    fireEvent.click(screen.getByTestId("unstage-all"));
    expect(gitState.unstage).toHaveBeenCalledWith("/p", ["c.txt"]);
  });

  it("discard goes through the confirm dialog before calling the store", () => {
    render(<ChangesSection projectPath="/p" />);
    fireEvent.click(screen.getByTestId("discard-a.txt"));
    expect(screen.getByText(/丢弃 1 个文件的更改/)).toBeTruthy();
    expect(gitState.discard).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "丢弃" }));
    expect(gitState.discard).toHaveBeenCalledWith("/p", ["a.txt"]);
  });

  it("tree view groups files by directory and directory rows collapse", () => {
    gitState.treeView = true;
    gitState.status = {
      files: [
        { path: "src/app.ts", status: "modified", staged: false },
        { path: "src/lib/util.ts", status: "modified", staged: false },
      ],
    };
    render(<ChangesSection projectPath="/p" />);
    expect(screen.getByTestId("dir-src")).toBeTruthy();
    expect(screen.getByTestId("row-src/app.ts")).toBeTruthy();
    fireEvent.click(screen.getByTestId("dir-src"));
    expect(screen.queryByTestId("row-src/app.ts")).toBeNull();
    expect(screen.queryByTestId("row-src/lib/util.ts")).toBeNull();
    fireEvent.click(screen.getByTestId("dir-src"));
    expect(screen.getByTestId("row-src/app.ts")).toBeTruthy();
  });

  it("row click opens the inline diff (Plan 4 will swap this call site)", () => {
    render(<ChangesSection projectPath="/p" />);
    fireEvent.click(screen.getByTestId("row-a.txt"));
    expect(gitState.viewDiff).toHaveBeenCalledWith("/p", "a.txt", false);
  });
});
