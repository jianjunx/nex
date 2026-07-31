/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

let gitState: {
  commitMessage: string;
  opRunning: string | null;
  setCommitMessage: ReturnType<typeof vi.fn>;
  commitWith: ReturnType<typeof vi.fn>;
};
vi.mock("../../stores/git.store", () => ({
  useGitStore: (selector?: (s: typeof gitState) => unknown) => (selector ? selector(gitState) : gitState),
}));

import { CommitSection } from "./CommitSection";

beforeEach(() => {
  vi.clearAllMocks();
  gitState = {
    commitMessage: "hello",
    opRunning: null,
    setCommitMessage: vi.fn(),
    commitWith: vi.fn().mockResolvedValue(undefined),
  };
});
afterEach(() => cleanup());

describe("CommitSection", () => {
  it("bare Enter in the commit input commits", () => {
    render(<CommitSection projectPath="/p" />);
    const input = document.querySelector("[data-scm-commit-input]")!;
    fireEvent.keyDown(input, { key: "Enter" });
    expect(gitState.commitWith).toHaveBeenCalledWith("/p", "commit");
  });

  it("Ctrl+Enter is left to the global keybinding (local handler skips it)", () => {
    render(<CommitSection projectPath="/p" />);
    const input = document.querySelector("[data-scm-commit-input]")!;
    fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });
    expect(gitState.commitWith).not.toHaveBeenCalled();
  });

  it("dropdown item 提交并推送 uses push mode", async () => {
    render(<CommitSection projectPath="/p" />);
    fireEvent.pointerDown(screen.getByTitle("更多提交方式"));
    const item = await screen.findByText("提交并推送");
    fireEvent.click(item);
    await waitFor(() => expect(gitState.commitWith).toHaveBeenCalledWith("/p", "push"));
  });

  it("empty message disables the commit button", () => {
    gitState.commitMessage = "   ";
    render(<CommitSection projectPath="/p" />);
    expect((screen.getByRole("button", { name: "提交" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
