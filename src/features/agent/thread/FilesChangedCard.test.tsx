/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("../../../bridge/tauri", () => ({
  gitStage: vi.fn(),
  gitCommit: vi.fn(),
  gitStatus: vi.fn(),
  gitUnstage: vi.fn(),
  gitLog: vi.fn(),
  agentSendPrompt: vi.fn().mockResolvedValue({ hadMutations: false }),
  agentCreateSession: vi.fn(),
  agentCancel: vi.fn(),
  conversationReplaceThreadEntries: vi.fn(),
  nativeAgentGetConfig: vi.fn().mockResolvedValue({
    providers: [],
    agent: { maxSteps: 0, contextWindow: 0, bashTimeoutSecs: 120, maxSubagentConcurrency: 6, autoReview: false },
  }),
  onAgentNotification: () => Promise.resolve(() => {}),
  onAgentPermissionRequest: () => Promise.resolve(() => {}),
  onAgentPlanApprovalRequest: () => Promise.resolve(() => {}),
  onAgentAskQuestionRequest: () => Promise.resolve(() => {}),
  onAgentSessionTerminated: () => Promise.resolve(() => {}),
}));

const openPathToken = vi.fn().mockResolvedValue(true);
vi.mock("./pathToken", () => ({
  openPathToken: (...args: unknown[]) => openPathToken(...args),
}));

import { FilesChangedCard } from "./FilesChangedCard";
import { useProjectStore } from "../../../stores/project.store";
import { useConversationStore } from "../../../stores/conversation.store";
import { useAgentStore } from "../../../stores/agent.store";

const FILES = [
  { path: "/repo/src/a.ts", additions: 1, deletions: 0 },
  { path: "/repo/src/b.ts", additions: 0, deletions: 1 },
];

beforeEach(() => {
  useProjectStore.setState({
    activeProjectId: "p1",
    projects: [{ id: "p1", name: "repo", path: "/repo", created_at: 0, last_opened: 0 }],
  });
  useConversationStore.setState({
    activeTabByProject: { p1: "c1" },
    tabsByProject: { p1: ["c1"] },
  });
  useAgentStore.setState({
    sessions: {
      c1: { sessionId: "sid-1", conversationId: "c1", status: "idle" },
    },
  });
});

afterEach(() => {
  cleanup();
  openPathToken.mockClear();
});

describe("FilesChangedCard", () => {
  it("renders file names, counts, and opens a file on row click", () => {
    render(<FilesChangedCard files={FILES} />);
    expect(screen.getByText("修改了 2 个文件")).toBeTruthy();
    expect(screen.getByText("a.ts")).toBeTruthy();
    expect(screen.getByText("b.ts")).toBeTruthy();
    expect(screen.getByText("+1")).toBeTruthy();
    expect(screen.getByText("−1")).toBeTruthy();

    fireEvent.click(screen.getByText("a.ts"));
    expect(openPathToken).toHaveBeenCalledWith("/repo/src/a.ts");
  });

  it("header actions are Commit & Push, Review, then 查看", () => {
    render(<FilesChangedCard files={FILES} />);
    const actions = screen.getAllByRole("button", { name: /Commit & Push|Review|查看/ });
    expect(actions.map((b) => b.textContent)).toEqual(["Commit & Push", "Review", "查看"]);
  });

  it("查看 opens every file then focuses the first", async () => {
    render(<FilesChangedCard files={FILES} />);
    fireEvent.click(screen.getByText("查看"));
    await vi.waitFor(() => {
      expect(openPathToken).toHaveBeenCalledTimes(3);
    });
    expect(openPathToken.mock.calls.map((c) => c[0])).toEqual([
      "/repo/src/a.ts",
      "/repo/src/b.ts",
      "/repo/src/a.ts",
    ]);
  });

  it("Commit & Push sends the command without file paths on the current session", () => {
    const appendUserMessage = vi.fn();
    const sendPrompt = vi.fn().mockResolvedValue(undefined);
    useAgentStore.setState({ appendUserMessage, sendPrompt });

    render(<FilesChangedCard files={FILES} />);
    fireEvent.click(screen.getByText("Commit & Push"));
    expect(appendUserMessage).toHaveBeenCalledWith("c1", "Commit & Push");
    expect(sendPrompt).toHaveBeenCalledWith("sid-1", [{ type: "text", text: "Commit & Push" }]);
  });

  it("Review sends /review with file paths on the current session", () => {
    const appendUserMessage = vi.fn();
    const sendPrompt = vi.fn().mockResolvedValue(undefined);
    useAgentStore.setState({ appendUserMessage, sendPrompt });

    render(<FilesChangedCard files={FILES} />);
    fireEvent.click(screen.getByText("Review"));
    expect(appendUserMessage).toHaveBeenCalledWith("c1", "/review src/a.ts src/b.ts");
    expect(sendPrompt).toHaveBeenCalledWith("sid-1", [{ type: "text", text: "/review src/a.ts src/b.ts" }]);
  });

  it("Commit & Push and Review are disabled while the session is running", () => {
    useAgentStore.setState({
      sessions: { c1: { sessionId: "sid-1", conversationId: "c1", status: "running" } },
    });
    render(<FilesChangedCard files={FILES} />);
    expect((screen.getByText("Commit & Push") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByText("Review") as HTMLButtonElement).disabled).toBe(true);
  });
});
