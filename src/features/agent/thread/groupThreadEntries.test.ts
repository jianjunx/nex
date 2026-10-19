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
    expect(items[1]).toMatchObject({ type: "process_group" });
    if (items[1].type === "process_group") {
      expect(items[1].parts.map((p) => p.key)).toEqual(["t1", "t2", "t3", "t4", "t5"]);
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
    expect(items[0]).toMatchObject({ type: "process_group" });
    expect(items[1]).toMatchObject({
      type: "entry",
      entry: { id: "t2", status: "waiting_for_confirmation" },
    });
    expect(items[2]).toMatchObject({ type: "process_group" });
  });

  it("process_group key 在成员流式追加时保持不变", () => {
    const two: ThreadEntry[] = [
      tool({ id: "t1", toolKind: "search", title: "grep" }),
      tool({ id: "t2", toolKind: "read", title: "Read File" }),
    ];
    const three: ThreadEntry[] = [...two, tool({ id: "t3", toolKind: "read", title: "Read File" })];

    const items2 = groupThreadEntries(two);
    const items3 = groupThreadEntries(three);
    expect(items2[0]?.type).toBe("process_group");
    expect(items3[0]?.type).toBe("process_group");
    if (items2[0].type === "process_group" && items3[0].type === "process_group") {
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
    expect(items.map((i) => i.type)).toEqual(["entry", "process_group", "entry", "files_changed"]);
    const card = items[3];
    expect(card.type).toBe("files_changed");
    if (card.type === "files_changed") {
      expect(card.files.map((f) => f.path)).toEqual([
        "src/IconBar.tsx",
        "src/SettingsDialog.tsx",
      ]);
    }
  });

  it("summarizes shell-only changes using the persisted workspace baseline", () => {
    const entries: ThreadEntry[] = [
      { id: "u1", kind: "user_message", text: "fix", timestamp: 1 },
      tool({ id: "shell", toolKind: "execute", title: "python write_text" }),
      { id: "s1", kind: "turn_summary", durationMs: 1, timestamp: 2,
        fileChanges: [{ path: "/repo/a.ts", oldText: "dirty", newText: "fixed" }] },
    ];
    const items = groupThreadEntries(entries);
    expect(items.at(-2)).toMatchObject({
      type: "files_changed",
      files: [{ path: "/repo/a.ts", additions: 1, deletions: 1,
        preview: { oldText: "dirty", newText: "fixed", key: "s1" } }],
    });
    expect(groupThreadEntries(entries, { lastTurnComplete: false }).some((i) => i.type === "files_changed")).toBe(false);
  });

  it("uses the net baseline instead of duplicating tool diffs or showing reverted edits", () => {
    const entries: ThreadEntry[] = [
      edit("e1", "/repo/a.ts"),
      { id: "s1", kind: "turn_summary", durationMs: 1, timestamp: 2, fileChanges: [] },
    ];
    expect(groupThreadEntries(entries).some((i) => i.type === "files_changed")).toBe(false);
  });

  it("does not show files_changed for the in-flight last turn", () => {
    const entries: ThreadEntry[] = [
      { id: "u1", kind: "user_message", text: "fix", timestamp: 1 },
      edit("e1", "src/a.ts"),
    ];
    const items = groupThreadEntries(entries, { lastTurnComplete: false });
    expect(items.map((i) => i.type)).toEqual(["entry", "process_group"]);
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
    expect(types).toEqual(["entry", "process_group", "entry", "files_changed", "entry", "process_group"]);
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

  it("merges reasoning and tool calls across assistant messages into one group", () => {
    const thought = (id: string, text = "想想"): ThreadEntry => ({
      id,
      kind: "assistant_message",
      chunks: [{ type: "thought", text }],
      timestamp: 1,
    });
    const entries: ThreadEntry[] = [
      { id: "u1", kind: "user_message", text: "分析", timestamp: 1 },
      {
        id: "a1",
        kind: "assistant_message",
        chunks: [
          { type: "thought", text: "先看结构" },
          { type: "message", text: "我先从结构入手" },
        ],
        timestamp: 2,
      },
      tool({ id: "t1", toolKind: "read", title: "Read" }),
      thought("a2"),
      tool({ id: "t2", toolKind: "search", title: "grep" }),
      thought("a3"),
      {
        id: "a4",
        kind: "assistant_message",
        chunks: [
          { type: "thought", text: "收尾" },
          { type: "message", text: "结论" },
        ],
        timestamp: 3,
      },
    ];
    const items = groupThreadEntries(entries);
    expect(items.map((i) => i.type)).toEqual([
      "entry", // user
      "process_group", // a1 thought
      "entry", // a1 answer text
      "process_group", // t1, a2, t2, a3, a4 thought
      "entry", // a4 answer text
    ]);
    const group = items[3];
    if (group.type !== "process_group") throw new Error("expected group");
    expect(group.parts.map((p) => p.type)).toEqual([
      "tool",
      "thought",
      "tool",
      "thought",
      "thought",
    ]);
    // Answer text keeps only the message chunk and the original entry id.
    expect(items[2]).toMatchObject({
      type: "entry",
      entry: { id: "a1", chunks: [{ type: "message", text: "我先从结构入手" }] },
    });
  });

  it("returns the same entry object for assistant messages without reasoning", () => {
    const a: ThreadEntry = {
      id: "a1",
      kind: "assistant_message",
      chunks: [{ type: "message", text: "hi" }],
      timestamp: 1,
    };
    const items = groupThreadEntries([a]);
    expect(items[0]).toMatchObject({ type: "entry" });
    if (items[0].type === "entry") expect(items[0].entry).toBe(a);
  });

  it("keeps derived answer entries referentially stable across regroupings", () => {
    const a: ThreadEntry = {
      id: "a1",
      kind: "assistant_message",
      chunks: [
        { type: "thought", text: "t" },
        { type: "message", text: "m" },
      ],
      timestamp: 1,
    };
    const first = groupThreadEntries([a]);
    const second = groupThreadEntries([a]);
    if (first[1].type === "entry" && second[1].type === "entry") {
      expect(second[1].entry).toBe(first[1].entry);
    } else throw new Error("expected entries");
  });

  it("places the turn summary after the files-changed card at the end of the turn", () => {
    const entries: ThreadEntry[] = [
      { id: "u1", kind: "user_message", text: "改一下", timestamp: 1 },
      edit("e1", "/p/a.ts"),
      { id: "a1", kind: "assistant_message", chunks: [{ type: "message", text: "好了" }], timestamp: 2 },
      { id: "s1", kind: "turn_summary", durationMs: 1200, timestamp: 3 },
    ];

    const items = groupThreadEntries(entries);
    expect(items.map((i) => i.type)).toEqual([
      "entry", // user
      "process_group",
      "entry", // assistant
      "files_changed",
      "entry", // summary
    ]);
    const last = items[items.length - 1];
    expect(last).toMatchObject({ type: "entry", entry: { id: "s1", kind: "turn_summary" } });
  });

  it("keeps each turn's summary at the end of its own turn", () => {
    const entries: ThreadEntry[] = [
      { id: "u1", kind: "user_message", text: "一", timestamp: 1 },
      { id: "a1", kind: "assistant_message", chunks: [{ type: "message", text: "答一" }], timestamp: 2 },
      { id: "s1", kind: "turn_summary", durationMs: 1000, timestamp: 3 },
      { id: "u2", kind: "user_message", text: "二", timestamp: 4 },
      { id: "a2", kind: "assistant_message", chunks: [{ type: "message", text: "答二" }], timestamp: 5 },
      { id: "s2", kind: "turn_summary", durationMs: 2000, timestamp: 6 },
    ];

    const ids = groupThreadEntries(entries).map((i) => (i.type === "entry" ? i.entry.id : i.type));
    expect(ids).toEqual(["u1", "a1", "s1", "u2", "a2", "s2"]);
  });

  it("still shows the summary while the next turn has not started even if the turn is marked running", () => {
    const entries: ThreadEntry[] = [
      { id: "u1", kind: "user_message", text: "一", timestamp: 1 },
      { id: "s1", kind: "turn_summary", durationMs: 1000, timestamp: 2 },
    ];
    const items = groupThreadEntries(entries, { lastTurnComplete: false });
    expect(items[items.length - 1]).toMatchObject({ entry: { id: "s1" } });
  });
});
