import type { ThreadEntry, ToolCallEntry } from "./types";
import { isEditTool } from "./toolCallUtils";

export type ThreadRenderItem =
  | { type: "entry"; entry: ThreadEntry }
  | { type: "tool_group"; entries: ToolCallEntry[]; key: string };

/**
 * Collapse adjacent non-edit tool_call entries into a single group item.
 * Edit tools and all other entry kinds stay as standalone items.
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
    if (entry.kind === "tool_call" && !isEditTool(entry)) {
      toolBuf.push(entry);
      continue;
    }
    flushTools();
    items.push({ type: "entry", entry });
  }
  flushTools();
  return items;
}
