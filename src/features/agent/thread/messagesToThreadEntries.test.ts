import { describe, expect, it } from "vitest";
import {
  assistantTextAfterLastUser,
  messagesToThreadEntries,
} from "./messagesToThreadEntries";
import type { ThreadEntry } from "./types";

describe("messagesToThreadEntries", () => {
  it("maps user and assistant roles; skips unknown", () => {
    const entries = messagesToThreadEntries([
      {
        id: "1",
        conversation_id: "c",
        role: "user",
        content: "hi",
        tool_summary: null,
        timestamp: 1,
        sequence: 1,
      },
      {
        id: "2",
        conversation_id: "c",
        role: "assistant",
        content: "hello",
        tool_summary: null,
        timestamp: 2,
        sequence: 2,
      },
      {
        id: "3",
        conversation_id: "c",
        role: "system",
        content: "x",
        tool_summary: null,
        timestamp: 3,
        sequence: 3,
      },
    ]);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ kind: "user_message", text: "hi" });
    expect(entries[1]).toMatchObject({
      kind: "assistant_message",
      chunks: [{ type: "message", text: "hello" }],
    });
  });
});

describe("assistantTextAfterLastUser", () => {
  it("joins assistant message chunks after the last user turn", () => {
    const entries: ThreadEntry[] = [
      { id: "u1", kind: "user_message", text: "a", timestamp: 1 },
      {
        id: "a1",
        kind: "assistant_message",
        chunks: [
          { type: "thought", text: "thinking" },
          { type: "message", text: "Hello " },
          { type: "message", text: "world" },
        ],
        timestamp: 2,
      },
    ];
    expect(assistantTextAfterLastUser(entries)).toBe("Hello world");
  });
});
