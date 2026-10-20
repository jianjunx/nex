import { diff } from "@codemirror/merge";
import type { ToolCallEntry } from "./types";
import { entryChangeHunks, isEditTool, toolEntryFilePath } from "./toolCallUtils";

/** 文件变更卡片列表区最多同时显示的行数，超出滚动。 */
export const FILES_CHANGED_VISIBLE_ROWS = 3;
/** 文件行固定高度(px)。固定后"最多 3 行"才是精确的，也便于虚拟列表估高。 */
export const FILES_CHANGED_ROW_HEIGHT = 32;

export type ChangedFile = {
  path: string;
  additions: number;
  deletions: number;
  preview?: { oldText: string; newText: string; key: string };
};

/** Encode whole lines so the editor's diff algorithm counts lines rather than characters. */
export function countDiffLines(oldText: string, newText: string): { additions: number; deletions: number } {
  // Snapshot additions/deletions need no diff or per-line token allocations.
  const lineCount = (text: string) => {
    if (!text) return 0;
    let count = 1;
    for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) count++;
    return count;
  };
  if (oldText === newText) return { additions: 0, deletions: 0 };
  if (!oldText) return { additions: lineCount(newText), deletions: 0 };
  if (!newText) return { additions: 0, deletions: lineCount(oldText) };
  const lines = new Map<string, string>();
  const encode = (text: string) => text === "" ? "" : text.split("\n").map((line) => {
    let token = lines.get(line);
    if (token === undefined) {
      // Skip surrogate code points; each token remains one complete Unicode character.
      const id = lines.size + 1;
      token = String.fromCodePoint(id < 0xd800 ? id : id + 0x800);
      lines.set(line, token);
    }
    return token;
  }).join("");
  const a = encode(oldText);
  const b = encode(newText);
  return diff(a, b, { timeout: 50 }).reduce((counts, change) => ({
    additions: counts.additions + Array.from(b.slice(change.fromB, change.toB)).length,
    deletions: counts.deletions + Array.from(a.slice(change.fromA, change.toA)).length,
  }), { additions: 0, deletions: 0 });
}

function pathKey(path: string): string {
  return path.replace(/\\/g, "/");
}

/** Aggregate completed edit tools into one row per file (later edits accumulate). */
export function collectChangedFiles(edits: ToolCallEntry[]): ChangedFile[] {
  const byPath = new Map<string, ChangedFile>();
  const order: string[] = [];

  const add = (path: string, additions: number, deletions: number) => {
    const key = pathKey(path);
    const existing = byPath.get(key);
    if (existing) {
      existing.additions += additions;
      existing.deletions += deletions;
      return;
    }
    byPath.set(key, { path, additions, deletions });
    order.push(key);
  };

  for (const entry of edits) {
    if (!isEditTool(entry) || entry.status !== "completed") continue;
    const fallback = toolEntryFilePath(entry);
    const hunks = entryChangeHunks(entry);
    if (hunks.length === 0) {
      if (fallback) add(fallback, 0, 0);
      continue;
    }
    for (const h of hunks) {
      const path = h.path?.trim() || fallback;
      if (!path) continue;
      const { additions, deletions } = countDiffLines(h.oldText, h.newText);
      add(path, additions, deletions);
    }
  }

  return order.map((k) => byPath.get(k)!);
}
