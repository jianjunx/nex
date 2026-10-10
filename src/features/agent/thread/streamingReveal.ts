import type { ThreadRenderItem } from "./groupThreadEntries";

/** 落后的字符在这段时间内被消化掉，突发分片不会整段砸到屏幕上。 */
export const STREAM_SETTLE_MS = 220;
/** 一轮已经结束时加快收尾，避免光标空转。 */
export const STREAM_SETTLE_DONE_MS = 90;
/** 再短的尾巴也按这个速度走完，避免最后一个字拖太久。 */
export const STREAM_MIN_CPS = 36;
/** 句尾保持模糊的字符数，对应 beautiful-ui 的 stream-tail。 */
export const STREAM_BLUR_CHARS = 8;

export function seedReveal(length: number): number {
  return Math.max(0, length - STREAM_BLUR_CHARS);
}

/**
 * 把 `shown` 朝 `target` 推进 `dtMs`。速度随落后量增大，
 * 所以快模型只会拖一条短尾巴，慢模型仍是逐字出来。
 */
export function advanceReveal(shown: number, target: number, dtMs: number, settleMs: number): number {
  if (!Number.isFinite(shown) || shown >= target) return Math.max(0, target);
  const behind = target - Math.max(0, shown);
  const settle = settleMs > 0 ? settleMs : STREAM_SETTLE_MS;
  const cps = Math.max(STREAM_MIN_CPS, (behind / settle) * 1000);
  const step = (cps * Math.max(0, dtMs)) / 1000;
  return Math.min(target, Math.max(0, shown) + step);
}

export interface StreamSplit {
  /** 已经稳定、可以按 Markdown 排版的前缀。 */
  markdown: string;
  /** 还在吐出的尾巴，保持原文，避免半个标记把排版打乱。 */
  tail: string;
  /** 尾巴落在未闭合的围栏代码块里。 */
  code: boolean;
}

/** 未闭合 ``` 的起始下标；全部成对时返回 -1。 */
export function unclosedFenceStart(text: string): number {
  let open = -1;
  const re = /^```/gm;
  let count = 0;
  for (let match = re.exec(text); match; match = re.exec(text)) {
    count += 1;
    open = count % 2 === 1 ? match.index : -1;
  }
  return open;
}

function snapToInlineOpener(text: string, cut: number): number {
  const before = text.slice(0, cut);
  const ticks = before.match(/`/g)?.length ?? 0;
  if (ticks % 2 === 0) return cut;
  const opener = before.lastIndexOf("`");
  if (opener < 0 || cut - opener > 80) return cut;
  return opener;
}

/** 把已揭示的文本切成稳定 Markdown 和仍在模糊的尾巴。 */
export function splitStream(text: string, shown: number): StreamSplit {
  const end = Math.max(0, Math.min(text.length, Math.floor(shown)));
  const head = text.slice(0, end);
  const fence = unclosedFenceStart(head);
  if (fence >= 0) {
    return { markdown: head.slice(0, fence), tail: head.slice(fence), code: true };
  }
  const cut = snapToInlineOpener(head, Math.max(0, end - STREAM_BLUR_CHARS));
  return { markdown: head.slice(0, cut), tail: head.slice(cut), code: false };
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
