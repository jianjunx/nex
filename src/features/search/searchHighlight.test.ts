import { describe, expect, it } from "vitest";
import { buildHighlightRegExp, matchRanges } from "./searchHighlight";

const off = { caseSensitive: false, wholeWord: false, regex: false };

describe("buildHighlightRegExp", () => {
  it("escapes plain queries and is case-insensitive by default", () => {
    const re = buildHighlightRegExp("a.b", off)!;
    expect(matchRanges("a.b A.B", re)).toEqual([[0, 3], [4, 7]]);
  });

  it("honors caseSensitive", () => {
    const re = buildHighlightRegExp("Foo", { ...off, caseSensitive: true })!;
    expect(matchRanges("Foo foo", re)).toEqual([[0, 3]]);
  });

  it("wraps whole-word boundaries", () => {
    const re = buildHighlightRegExp("cat", { ...off, wholeWord: true })!;
    expect(matchRanges("cat concat", re)).toEqual([[0, 3]]);
  });

  it("passes regex mode through", () => {
    const re = buildHighlightRegExp("\\d+", { ...off, regex: true })!;
    expect(matchRanges("a1 bb22", re)).toEqual([[1, 2], [5, 7]]);
  });

  it("returns null for an invalid regex", () => {
    expect(buildHighlightRegExp("([", { ...off, regex: true })).toBeNull();
  });

  it("returns null for an empty query", () => {
    expect(buildHighlightRegExp("", off)).toBeNull();
  });
});

describe("matchRanges", () => {
  it("returns [] for a null regexp", () => {
    expect(matchRanges("anything", null)).toEqual([]);
  });

  it("terminates on zero-length matches", () => {
    const re = buildHighlightRegExp("x*", { ...off, regex: true })!;
    const ranges = matchRanges("ab", re);
    expect(Array.isArray(ranges)).toBe(true);
  });
});
