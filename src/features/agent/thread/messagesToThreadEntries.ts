import type { Message } from "../../bridge/tauri";
import type { ThreadEntry } from "./types";

/** Convert persisted flat messages into Thread entries for ThreadView. */
export function messagesToThreadEntries(messages: Message[]): ThreadEntry[] {
  const entries: ThreadEntry[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      entries.push({
        id: m.id,
        kind: "user_message",
        text: m.content,
        timestamp: m.timestamp,
      });
      continue;
    }
    if (m.role === "assistant") {
      entries.push({
        id: m.id,
        kind: "assistant_message",
        chunks: [{ type: "message", text: m.content }],
        timestamp: m.timestamp,
      });
    }
  }
  return entries;
}

/** Collect assistant text produced after the last user message in this turn. */
export function assistantTextAfterLastUser(entries: ThreadEntry[]): string | null {
  let lastUser = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].kind === "user_message") {
      lastUser = i;
      break;
    }
  }
  const parts: string[] = [];
  for (let i = lastUser + 1; i < entries.length; i++) {
    const e = entries[i];
    if (e.kind !== "assistant_message") continue;
    for (const c of e.chunks) {
      if (c.type === "message" && c.text) parts.push(c.text);
    }
  }
  const text = parts.join("").trim();
  return text.length > 0 ? text : null;
}
