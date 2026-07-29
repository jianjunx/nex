/** Default title written by `conversation_create` until the first user turn. */
export const DEFAULT_CONVERSATION_TITLE = "New Chat";

/**
 * Build a short tab title from the first user message: first non-empty line,
 * collapsed whitespace, truncated to `maxLen` Unicode code points.
 */
export function deriveConversationTitle(text: string, maxLen = 40): string {
  const firstLine =
    text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? text.trim();
  const collapsed = firstLine.replace(/\s+/g, " ").trim();
  if (!collapsed) return DEFAULT_CONVERSATION_TITLE;
  const chars = Array.from(collapsed);
  if (chars.length <= maxLen) return collapsed;
  return `${chars.slice(0, maxLen - 1).join("")}…`;
}
