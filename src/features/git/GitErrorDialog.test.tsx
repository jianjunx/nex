/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from "vitest";
import { summarizeGitError } from "./GitErrorDialog";

describe("summarizeGitError", () => {
  it("prefers fatal/error lines for the summary", () => {
    const raw = "hint: do something\nfatal: Authentication failed\nmore context";
    const { summary, detail } = summarizeGitError(raw);
    expect(summary).toBe("fatal: Authentication failed");
    expect(detail).toContain("more context");
  });

  it("falls back to the first line", () => {
    expect(summarizeGitError("only one line").summary).toBe("only one line");
  });
});
