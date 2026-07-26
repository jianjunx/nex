import { beforeEach, describe, expect, it, vi } from "vitest";

const conversationCreate = vi.fn();
const conversationList = vi.fn();
const conversationGetMessages = vi.fn();

vi.mock("../bridge/tauri", () => ({
  conversationCreate: (...args: unknown[]) => conversationCreate(...args),
  conversationList: (...args: unknown[]) => conversationList(...args),
  conversationGetMessages: (...args: unknown[]) => conversationGetMessages(...args),
}));

vi.mock("./project.store", () => ({
  useProjectStore: {
    getState: () => ({ activeProjectId: mockActiveProjectId }),
  },
}));

let mockActiveProjectId: string | null = "proj-a";

import {
  migrateConversationPersist,
  selectProjectActiveTabId,
  selectProjectOpenTabs,
  useConversationStore,
} from "./conversation.store";

describe("conversation.store project-scoped tabs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockActiveProjectId = "proj-a";
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

  it("selectProjectOpenTabs returns a stable empty array reference", () => {
    const s = useConversationStore.getState();
    expect(selectProjectOpenTabs(s, null)).toBe(selectProjectOpenTabs(s, undefined));
    expect(selectProjectOpenTabs(s, "missing")).toBe(selectProjectOpenTabs(s, "also-missing"));
    expect(selectProjectOpenTabs(s, "missing")).toEqual([]);
  });

  it("createConversation writes tabs for that project only", async () => {
    conversationCreate.mockResolvedValueOnce({
      id: "c1",
      project_id: "proj-a",
      title: "t",
      agent_type: "x",
      status: "idle",
      created_at: 0,
      updated_at: 0,
    });
    await useConversationStore.getState().createConversation("proj-a", "x");
    expect(selectProjectOpenTabs(useConversationStore.getState(), "proj-a")).toEqual(["c1"]);
    expect(selectProjectActiveTabId(useConversationStore.getState(), "proj-a")).toBe("c1");
    expect(selectProjectOpenTabs(useConversationStore.getState(), "proj-b")).toEqual([]);
  });

  it("switchTab and closeTab only touch active project slot", () => {
    useConversationStore.setState({
      tabsByProject: {
        "proj-a": ["a1", "a2"],
        "proj-b": ["b1"],
      },
      activeTabByProject: { "proj-a": "a1", "proj-b": "b1" },
    });
    mockActiveProjectId = "proj-a";
    useConversationStore.getState().switchTab("a2");
    expect(useConversationStore.getState().activeTabByProject["proj-a"]).toBe("a2");
    expect(useConversationStore.getState().activeTabByProject["proj-b"]).toBe("b1");

    useConversationStore.getState().closeTab("a2");
    expect(useConversationStore.getState().tabsByProject["proj-a"]).toEqual(["a1"]);
    expect(useConversationStore.getState().activeTabByProject["proj-a"]).toBe("a1");
    expect(useConversationStore.getState().tabsByProject["proj-b"]).toEqual(["b1"]);
  });

  it("restoreTabs validates ids for a specific project", () => {
    useConversationStore.getState().restoreTabs(
      "proj-a",
      ["gone", "keep"],
      "gone",
      new Set(["keep"]),
    );
    expect(useConversationStore.getState().tabsByProject["proj-a"]).toEqual(["keep"]);
    expect(useConversationStore.getState().activeTabByProject["proj-a"]).toBe("keep");
  });

  it("loadConversations returns null on list failure", async () => {
    conversationList.mockRejectedValueOnce(new Error("list failed"));
    const result = await useConversationStore.getState().loadConversations("proj-a");
    expect(result).toBeNull();
    expect(useConversationStore.getState().error).toBe("list failed");
  });

  it("migrateConversationPersist v0 maps openTabs into legacyTabsMigration", () => {
    const next = migrateConversationPersist(
      { openTabs: ["x"], activeTabId: "x" },
      0,
    );
    expect(next.tabsByProject).toEqual({});
    expect(next.activeTabByProject).toEqual({});
    expect(next.legacyTabsMigration).toEqual({ tabs: ["x"], activeId: "x" });
  });
});
