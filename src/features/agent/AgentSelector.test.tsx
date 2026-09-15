// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AgentSelector } from "./AgentSelector";
import { useAgentStore } from "@/stores/agent.store";
import { useConversationStore } from "@/stores/conversation.store";
import { conversationUpdateAgent } from "@/bridge/tauri";
vi.mock("@/bridge/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/bridge/tauri")>()),
  conversationUpdateAgent: vi.fn().mockResolvedValue(undefined),
}));
beforeEach(() => {
  vi.clearAllMocks();
  useAgentStore.setState({
    sessions: {},
    entriesByConversation: {},
    pendingMessagesByConversation: {},
    servers: [
      {
        id: "other",
        name: "Other",
        kind: "registry",
        version: "1",
        description: "",
        icon: null,
      },
    ],
    removeSession: vi.fn().mockResolvedValue(undefined),
  });
  useConversationStore.setState({
    messagesByConversation: {},
    conversationsByProject: {
      p: [
        {
          id: "c",
          project_id: "p",
          agent_type: "nex",
          title: "New",
          status: "active",
          created_at: 0,
          updated_at: 0,
        },
      ],
    },
  });
});
afterEach(cleanup);
it("allows selecting an agent for an empty conversation and persists it", async () => {
  render(
    <AgentSelector
      conversationId="c"
      agentType="nex"
      onBusyChange={() => {}}
    />,
  );
  fireEvent.change(screen.getByRole("combobox", { name: "智能体" }), {
    target: { value: "other" },
  });
  await waitFor(() =>
    expect(
      useConversationStore.getState().conversationsByProject.p[0].agent_type,
    ).toBe("other"),
  );
  expect(conversationUpdateAgent).toHaveBeenCalledWith("c", "other");
});
it("locks selection as soon as a user message exists", () => {
  useAgentStore.setState({
    entriesByConversation: {
      c: [{ id: "m", kind: "user_message", text: "hello", timestamp: 1 }],
    },
  });
  render(
    <AgentSelector
      conversationId="c"
      agentType="nex"
      onBusyChange={() => {}}
    />,
  );
  expect((screen.getByRole("combobox") as HTMLSelectElement).disabled).toBe(
    true,
  );
});
it("locks selection for persisted messages or queued prompts", () => {
  useConversationStore.setState({
    messagesByConversation: {
      c: [
        {
          id: "m",
          conversation_id: "c",
          role: "user",
          content: "hi",
          tool_summary: null,
          timestamp: 1,
          sequence: 1,
        },
      ],
    },
  });
  render(
    <AgentSelector
      conversationId="c"
      agentType="nex"
      onBusyChange={() => {}}
    />,
  );
  expect((screen.getByRole("combobox") as HTMLSelectElement).disabled).toBe(
    true,
  );
});
