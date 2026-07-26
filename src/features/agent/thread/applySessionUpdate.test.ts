import { describe, expect, it } from "vitest";
import { applySessionUpdate, emptySessionMeta } from "./applySessionUpdate";
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
});
