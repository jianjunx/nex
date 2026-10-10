import type { ThreadRenderItem } from "./groupThreadEntries";

/** beautiful-ui Streaming Text 的节奏：每 55ms 揭示一个词。 */
export const STREAM_WORD_MS = 55;

function isCjk(code: number): boolean {
  return (
    (code >= 0x3400 && code <= 0x9fff) ||
    (code >= 0x3040 && code <= 0x30ff) ||
    (code >= 0xac00 && code <= 0xd7af) ||
    (code >= 0xf900 && code <= 0xfaff)
  );
}

/**
 * 下一个词的结束位置。英文按空白分词，中文按字，标点跟着前一个词走。
 * 和官网一样一次出现一个完整的词，而不是逐字符渗出。
 */
export function nextWordBoundary(text: string, from: number): number {
  if (from >= text.length) return text.length;
  let i = from;
  while (i < text.length && /\s/.test(text[i])) i += 1;
  if (i >= text.length) return text.length;
  const code = text.codePointAt(i) ?? 0;
  const width = code > 0xffff ? 2 : 1;
  if (isCjk(code)) return i + width;
  let j = i + width;
  while (j < text.length) {
    const next = text.codePointAt(j) ?? 0;
    const ch = String.fromCodePoint(next);
    if (/\s/.test(ch) || isCjk(next)) break;
    j += next > 0xffff ? 2 : 1;
  }
  return j;
}

/** 从 `shown` 再揭示 `words` 个词。 */
export function revealWords(text: string, shown: number, words: number): number {
  let i = Math.max(0, Math.min(shown, text.length));
  const steps = Math.max(0, Math.floor(words));
  for (let n = 0; n < steps && i < text.length; n += 1) {
    const next = nextWordBoundary(text, i);
    if (next <= i) break;
    i = next;
  }
  return i;
}

export function wordsBehind(text: string, shown: number): number {
  let i = Math.max(0, Math.min(shown, text.length));
  let count = 0;
  while (i < text.length && count < 100_000) {
    const next = nextWordBoundary(text, i);
    if (next <= i) break;
    i = next;
    count += 1;
  }
  return count;
}

/**
 * 落后不多时一次一个词，和官网演示一致。
 * 模型一次推来一大段时加快追赶，大约 6 拍内消化完，避免越积越长。
 */
export function wordsThisTick(behind: number, turnEnded = false): number {
  if (behind <= 0) return 0;
  if (!turnEnded && behind <= 4) return 1;
  const paced = Math.ceil(behind / 6);
  return Math.min(behind, Math.max(turnEnded ? 4 : 1, paced));
}

/**
 * 正在生成、且后面还没有工具或新的用户消息时，最后一条助手正文才播吐字动画。
 * 更早的段落保持定稿，避免整段历史重播。
 */
export function streamingEntryId(items: ThreadRenderItem[], turnComplete: boolean): string | null {
  if (turnComplete) return null;
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (!item) continue;
    if (item.type !== "entry") return null;
    if (item.entry.kind === "assistant_message") return item.entry.id;
    return null;
  }
  return null;
}
