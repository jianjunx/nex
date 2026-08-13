import type { ToolCallEntry } from "./types";
import { entryChangeHunks, isEditTool, toolEntryFilePath } from "./toolCallUtils";

export type ChangedFile = {
  path: string;
  additions: number;
  deletions: number;
};

/** Line-based LCS: additions / deletions relative to the longest common subsequence. */
export function countDiffLines(oldText: string, newText: string): { additions: number; deletions: number } {
  const a = oldText.length === 0 ? [] : oldText.split("\n");
  const b = newText.length === 0 ? [] : newText.split("\n");
  const n = a.length;
  const m = b.length;
  if (n === 0) return { additions: m, deletions: 0 };
  if (m === 0) return { additions: 0, deletions: n };
  // Cap DP to keep summary aggregation cheap on huge dumps.
  if (n * m > 80_000) {
    return { additions: m, deletions: n };
  }
  let prev = new Uint32Array(m + 1);
  let curr = new Uint32Array(m + 1);
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      curr[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : prev[j] > curr[j - 1] ? prev[j] : curr[j - 1];
    }
    const tmp = prev;
    prev = curr;
    curr = tmp;
    curr.fill(0);
  }
  const lcs = prev[m];
  return { additions: m - lcs, deletions: n - lcs };
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
