import { describe, expect, it } from "vitest";
import {
  applyPermissionRequestToEntries,
  applySessionUpdate,
  emptySessionMeta,
} from "./applySessionUpdate";
import type { ThreadEntry } from "./types";

describe("applySessionUpdate", () => {
  it("accumulates assistant message and thought chunks", () => {
    const entries: ThreadEntry[] = [];
    const meta = emptySessionMeta();
    applySessionUpdate(entries, meta, {
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "think" },
    });
    applySessionUpdate(entries, meta, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "hello" },
    });
    applySessionUpdate(entries, meta, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: " world" },
    });
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe("assistant_message");
    if (entries[0].kind === "assistant_message") {
      expect(entries[0].chunks).toEqual([
        { type: "thought", text: "think" },
        { type: "message", text: "hello world" },
      ]);
    }
  });

  it("upserts tool calls and updates plan", () => {
    const entries: ThreadEntry[] = [];
    const meta = emptySessionMeta();
    applySessionUpdate(entries, meta, {
      sessionUpdate: "tool_call",
      toolCallId: "t1",
      title: "Read file",
      kind: "read",
      status: "pending",
    });
    applySessionUpdate(entries, meta, {
      sessionUpdate: "tool_call_update",
      toolCallId: "t1",
      status: "completed",
      content: [{ type: "content", content: { type: "text", text: "ok" } }],
    });
    expect(entries).toHaveLength(1);
    if (entries[0].kind === "tool_call") {
      expect(entries[0].status).toBe("completed");
      expect(entries[0].content[0]).toEqual({ type: "text", text: "ok" });
    }
    const r = applySessionUpdate(entries, meta, {
      sessionUpdate: "plan",
      entries: [{ content: "step", priority: "high", status: "in_progress" }],
    });
    expect(meta.plan).toHaveLength(1);
    expect(r.completedPlanSnapshot).toBeNull();
  });

  it("snapshots completed plans", () => {
    const entries: ThreadEntry[] = [];
    const meta = emptySessionMeta();
    const r = applySessionUpdate(entries, meta, {
      sessionUpdate: "plan",
      entries: [{ content: "done", priority: "low", status: "completed" }],
    });
    expect(r.completedPlanSnapshot).toHaveLength(1);
    expect(meta.plan).toBeNull();
  });

  it("updates plan progress from Cursor-style synthetic plan notifications", () => {
    const entries: ThreadEntry[] = [];
    const meta = emptySessionMeta();
    applySessionUpdate(entries, meta, {
      sessionUpdate: "plan",
      entries: [
        { content: "Inspect", priority: "medium", status: "completed" },
        { content: "Edit", priority: "medium", status: "in_progress" },
        { content: "Verify", priority: "medium", status: "pending" },
      ],
    });
    expect(meta.plan?.map((p) => p.status)).toEqual(["completed", "in_progress", "pending"]);
    applySessionUpdate(entries, meta, {
      sessionUpdate: "plan",
      entries: [
        { content: "Inspect", priority: "medium", status: "completed" },
        { content: "Edit", priority: "medium", status: "completed" },
        { content: "Verify", priority: "medium", status: "completed" },
      ],
    });
    expect(meta.plan).toBeNull();
  });

  it("records context usage from session_info_update", () => {
    const entries: ThreadEntry[] = [];
    const meta = emptySessionMeta();
    const r = applySessionUpdate(entries, meta, {
      sessionUpdate: "session_info_update",
      usage: {
        size: { used: 42000, total: 200000 },
        tokens: [
          { type: "input", value: 40000 },
          { type: "output", value: 2000 },
        ],
      },
    });
    expect(r.metaChanged).toBe(true);
    expect(meta.contextUsage).toEqual({
      used: 42000,
      total: 200000,
      tokens: [
        { type: "input", name: undefined, value: 40000 },
        { type: "output", name: undefined, value: 2000 },
      ],
    });

    // 只有 tokens 无 size：used 退化为 tokens 之和。
    const r2 = applySessionUpdate(entries, meta, {
      sessionUpdate: "session_info_update",
      usage: { tokens: [{ type: "input", value: 100 }] },
    });
    expect(r2.metaChanged).toBe(true);
    expect(meta.contextUsage?.used).toBe(100);
    expect(meta.contextUsage?.total).toBe(0);
  });

  it("ignores session_info_update without usage", () => {
    const entries: ThreadEntry[] = [];
    const meta = emptySessionMeta();
    const r = applySessionUpdate(entries, meta, {
      sessionUpdate: "session_info_update",
      title: "Some title",
    });
    expect(r.metaChanged).toBe(false);
    expect(meta.contextUsage).toBeNull();
  });

  it("creates a waiting tool card from permission payload when none exists", () => {
    const entries: ThreadEntry[] = [];
    const attached = applyPermissionRequestToEntries(entries, {
      requestId: "req-1",
      toolCallId: "ask-1",
      toolTitle: "Which approach?",
      toolKind: "other",
      toolContent: [{ type: "content", content: { type: "text", text: "Pick A or B" } }],
      toolRawInput: { questions: [{ question: "Pick one" }] },
      options: [
        { optionId: "a", label: "Option A" },
        { optionId: "b", label: "Option B" },
      ],
    });
    expect(attached).toBe(true);
    expect(entries).toHaveLength(1);
    if (entries[0].kind === "tool_call") {
      expect(entries[0].status).toBe("waiting_for_confirmation");
      expect(entries[0].title).toBe("Which approach?");
      expect(entries[0].content[0]).toEqual({ type: "text", text: "Pick A or B" });
      expect(entries[0].options?.map((o) => o.optionId)).toEqual(["a", "b"]);
      expect(entries[0].permissionRequestId).toBe("req-1");
    }
  });

  it("starts a new assistant bubble after a later user message (does not prepend above it)", () => {
    const entries: ThreadEntry[] = [
      {
        id: "u1",
        kind: "user_message",
        text: "first",
        timestamp: 1,
      },
      {
        id: "a1",
        kind: "assistant_message",
        timestamp: 2,
        chunks: [{ type: "message", text: "reply-1" }],
      },
      {
        id: "u2",
        kind: "user_message",
        text: "second",
        timestamp: 3,
      },
    ];
    const meta = emptySessionMeta();
    applySessionUpdate(entries, meta, {
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "thinking-2" },
    });
    applySessionUpdate(entries, meta, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "reply-2" },
    });

    expect(entries.map((e) => e.kind)).toEqual([
      "user_message",
      "assistant_message",
      "user_message",
      "assistant_message",
    ]);
    if (entries[1].kind === "assistant_message") {
      expect(entries[1].chunks).toEqual([{ type: "message", text: "reply-1" }]);
    }
    if (entries[3].kind === "assistant_message") {
      expect(entries[3].chunks).toEqual([
        { type: "thought", text: "thinking-2" },
        { type: "message", text: "reply-2" },
      ]);
    }
  });

  it("starts a new assistant bubble after tool calls (completion appears below tools)", () => {
    const entries: ThreadEntry[] = [];
    const meta = emptySessionMeta();
    applySessionUpdate(entries, meta, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "先改搜索面板。" },
    });
    applySessionUpdate(entries, meta, {
      sessionUpdate: "tool_call",
      toolCallId: "t1",
      title: "Edit SearchPanel",
      kind: "edit",
      status: "completed",
    });
    applySessionUpdate(entries, meta, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "已按你的要求改完。" },
    });

    expect(entries.map((e) => e.kind)).toEqual([
      "assistant_message",
      "tool_call",
      "assistant_message",
    ]);
    if (entries[0].kind === "assistant_message") {
      expect(entries[0].chunks).toEqual([{ type: "message", text: "先改搜索面板。" }]);
    }
    if (entries[2].kind === "assistant_message") {
      expect(entries[2].chunks).toEqual([{ type: "message", text: "已按你的要求改完。" }]);
    }
  });
});
