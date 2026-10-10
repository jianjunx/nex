import { describe, expect, it } from "vitest";
import {
  STREAM_MIN_CPS,
  STREAM_SETTLE_MS,
  advanceReveal,
  seedReveal,
  splitStream,
  streamingEntryId,
  unclosedFenceStart,
} from "./streamingReveal";
import type { ThreadRenderItem } from "./groupThreadEntries";
import type { ThreadEntry } from "./types";

const assistant = (id: string, text: string): ThreadEntry => ({
  id,
  kind: "assistant_message",
  timestamp: 1,
  chunks: [{ type: "message", text }],
});

describe("advanceReveal", () => {
  it("does not move once it has caught the target", () => {
    expect(advanceReveal(40, 40, 16, STREAM_SETTLE_MS)).toBe(40);
    expect(advanceReveal(50, 40, 16, STREAM_SETTLE_MS)).toBe(40);
  });

  it("spreads a burst across the settle window instead of dumping it", () => {
    const burst = 100;
    const oneFrame = advanceReveal(0, burst, 16, STREAM_SETTLE_MS);
    expect(oneFrame).toBeGreaterThan(0);
    expect(oneFrame).toBeLessThan(burst / 2);
  });

  it("still moves a short tail at the minimum speed", () => {
    const step = advanceReveal(0, 1, 1000, STREAM_SETTLE_MS);
    expect(step).toBe(1);
    const cps = advanceReveal(0, 2, 1000 / STREAM_MIN_CPS, STREAM_SETTLE_MS);
    expect(cps).toBeGreaterThan(0.5);
  });
});

describe("splitStream", () => {
  it("keeps an unclosed fence out of the markdown prefix", () => {
    const text = "看这里\n```ts\nconst n = 1";
    expect(unclosedFenceStart(text)).toBe(text.indexOf("```"));
    const split = splitStream(text, text.length);
    expect(split.code).toBe(true);
    expect(split.markdown).toBe("看这里\n");
    expect(split.tail.startsWith("```ts")).toBe(true);
  });

  it("returns a closed fence to markdown and blurs only the trailing prose", () => {
    const text = "```ts\nconst n = 1\n```\n然后继续说明";
    const split = splitStream(text, text.length);
    expect(split.code).toBe(false);
    expect(split.markdown + split.tail).toBe(text);
    expect(split.tail.endsWith("然后继续说明")).toBe(true);
  });

  it("pulls an unclosed inline code mark into the tail", () => {
    const split = splitStream("调用 `npm install", "调用 `npm install".length);
    expect(split.markdown.endsWith("`")).toBe(false);
    expect(split.tail.includes("`npm install")).toBe(true);
  });
});

describe("streamingEntryId", () => {
  it("streams only the assistant message at the end of a running turn", () => {
    const items: ThreadRenderItem[] = [
      { type: "entry", entry: { id: "u", kind: "user_message", text: "hi", timestamp: 1 } },
      { type: "entry", entry: assistant("a1", "先说") },
      { type: "entry", entry: assistant("a2", "正在说") },
    ];
    expect(streamingEntryId(items, false)).toBe("a2");
    expect(streamingEntryId(items, true)).toBeNull();
  });

  it("stops streaming text once a tool call follows it", () => {
    const items: ThreadRenderItem[] = [
      { type: "entry", entry: assistant("a1", "先看文件") },
      { type: "process_group", key: "t", parts: [] },
    ];
    expect(streamingEntryId(items, false)).toBeNull();
  });

  it("seeds the reveal near the end so mounted text is not replayed", () => {
    expect(seedReveal(0)).toBe(0);
    expect(seedReveal(3)).toBe(0);
    expect(seedReveal(20)).toBe(12);
  });
});
