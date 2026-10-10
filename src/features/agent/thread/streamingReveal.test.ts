import { describe, expect, it } from "vitest";
import {
  nextWordBoundary,
  revealWords,
  streamingEntryId,
  wordsBehind,
  wordsThisTick,
} from "./streamingReveal";
import type { ThreadRenderItem } from "./groupThreadEntries";
import type { ThreadEntry } from "./types";

const assistant = (id: string, text: string): ThreadEntry => ({
  id,
  kind: "assistant_message",
  timestamp: 1,
  chunks: [{ type: "message", text }],
});

describe("nextWordBoundary", () => {
  it("reveals an English word, then the next one", () => {
    const text = "hello world";
    const first = nextWordBoundary(text, 0);
    expect(text.slice(0, first)).toBe("hello");
    expect(text.slice(0, nextWordBoundary(text, first))).toBe("hello world");
  });

  it("reveals Chinese one character at a time", () => {
    const text = "你好";
    expect(nextWordBoundary(text, 0)).toBe(1);
    expect(nextWordBoundary(text, 1)).toBe(2);
  });

  it("keeps punctuation on the word it follows", () => {
    const text = "done. Next";
    expect(text.slice(0, nextWordBoundary(text, 0))).toBe("done.");
  });
});

describe("reveal pacing", () => {
  it("steps one word when the model is only a little ahead", () => {
    expect(wordsThisTick(1)).toBe(1);
    expect(wordsThisTick(4)).toBe(1);
    expect(revealWords("one two three four", 0, 1)).toBe(3);
  });

  it("catches a burst up in a handful of ticks", () => {
    const behind = wordsBehind("a b c d e f g h i j k l", 0);
    expect(behind).toBe(12);
    const step = wordsThisTick(behind);
    expect(step).toBeGreaterThan(1);
    expect(step).toBeLessThan(behind);
  });

  it("finishes a short tail promptly after the turn ends", () => {
    expect(wordsThisTick(10, true)).toBeGreaterThanOrEqual(4);
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
});
