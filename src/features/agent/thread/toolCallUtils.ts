import type { ToolCallEntry } from "./types";
import { looksLikeFilePath, pathFromToolRawInput } from "./pathToken";

export function isEditTool(entry: ToolCallEntry): boolean {
  return entry.toolKind.toLowerCase() === "edit";
}

/**
 * NexAgent 走标准 ACP，工具通知不带 diff content 块（只有 raw_input）。
 * 对 edit 类工具（edit_file / multi_edit），从 raw_input 的
 * old_string → new_string 构造伪 diff。multi_edit 展开全部 hunk。
 */
function syntheticHunksFromRawInput(
  raw: unknown,
): { path?: string; oldText: string; newText: string }[] {
  if (!raw || typeof raw !== "object") return [];
  const o = raw as Record<string, unknown>;
  const path = typeof o.path === "string" && o.path.trim() ? o.path.trim() : undefined;
  if (Array.isArray(o.edits) && o.edits.length > 0) {
    const hunks: { path?: string; oldText: string; newText: string }[] = [];
    for (const item of o.edits) {
      if (!item || typeof item !== "object") continue;
      const e = item as Record<string, unknown>;
      if (typeof e.old_string === "string" && typeof e.new_string === "string") {
        hunks.push({ path, oldText: e.old_string, newText: e.new_string });
      }
    }
    return hunks;
  }
  if (typeof o.old_string === "string" && typeof o.new_string === "string") {
    return [{ path, oldText: o.old_string, newText: o.new_string }];
  }
  return [];
}

/** 工具卡内嵌 diff：优先 content 里的 diff 块；否则从 rawInput 合成（multi_edit 取首个）。 */
export function entryDiffs(entry: ToolCallEntry): { path?: string; oldText: string; newText: string }[] {
  const fromContent = entry.content.filter((c) => c.type === "diff");
  if (fromContent.length > 0) {
    return fromContent.map((c) => ({
      path: c.path,
      oldText: c.oldText ?? "",
      newText: c.newText ?? "",
    }));
  }
  const synthetic = syntheticHunksFromRawInput(entry.rawInput);
  return synthetic.slice(0, 1);
}

/** 变更汇总用：content diff 块 + rawInput 全部 hunk（含 multi_edit）。 */
export function entryChangeHunks(
  entry: ToolCallEntry,
): { path?: string; oldText: string; newText: string }[] {
  const fromContent = entry.content.filter((c) => c.type === "diff");
  if (fromContent.length > 0) {
    return fromContent.map((c) => ({
      path: c.path,
      oldText: c.oldText ?? "",
      newText: c.newText ?? "",
    }));
  }
  return syntheticHunksFromRawInput(entry.rawInput);
}

/** Prefer diff path, then rawInput, then a path-like title. */
export function toolEntryFilePath(entry: ToolCallEntry): string | null {
  for (const c of entry.content) {
    if (c.type === "diff" && c.path) return c.path;
  }
  return pathFromToolRawInput(entry.rawInput) ?? (looksLikeFilePath(entry.title) ? entry.title : null);
}
