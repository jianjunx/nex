import { beforeEach, describe, expect, it, vi } from "vitest";

const conversationCreate = vi.fn();
const conversationList = vi.fn();
const conversationGetMessages = vi.fn();
const conversationUpdateTitle = vi.fn();
const conversationDelete = vi.fn();
const conversationAppendMessage = vi.fn();

vi.mock("../bridge/tauri", () => ({
  conversationCreate: (...args: unknown[]) => conversationCreate(...args),
  conversationList: (...args: unknown[]) => conversationList(...args),
  conversationGetMessages: (...args: unknown[]) => conversationGetMessages(...args),
  conversationUpdateTitle: (...args: unknown[]) => conversationUpdateTitle(...args),
  conversationDelete: (...args: unknown[]) => conversationDelete(...args),
  conversationAppendMessage: (...args: unknown[]) => conversationAppendMessage(...args),
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
    // 点击切换不立刻重排；顺序保持原样，等 restoreTabs 再排。
    expect(useConversationStore.getState().tabsByProject["proj-a"]).toEqual(["a1", "a2"]);

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

  it("restoreTabs moves the active tab to the front", () => {
    useConversationStore.getState().restoreTabs(
      "proj-a",
      ["a1", "a2", "a3"],
      "a3",
      new Set(["a1", "a2", "a3"]),
    );
    expect(useConversationStore.getState().tabsByProject["proj-a"]).toEqual([
      "a3",
      "a1",
      "a2",
    ]);
    expect(useConversationStore.getState().activeTabByProject["proj-a"]).toBe("a3");
  });

  it("removeConversation 删除 SQLite 记录并清掉本地会话索引", async () => {
    conversationDelete.mockResolvedValue(undefined);
    useConversationStore.setState({
      conversationsByProject: {
        "proj-a": [
          { id: "c1", project_id: "proj-a", title: "one", agent_type: "x", status: "idle", created_at: 0, updated_at: 0 },
          { id: "c2", project_id: "proj-a", title: "two", agent_type: "x", status: "idle", created_at: 0, updated_at: 0 },
        ],
      },
      tabsByProject: { "proj-a": ["c1", "c2"] },
      activeTabByProject: { "proj-a": "c1" },
      messagesByConversation: {
        c1: [{ id: "m1", conversation_id: "c1", role: "user", content: "hi", tool_summary: null, timestamp: 1, sequence: 1 }],
        c2: [{ id: "m2", conversation_id: "c2", role: "user", content: "yo", tool_summary: null, timestamp: 1, sequence: 1 }],
      },
    });

    await useConversationStore.getState().removeConversation("c1");

    expect(conversationDelete).toHaveBeenCalledWith("c1");
    expect(useConversationStore.getState().conversationsByProject["proj-a"].map((c) => c.id)).toEqual(["c2"]);
    expect(useConversationStore.getState().tabsByProject["proj-a"]).toEqual(["c2"]);
    expect(useConversationStore.getState().activeTabByProject["proj-a"]).toBe("c2");
    expect(useConversationStore.getState().messagesByConversation["c1"]).toBeUndefined();
    expect(useConversationStore.getState().messagesByConversation["c2"]).toHaveLength(1);
  });

  it("removeConversation 不吞掉后端删除失败", async () => {
    conversationDelete.mockRejectedValueOnce(new Error("delete failed"));
    await expect(useConversationStore.getState().removeConversation("c1")).rejects.toThrow("delete failed");
  });

  it("loadConversations returns null on list failure", async () => {
    conversationList.mockRejectedValueOnce(new Error("list failed"));
    const result = await useConversationStore.getState().loadConversations("proj-a");
    expect(result).toBeNull();
    expect(useConversationStore.getState().error).toBe("list failed");
  });

  it("autoTitleFromFirstMessage renames only default New Chat titles", async () => {
    conversationUpdateTitle.mockResolvedValue(undefined);
    useConversationStore.setState({
      conversationsByProject: {
        "proj-a": [
          {
            id: "c1",
            project_id: "proj-a",
            title: "New Chat",
            agent_type: "x",
            status: "idle",
            created_at: 0,
            updated_at: 0,
          },
          {
            id: "c2",
            project_id: "proj-a",
            title: "Already named",
            agent_type: "x",
            status: "idle",
            created_at: 0,
            updated_at: 0,
          },
        ],
      },
    });

    useConversationStore.getState().autoTitleFromFirstMessage("c1", "Fix the login bug please");
    await vi.waitFor(() => {
      expect(conversationUpdateTitle).toHaveBeenCalledWith("c1", "Fix the login bug please");
    });
    expect(useConversationStore.getState().conversationsByProject["proj-a"][0].title).toBe(
      "Fix the login bug please",
    );

    conversationUpdateTitle.mockClear();
    useConversationStore.getState().autoTitleFromFirstMessage("c2", "Should not rename");
    await Promise.resolve();
    expect(conversationUpdateTitle).not.toHaveBeenCalled();
    expect(useConversationStore.getState().conversationsByProject["proj-a"][1].title).toBe(
      "Already named",
    );
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

  it("loadMessages 分页取完全部历史(修复 50 条截断)", async () => {
    const mk = (i: number) =>
      ({ id: `m${i}`, conversationId: "c1", role: "user", content: `msg ${i}`, createdAt: i }) as never;
    conversationGetMessages.mockImplementation(async (_id: string, _limit: number, offset: number) => {
      if (offset < 100) return Array.from({ length: 50 }, (_, i) => mk(offset + i));
      return Array.from({ length: 20 }, (_, i) => mk(offset + i));
    });

    await useConversationStore.getState().loadMessages("c1");

    expect(conversationGetMessages).toHaveBeenCalledTimes(3);
    expect(conversationGetMessages.mock.calls.map((c) => c[2])).toEqual([0, 50, 100]);
    expect(useConversationStore.getState().messagesByConversation["c1"]).toHaveLength(120);
  });

  it("loadMessages 单页不足一页即停止分页", async () => {
    const mk = (i: number) =>
      ({ id: `m${i}`, conversationId: "c1", role: "user", content: `msg ${i}`, createdAt: i }) as never;
    conversationGetMessages.mockImplementation(async () => Array.from({ length: 30 }, (_, i) => mk(i)));

    await useConversationStore.getState().loadMessages("c1");

    expect(conversationGetMessages).toHaveBeenCalledTimes(1);
    expect(conversationGetMessages.mock.calls.map((c) => c[2])).toEqual([0]);
    expect(useConversationStore.getState().messagesByConversation["c1"]).toHaveLength(30);
  });

  it("loadMessages 空会话只取一页并写入空数组", async () => {
    conversationGetMessages.mockImplementation(async () => []);

    await useConversationStore.getState().loadMessages("c1");

    expect(conversationGetMessages).toHaveBeenCalledTimes(1);
    expect(conversationGetMessages.mock.calls.map((c) => c[2])).toEqual([0]);
    expect(useConversationStore.getState().messagesByConversation["c1"]).toEqual([]);
  });

  it("并行 loadMessages 不同会话互不取消(修复全局 generation 误杀)", async () => {
    conversationGetMessages.mockImplementation(async (id: string) => [
      { id: `${id}-m1`, conversation_id: id, role: "user", content: id, timestamp: 1, sequence: 1 },
    ]);

    const [r1, r2] = await Promise.all([
      useConversationStore.getState().loadMessages("c1"),
      useConversationStore.getState().loadMessages("c2"),
    ]);

    expect(r1).toHaveLength(1);
    expect(r2).toHaveLength(1);
    expect(useConversationStore.getState().messagesByConversation["c1"]).toHaveLength(1);
    expect(useConversationStore.getState().messagesByConversation["c2"]).toHaveLength(1);
  });

  it("loadMessages 失败返回 null 且不写入消息", async () => {
    conversationGetMessages.mockRejectedValueOnce(new Error("db down"));

    const result = await useConversationStore.getState().loadMessages("c1");

    expect(result).toBeNull();
    expect(useConversationStore.getState().messagesByConversation["c1"]).toBeUndefined();
    expect(useConversationStore.getState().error).toBe("db down");
  });
});
