import { describe, expect, it } from "vitest";
import { groupThreadEntries } from "./groupThreadEntries";
import type { ThreadEntry, ToolCallEntry } from "./types";

function tool(partial: Partial<ToolCallEntry> & Pick<ToolCallEntry, "id" | "toolKind" | "title">): ToolCallEntry {
  return {
    kind: "tool_call",
    toolCallId: partial.id,
    status: "completed",
    content: [],
    timestamp: 0,
    ...partial,
  };
}

describe("groupThreadEntries", () => {
  it("collapses adjacent non-edit tools and leaves edit tools standalone", () => {
    const entries: ThreadEntry[] = [
      { id: "u1", kind: "user_message", text: "hi", timestamp: 1 },
      tool({ id: "t1", toolKind: "search", title: "grep" }),
      tool({ id: "t2", toolKind: "read", title: "Read File" }),
      tool({ id: "t3", toolKind: "read", title: "Read File" }),
      tool({ id: "t4", toolKind: "edit", title: "Edit File" }),
      tool({ id: "t5", toolKind: "read", title: "Read File" }),
      { id: "a1", kind: "assistant_message", chunks: [{ type: "message", text: "done" }], timestamp: 2 },
    ];

    const items = groupThreadEntries(entries);
    expect(items).toHaveLength(5);
    expect(items[0]).toMatchObject({ type: "entry", entry: { id: "u1" } });
    expect(items[1]).toMatchObject({ type: "tool_group" });
    if (items[1].type === "tool_group") {
      expect(items[1].entries.map((e) => e.id)).toEqual(["t1", "t2", "t3"]);
    }
    expect(items[2]).toMatchObject({ type: "entry", entry: { id: "t4", toolKind: "edit" } });
    expect(items[3]).toMatchObject({ type: "tool_group" });
    if (items[3].type === "tool_group") {
      expect(items[3].entries.map((e) => e.id)).toEqual(["t5"]);
    }
    expect(items[4]).toMatchObject({ type: "entry", entry: { id: "a1" } });
  });

  it("keeps permission-waiting tools standalone so questions stay visible", () => {
    const entries: ThreadEntry[] = [
      tool({ id: "t1", toolKind: "search", title: "grep" }),
      tool({
        id: "t2",
        toolKind: "other",
        title: "AskUserQuestion",
        status: "waiting_for_confirmation",
      }),
      tool({ id: "t3", toolKind: "read", title: "Read File" }),
    ];

    const items = groupThreadEntries(entries);
    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({ type: "tool_group" });
    expect(items[1]).toMatchObject({
      type: "entry",
      entry: { id: "t2", status: "waiting_for_confirmation" },
    });
    expect(items[2]).toMatchObject({ type: "tool_group" });
  });
});
