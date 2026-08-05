import { beforeEach, describe, expect, it } from "vitest";
import { fuzzyFilter, fuzzyScore } from "./composerFuzzy";

describe("composerFuzzy", () => {
  beforeEach(() => {});

  it("scores exact / prefix / includes", () => {
    expect(fuzzyScore("foo", "foo")).toBeGreaterThan(fuzzyScore("foo", "foobar")!);
    expect(fuzzyScore("foo", "foobar")).toBeGreaterThan(fuzzyScore("foo", "xfooy")!);
    expect(fuzzyScore("zz", "abc")).toBeNull();
  });

  it("matches subsequence with boundaries", () => {
    expect(fuzzyScore("lcd", "lark-contact-doc")).not.toBeNull();
    expect(fuzzyScore("lark", "lark-contact")).toBeGreaterThan(0);
  });

  it("fuzzyFilter sorts by score and respects limit", () => {
    const items = ["lark-contact", "lark-calendar", "explore", "contact-book"];
    const out = fuzzyFilter(items, "lark", (s) => s, 10);
    expect(out[0]).toBe("lark-contact");
    expect(out).toContain("lark-calendar");
    expect(out).not.toContain("explore");
  });
});
