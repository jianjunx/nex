import { beforeEach, describe, expect, it, vi } from "vitest";

const conversationCreate = vi.fn();
const conversationList = vi.fn();
const conversationGetMessages = vi.fn();

vi.mock("../../bridge/tauri", () => ({
  conversationCreate: (...args: unknown[]) => conversationCreate(...args),
  conversationList: (...args: unknown[]) => conversationList(...args),
  conversationGetMessages: (...args: unknown[]) => conversationGetMessages(...args),
}));

vi.mock("../../stores/project.store", () => ({
  useProjectStore: {
    getState: () => ({ activeProjectId: "proj-a" }),
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
  });
});
