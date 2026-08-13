import { describe, expect, it } from "vitest";
import { collectChangedFiles, countDiffLines } from "./filesChanged";
import type { ToolCallEntry } from "./types";

function edit(partial: Partial<ToolCallEntry> & { id: string }): ToolCallEntry {
  return {
    kind: "tool_call",
    toolCallId: partial.id,
    title: partial.title ?? "Edit",
    toolKind: "edit",
    status: "completed",
    content: [],
    timestamp: 0,
    ...partial,
  };
}

describe("countDiffLines", () => {
  it("counts a replaced line as +1 / −1", () => {
    expect(countDiffLines("const a = 1;", "const a = 2;")).toEqual({
      additions: 1,
      deletions: 1,
    });
  });

  it("counts pure insertions and deletions", () => {
    expect(countDiffLines("a\nb", "a\nb\nc")).toEqual({ additions: 1, deletions: 0 });
    expect(countDiffLines("a\nb\nc", "a\nc")).toEqual({ additions: 0, deletions: 1 });
  });

  it("treats empty strings as zero lines", () => {
    expect(countDiffLines("", "hello")).toEqual({ additions: 1, deletions: 0 });
    expect(countDiffLines("hello", "")).toEqual({ additions: 0, deletions: 1 });
    expect(countDiffLines("", "")).toEqual({ additions: 0, deletions: 0 });
  });
});

describe("collectChangedFiles", () => {
  it("sums hunks and keeps first-seen file order", () => {
    const files = collectChangedFiles([
      edit({
        id: "e1",
        content: [{ type: "diff", path: "src/IconBar.tsx", oldText: "aaa", newText: "bbb" }],
      }),
      edit({
        id: "e2",
        content: [{ type: "diff", path: "src/SettingsDialog.tsx", oldText: "x", newText: "yy" }],
      }),
      edit({
        id: "e3",
        content: [{ type: "diff", path: "src/IconBar.tsx", oldText: "bbb", newText: "ccc" }],
      }),
    ]);
    expect(files.map((f) => f.path)).toEqual(["src/IconBar.tsx", "src/SettingsDialog.tsx"]);
    expect(files[0].additions).toBe(2);
    expect(files[0].deletions).toBe(2);
  });

  it("uses rawInput path when content has no diff block", () => {
    const files = collectChangedFiles([
      edit({
        id: "e1",
        rawInput: { path: "src/a.ts", old_string: "a", new_string: "b" },
      }),
    ]);
    expect(files).toEqual([{ path: "src/a.ts", additions: 1, deletions: 1 }]);
  });

  it("ignores failed and non-edit tools", () => {
    expect(
      collectChangedFiles([
        edit({
          id: "e1",
          status: "failed",
          content: [{ type: "diff", path: "a.ts", oldText: "a", newText: "b" }],
        }),
        edit({
          id: "e2",
          toolKind: "read",
          content: [{ type: "diff", path: "b.ts", oldText: "a", newText: "b" }],
        }),
      ]),
    ).toEqual([]);
  });
});
