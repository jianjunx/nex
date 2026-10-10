import type {
  AssistantMessageEntry,
  ThreadEntry,
  ToolCallEntry,
  TurnSummaryEntry,
} from "./types";
import { groupChunks } from "./groupChunks";
import { collectChangedFiles, type ChangedFile } from "./filesChanged";
import { isEditTool } from "./toolCallUtils";

/** One step of the agent's working process: a reasoning block or a tool call. */
export type ProcessPart =
  | { type: "thought"; key: string; text: string }
  | { type: "tool"; key: string; entry: ToolCallEntry };

export type ThreadRenderItem =
  | { type: "entry"; entry: ThreadEntry }
  /** Consecutive reasoning + tool calls, folded into one disclosure. */
  | { type: "process_group"; parts: ProcessPart[]; key: string }
  | { type: "files_changed"; files: ChangedFile[]; key: string };

type AssistantSegment =
  | { kind: "thoughts"; parts: ProcessPart[] }
  | { kind: "message"; entry: AssistantMessageEntry };

/**
 * Splits an assistant message into reasoning runs and answer text so the
 * reasoning can join the surrounding tool calls. Cached per entry object:
 * immer keeps untouched history entries referentially stable, so only the
 * streaming tail is recomputed and the memoized EntryView rows stay valid.
 */
const segmentCache = new WeakMap<AssistantMessageEntry, AssistantSegment[] | null>();

function segmentAssistant(entry: AssistantMessageEntry): AssistantSegment[] | null {
  const cached = segmentCache.get(entry);
  if (cached !== undefined) return cached;
  let result: AssistantSegment[] | null = null;
  if (entry.chunks.some((c) => c.type === "thought")) {
    const segments: AssistantSegment[] = [];
    let firstMessage = true;
    groupChunks(entry.chunks).forEach((chunk, i) => {
      if (chunk.type === "thought") {
        const part: ProcessPart = { type: "thought", key: `${entry.id}:t${i}`, text: chunk.text };
        const last = segments[segments.length - 1];
        if (last?.kind === "thoughts") last.parts.push(part);
        else segments.push({ kind: "thoughts", parts: [part] });
        return;
      }
      segments.push({
        kind: "message",
        entry: {
          ...entry,
          // The first answer keeps the original id (stable row key).
          id: firstMessage ? entry.id : `${entry.id}:m${i}`,
          chunks: [chunk],
        },
      });
      firstMessage = false;
    });
    result = segments;
  }
  segmentCache.set(entry, result);
  return result;
}

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
 * Collapse adjacent reasoning and tool_call entries into a single group item.
 * Permission-waiting tools stay standalone so prompts remain visible.
 * After each completed turn that edited files, insert a files_changed card.
 */
export function groupThreadEntries(
  entries: ThreadEntry[],
  opts: GroupThreadEntriesOptions = {},
): ThreadRenderItem[] {
  const lastTurnComplete = opts.lastTurnComplete ?? true;
  const items: ThreadRenderItem[] = [];
  let toolBuf: ProcessPart[] = [];
  let turnEdits: ToolCallEntry[] = [];
  /** 本轮用量摘要：始终排在整轮最末（文件变更卡片之后）。 */
  let turnFooter: TurnSummaryEntry | null = null;
  let turn = 0;

  const flushTools = () => {
    if (toolBuf.length === 0) return;
    items.push({
      type: "process_group",
      parts: toolBuf,
      // 首个成员的 key 作组 key:成员流式追加时 key 不变,避免整组 remount 丢展开态。
      key: toolBuf[0].key,
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
    if (turnFooter) {
      items.push({ type: "entry", entry: turnFooter });
      turnFooter = null;
    }
    turn += 1;
  };

  for (const entry of entries) {
    if (entry.kind === "turn_summary") {
      flushTools();
      turnFooter = entry;
      continue;
    }
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
      toolBuf.push({ type: "tool", key: entry.id, entry });
      continue;
    }
    if (entry.kind === "assistant_message") {
      const segments = segmentAssistant(entry);
      if (segments) {
        for (const seg of segments) {
          if (seg.kind === "thoughts") toolBuf.push(...seg.parts);
          else {
            flushTools();
            items.push({ type: "entry", entry: seg.entry });
          }
        }
        continue;
      }
    }
    flushTools();
    items.push({ type: "entry", entry });
  }
  flushTurnSummary(lastTurnComplete);
  return items;
}
