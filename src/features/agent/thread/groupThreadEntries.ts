import type { ThreadEntry, ToolCallEntry } from "./types";
import { isEditTool } from "./toolCallUtils";

export type ThreadRenderItem =
  | { type: "entry"; entry: ThreadEntry }
  | { type: "tool_group"; entries: ToolCallEntry[]; key: string };

/**
 * Collapse adjacent non-edit tool_call entries into a single group item.
 * Edit tools, permission-waiting tools, and all other entry kinds stay standalone
 * so AskUserQuestion / permission prompts remain visible.
 */
export function groupThreadEntries(entries: ThreadEntry[]): ThreadRenderItem[] {
  const items: ThreadRenderItem[] = [];
  let toolBuf: ToolCallEntry[] = [];

  const flushTools = () => {
    if (toolBuf.length === 0) return;
    items.push({
      type: "tool_group",
      entries: toolBuf,
      key: toolBuf.map((e) => e.id).join(":"),
    });
    toolBuf = [];
  };

  for (const entry of entries) {
    const waiting =
      entry.kind === "tool_call" && entry.status === "waiting_for_confirmation";
    if (entry.kind === "tool_call" && !isEditTool(entry) && !waiting) {
      toolBuf.push(entry);
      continue;
    }
    flushTools();
    items.push({ type: "entry", entry });
  }
  flushTools();
  return items;
}
