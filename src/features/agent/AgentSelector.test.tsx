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
const prewarmSession = vi.fn();
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
    prewarmSession,
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
      projectPath="/proj"
      onBusyChange={() => {}}
    />,
  );
  // radix DropdownMenuTrigger 只以 onPointerDown/onKeyDown 开启
  fireEvent.pointerDown(screen.getByRole("button", { name: "智能体" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Other" }));
  await waitFor(() =>
    expect(
      useConversationStore.getState().conversationsByProject.p[0].agent_type,
    ).toBe("other"),
  );
  expect(conversationUpdateAgent).toHaveBeenCalledWith("c", "other");
  expect(prewarmSession).toHaveBeenCalledWith("c", "other", "/proj");
});
it("keeps the selector usable while the agent is only pre-initializing", () => {
  useAgentStore.setState({
    sessions: { c: { sessionId: "", conversationId: "c", status: "starting" } },
  });
  render(
    <AgentSelector
      conversationId="c"
      agentType="nex"
      projectPath="/proj"
      onBusyChange={() => {}}
    />,
  );
  expect(
    (screen.getByRole("button", { name: "智能体" }) as HTMLButtonElement)
      .disabled,
  ).toBe(false);
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
      projectPath="/proj"
      onBusyChange={() => {}}
    />,
  );
  expect(
    (screen.getByRole("button", { name: "智能体" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
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
      projectPath="/proj"
      onBusyChange={() => {}}
    />,
  );
  expect(
    (screen.getByRole("button", { name: "智能体" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
});

it("uses the canonical agent names and order regardless of registry order", async () => {
  useAgentStore.setState({ servers: [
    { id: "cursor", name: "Cursor CLI", kind: "registry", version: "1", description: "", icon: null },
    { id: "claude-acp", name: "Claude Agent", kind: "registry", version: "1", description: "", icon: null },
    { id: "codex-acp", name: "Codex ACP", kind: "registry", version: "1", description: "", icon: null },
  ] });
  render(<AgentSelector conversationId="c" agentType="nex" projectPath="/proj" onBusyChange={() => {}} />);
  fireEvent.pointerDown(screen.getByRole("button", { name: "智能体" }));
  const items = await screen.findAllByRole("menuitem");
  expect(items.map((item) => item.textContent)).toEqual(["Nex Agent", "Codex", "Claude Code", "Cursor"]);
});
