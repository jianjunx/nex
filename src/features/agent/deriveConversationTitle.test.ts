import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONVERSATION_TITLE,
  deriveConversationTitle,
} from "./deriveConversationTitle";

describe("deriveConversationTitle", () => {
  it("uses the first non-empty line and collapses whitespace", () => {
    expect(deriveConversationTitle("  hello   world  \nmore")).toBe("hello world");
  });

  it("truncates long text with an ellipsis", () => {
    const title = deriveConversationTitle("一二三四五六七八九十".repeat(5), 10);
    expect(Array.from(title).length).toBe(10);
    expect(title.endsWith("…")).toBe(true);
  });

  it("returns the default for empty / whitespace-only input", () => {
    expect(deriveConversationTitle("   \n  ")).toBe(DEFAULT_CONVERSATION_TITLE);
  });
});
