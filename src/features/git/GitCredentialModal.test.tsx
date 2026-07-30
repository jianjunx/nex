/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const gitCredentialRespond = vi.fn();
vi.mock("../../bridge/tauri", () => ({
  gitCredentialRespond: (...a: unknown[]) => gitCredentialRespond(...a),
  onGitCredentialRequest: () => Promise.resolve(() => {}),
}));
vi.mock("../../stores/git.store", () => ({
  useGitStore: { getState: () => ({ appendLog: vi.fn() }) },
}));

import { GitCredentialModal } from "./GitCredentialModal";
import { useGitCredentialStore } from "./credentialRequest.store";

beforeEach(() => {
  vi.clearAllMocks();
  gitCredentialRespond.mockResolvedValue(undefined);
  useGitCredentialStore.setState({ queue: [] });
});
afterEach(() => {
  cleanup();
});

const REQ = {
  requestId: "r1",
  url: "https://github.com/owner/repo.git",
  usernameHint: "octocat",
  kind: "https" as const,
};

describe("GitCredentialModal", () => {
  it("shows the host and prefills the username hint", () => {
    useGitCredentialStore.setState({ queue: [REQ] });
    render(<GitCredentialModal />);
    expect(screen.getByText(/github\.com/)).toBeTruthy();
    expect((screen.getByLabelText("用户名") as HTMLInputElement).value).toBe("octocat");
  });

  it("submit sends credentials without remember and clears the queue", async () => {
    useGitCredentialStore.setState({ queue: [REQ] });
    render(<GitCredentialModal />);
    fireEvent.change(screen.getByLabelText("密码 / 访问令牌"), { target: { value: "tok" } });
    fireEvent.click(screen.getByRole("button", { name: "确定" }));
    await waitFor(() =>
      expect(gitCredentialRespond).toHaveBeenCalledWith("r1", "octocat", "tok", false),
    );
    await waitFor(() => expect(useGitCredentialStore.getState().queue).toHaveLength(0));
  });

  it("remember toggle propagates to the backend", async () => {
    useGitCredentialStore.setState({ queue: [REQ] });
    render(<GitCredentialModal />);
    fireEvent.change(screen.getByLabelText("密码 / 访问令牌"), { target: { value: "tok" } });
    fireEvent.click(screen.getByLabelText(/本次会话记住/));
    fireEvent.click(screen.getByRole("button", { name: "确定" }));
    await waitFor(() =>
      expect(gitCredentialRespond).toHaveBeenCalledWith("r1", "octocat", "tok", true),
    );
  });

  it("cancel responds with nulls and clears the queue", async () => {
    useGitCredentialStore.setState({ queue: [REQ] });
    render(<GitCredentialModal />);
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    await waitFor(() =>
      expect(gitCredentialRespond).toHaveBeenCalledWith("r1", null, null, false),
    );
    await waitFor(() => expect(useGitCredentialStore.getState().queue).toHaveLength(0));
  });

  it("ssh-passphrase kind hides the username field and relabels the secret", () => {
    useGitCredentialStore.setState({ queue: [{ ...REQ, kind: "ssh-passphrase" }] });
    render(<GitCredentialModal />);
    expect(screen.queryByLabelText("用户名")).toBeNull();
    expect(screen.getByLabelText("密钥口令")).toBeTruthy();
  });

  it("renders nothing when the queue is empty", () => {
    render(<GitCredentialModal />);
    expect(screen.queryByText("Git 认证")).toBeNull();
  });
});
