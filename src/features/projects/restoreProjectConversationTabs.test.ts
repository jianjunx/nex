import { beforeEach, describe, expect, it, vi } from "vitest";

const conversationCreate = vi.fn();
const conversationList = vi.fn();
const conversationGetMessages = vi.fn();
const conversationUpdateTitle = vi.fn();
const conversationAppendMessage = vi.fn();
const hydrateEntries = vi.fn();

vi.mock("../../bridge/tauri", () => ({
  conversationCreate: (...args: unknown[]) => conversationCreate(...args),
  conversationList: (...args: unknown[]) => conversationList(...args),
  conversationGetMessages: (...args: unknown[]) => conversationGetMessages(...args),
  conversationUpdateTitle: (...args: unknown[]) => conversationUpdateTitle(...args),
  conversationAppendMessage: (...args: unknown[]) => conversationAppendMessage(...args),
}));

vi.mock("../../stores/project.store", () => ({
  useProjectStore: {
    getState: () => ({ activeProjectId: "proj-a" }),
  },
}));

vi.mock("../../stores/agent.store", () => ({
  useAgentStore: {
    getState: () => ({ hydrateEntries }),
  },
}));

import { useConversationStore } from "../../stores/conversation.store";
import { restoreProjectConversationTabs } from "./restoreProjectConversationTabs";

describe("restoreProjectConversationTabs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useConversationStore.setState({
      conversationsByProject: {},
      tabsByProject: {},
      activeTabByProject: {},
      messagesByConversation: {},
      legacyTabsMigration: null,
      loading: false,
      error: null,
    });
  });

  it("does not overwrite persisted tabs when conversation list fails", async () => {
    useConversationStore.setState({
      tabsByProject: { "proj-a": ["tab-1", "tab-2"] },
      activeTabByProject: { "proj-a": "tab-1" },
    });
    conversationList.mockRejectedValueOnce(new Error("network down"));

    await restoreProjectConversationTabs("proj-a");

    expect(useConversationStore.getState().tabsByProject["proj-a"]).toEqual(["tab-1", "tab-2"]);
    expect(useConversationStore.getState().activeTabByProject["proj-a"]).toBe("tab-1");
    expect(conversationGetMessages).not.toHaveBeenCalled();
    expect(hydrateEntries).not.toHaveBeenCalled();
  });

  it("hydrates agent thread entries from persisted messages", async () => {
    conversationList.mockResolvedValueOnce([
      {
        id: "tab-1",
        project_id: "proj-a",
        title: "Hello",
        agent_type: "cursor",
        status: "idle",
        created_at: 0,
        updated_at: 0,
      },
    ]);
    conversationGetMessages.mockResolvedValueOnce([
      {
        id: "m1",
        conversation_id: "tab-1",
        role: "user",
        content: "Hello",
        tool_summary: null,
        timestamp: 1,
        sequence: 1,
      },
    ]);
    useConversationStore.setState({
      tabsByProject: { "proj-a": ["tab-1"] },
      activeTabByProject: { "proj-a": "tab-1" },
    });

    await restoreProjectConversationTabs("proj-a");

    expect(hydrateEntries).toHaveBeenCalledWith(
      "tab-1",
      [
        expect.objectContaining({
          kind: "user_message",
          text: "Hello",
        }),
      ],
    );
  });
});
