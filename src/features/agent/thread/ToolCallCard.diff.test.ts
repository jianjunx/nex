import { describe, expect, it } from "vitest";
import type { ToolCallEntry } from "./types";
import { entryDiffs } from "./toolCallUtils";

function entry(partial: Partial<ToolCallEntry> & { rawInput?: unknown }): ToolCallEntry {
  return {
    id: "e1",
    timestamp: 0,
    kind: "tool_call",
    toolCallId: "t1",
    title: "edit_file(src/a.ts)",
    toolKind: "edit",
    status: "completed",
    content: [],
    ...partial,
  } as ToolCallEntry;
}

describe("entryDiffs 从 NexAgent rawInput 合成可高亮 diff", () => {
  it("edit_file: old_string → new_string 合成 diff", () => {
    const e = entry({
      rawInput: {
        path: "src/a.ts",
        old_string: "const a = 1;",
        new_string: "const a = 2;",
      },
    });
    const diffs = entryDiffs(e);
    expect(diffs).toHaveLength(1);
    expect(diffs[0]).toEqual({
      path: "src/a.ts",
      oldText: "const a = 1;",
      newText: "const a = 2;",
    });
  });

  it("multi_edit: 取首个 edit 合成 diff", () => {
    const e = entry({
      rawInput: {
        path: "src/b.rs",
        edits: [
          { old_string: "fn x() {}", new_string: "fn y() {}" },
          { old_string: "z", new_string: "w" },
        ],
      },
    });
    const diffs = entryDiffs(e);
    expect(diffs).toHaveLength(1);
    expect(diffs[0]).toEqual({
      path: "src/b.rs",
      oldText: "fn x() {}",
      newText: "fn y() {}",
    });
  });

  it("content 已有 diff 块时优先使用，不重复合成", () => {
    const e = entry({
      content: [
        {
          type: "diff",
          path: "src/c.ts",
          oldText: "old",
          newText: "new",
        },
      ],
      rawInput: { path: "src/c.ts", old_string: "x", new_string: "y" },
    });
    const diffs = entryDiffs(e);
    expect(diffs).toHaveLength(1);
    expect(diffs[0]).toEqual({ path: "src/c.ts", oldText: "old", newText: "new" });
  });

  it("非 edit 工具或缺少 old/new 时不合成", () => {
    expect(entryDiffs(entry({ rawInput: { path: "a.ts" } }))).toHaveLength(0);
    expect(entryDiffs(entry({ rawInput: null }))).toHaveLength(0);
    expect(entryDiffs(entry({ rawInput: { path: "a.ts", old_string: "x" } }))).toHaveLength(0);
  });
});
