import type { ThreadEntry, ToolCallEntry } from "./types";
import { collectChangedFiles, type ChangedFile } from "./filesChanged";
import { isEditTool } from "./toolCallUtils";

export type ThreadRenderItem =
  | { type: "entry"; entry: ThreadEntry }
  | { type: "tool_group"; entries: ToolCallEntry[]; key: string }
  | { type: "files_changed"; files: ChangedFile[]; key: string };

export type GroupThreadEntriesOptions = {
  /**
   * When true, append a files-changed summary after the last turn if it
   * contains completed edits. Historical turns (closed by a later user
   * message) always get a summary. Pass false while the current turn is
   * still running so the card only appears after the task ends.
   */
  lastTurnComplete?: boolean;
};

/**
 * Collapse adjacent tool_call entries into a single group item.
 * Permission-waiting tools stay standalone so prompts remain visible.
 * After each completed turn that edited files, insert a files_changed card.
 */
export function groupThreadEntries(
  entries: ThreadEntry[],
  opts: GroupThreadEntriesOptions = {},
): ThreadRenderItem[] {
  const lastTurnComplete = opts.lastTurnComplete ?? true;
  const items: ThreadRenderItem[] = [];
  let toolBuf: ToolCallEntry[] = [];
  let turnEdits: ToolCallEntry[] = [];
  let turn = 0;

  const flushTools = () => {
    if (toolBuf.length === 0) return;
    items.push({
      type: "tool_group",
      entries: toolBuf,
      // 首个 id 作 key:成员流式追加时 key 不变,避免整组 remount 丢展开态。
      key: toolBuf[0].id,
    });
    toolBuf = [];
  };

  const flushTurnSummary = (complete: boolean) => {
    flushTools();
    if (complete && turnEdits.length > 0) {
      const files = collectChangedFiles(turnEdits);
      if (files.length > 0) {
        items.push({
          type: "files_changed",
          files,
          key: `${turn}:${turnEdits[0].id}`,
        });
      }
    }
    turnEdits = [];
    turn += 1;
  };

  for (const entry of entries) {
    if (entry.kind === "user_message") {
      flushTurnSummary(true);
      items.push({ type: "entry", entry });
      continue;
    }
    const waiting =
      entry.kind === "tool_call" && entry.status === "waiting_for_confirmation";
    if (entry.kind === "tool_call" && !waiting) {
      if (isEditTool(entry) && entry.status === "completed") {
        turnEdits.push(entry);
      }
      toolBuf.push(entry);
      continue;
    }
    flushTools();
    items.push({ type: "entry", entry });
  }
  flushTurnSummary(lastTurnComplete);
  return items;
}
