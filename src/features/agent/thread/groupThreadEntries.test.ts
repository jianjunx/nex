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

function edit(id: string, path: string, oldText = "a", newText = "b"): ToolCallEntry {
  return tool({
    id,
    toolKind: "edit",
    title: `Edit ${path}`,
    content: [{ type: "diff", path, oldText, newText }],
  });
}

describe("groupThreadEntries", () => {
  it("collapses adjacent tools including edits into one group", () => {
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
    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({ type: "entry", entry: { id: "u1" } });
    expect(items[1]).toMatchObject({ type: "tool_group" });
    if (items[1].type === "tool_group") {
      expect(items[1].entries.map((e) => e.id)).toEqual(["t1", "t2", "t3", "t4", "t5"]);
    }
    expect(items[2]).toMatchObject({ type: "entry", entry: { id: "a1" } });
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

  it("tool_group key 在成员流式追加时保持不变", () => {
    const two: ThreadEntry[] = [
      tool({ id: "t1", toolKind: "search", title: "grep" }),
      tool({ id: "t2", toolKind: "read", title: "Read File" }),
    ];
    const three: ThreadEntry[] = [...two, tool({ id: "t3", toolKind: "read", title: "Read File" })];

    const items2 = groupThreadEntries(two);
    const items3 = groupThreadEntries(three);
    expect(items2[0]?.type).toBe("tool_group");
    expect(items3[0]?.type).toBe("tool_group");
    if (items2[0].type === "tool_group" && items3[0].type === "tool_group") {
      expect(items3[0].key).toBe(items2[0].key);
    }
  });

  it("appends a files_changed card after a completed turn with edits", () => {
    const entries: ThreadEntry[] = [
      { id: "u1", kind: "user_message", text: "fix", timestamp: 1 },
      edit("e1", "src/IconBar.tsx", "aaa", "bbb"),
      edit("e2", "src/SettingsDialog.tsx", "x", "yy"),
      { id: "a1", kind: "assistant_message", chunks: [{ type: "message", text: "done" }], timestamp: 2 },
    ];

    const items = groupThreadEntries(entries, { lastTurnComplete: true });
    expect(items.map((i) => i.type)).toEqual(["entry", "tool_group", "entry", "files_changed"]);
    const card = items[3];
    expect(card.type).toBe("files_changed");
    if (card.type === "files_changed") {
      expect(card.files.map((f) => f.path)).toEqual([
        "src/IconBar.tsx",
        "src/SettingsDialog.tsx",
      ]);
    }
  });

  it("does not show files_changed for the in-flight last turn", () => {
    const entries: ThreadEntry[] = [
      { id: "u1", kind: "user_message", text: "fix", timestamp: 1 },
      edit("e1", "src/a.ts"),
    ];
    const items = groupThreadEntries(entries, { lastTurnComplete: false });
    expect(items.map((i) => i.type)).toEqual(["entry", "tool_group"]);
  });

  it("still summarizes a previous turn while the next turn is running", () => {
    const entries: ThreadEntry[] = [
      { id: "u1", kind: "user_message", text: "one", timestamp: 1 },
      edit("e1", "src/a.ts"),
      { id: "a1", kind: "assistant_message", chunks: [{ type: "message", text: "ok" }], timestamp: 2 },
      { id: "u2", kind: "user_message", text: "two", timestamp: 3 },
      tool({ id: "t1", toolKind: "read", title: "Read" }),
    ];
    const items = groupThreadEntries(entries, { lastTurnComplete: false });
    const types = items.map((i) => i.type);
    expect(types).toEqual(["entry", "tool_group", "entry", "files_changed", "entry", "tool_group"]);
  });

  it("aggregates multiple edits of the same file", () => {
    const entries: ThreadEntry[] = [
      { id: "u1", kind: "user_message", text: "fix", timestamp: 1 },
      edit("e1", "src/a.ts", "a", "b"),
      edit("e2", "src/a.ts", "b", "c"),
    ];
    const items = groupThreadEntries(entries, { lastTurnComplete: true });
    const card = items.find((i) => i.type === "files_changed");
    expect(card?.type).toBe("files_changed");
    if (card?.type === "files_changed") {
      expect(card.files).toHaveLength(1);
      expect(card.files[0].path).toBe("src/a.ts");
    }
  });
});
