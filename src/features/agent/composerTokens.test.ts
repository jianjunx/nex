import { describe, expect, it } from "vitest";
import {
  appendToken,
  hasToken,
  parseTokens,
  resolveTokenPath,
  stripAtTrigger,
  tokenFor,
} from "./composerTokens";

const PROJ = "/proj";

describe("parseTokens", () => {
  it("extracts tokens with basename", () => {
    const t = parseTokens("看下 @[src/main.rs] 和 @[README.md]");
    expect(t).toEqual([
      { path: "src/main.rs", name: "main.rs" },
      { path: "README.md", name: "README.md" },
    ]);
  });
  it("handles windows paths", () => {
    const t = parseTokens("@[C:\\a\\b.txt]");
    expect(t).toEqual([{ path: "C:\\a\\b.txt", name: "b.txt" }]);
  });
  it("returns empty for plain text", () => {
    expect(parseTokens("no tokens here")).toEqual([]);
    expect(parseTokens("")).toEqual([]);
  });
  it("ignores lone @ without brackets", () => {
    expect(parseTokens("@foo @[unclosed")).toEqual([]);
  });
});

describe("tokenFor", () => {
  it("prefers project-relative path", () => {
    expect(tokenFor("/proj/src/a.ts", PROJ)).toBe("@[src/a.ts]");
  });
  it("normalizes windows separators in relative form", () => {
    expect(tokenFor("D:\\proj\\src\\a.ts", "D:\\proj")).toBe("@[src/a.ts]");
  });
  it("falls back to absolute outside the project", () => {
    expect(tokenFor("/other/b.ts", PROJ)).toBe("@[/other/b.ts]");
  });
  it("falls back when no project", () => {
    expect(tokenFor("/x/y.ts", undefined)).toBe("@[/x/y.ts]");
  });
});

describe("stripAtTrigger", () => {
  it("removes trailing trigger", () => {
    expect(stripAtTrigger("hello @m")).toBe("hello ");
  });
  it("removes trigger at start", () => {
    expect(stripAtTrigger("@ma")).toBe("");
  });
  it("keeps text when no trigger", () => {
    expect(stripAtTrigger("hello world")).toBe("hello world");
    expect(stripAtTrigger("@[src/a.ts] done")).toBe("@[src/a.ts] done");
  });
});

describe("hasToken / appendToken", () => {
  it("append adds token with trailing space", () => {
    expect(appendToken("hi", "/proj/a.ts", PROJ)).toBe("hi @[a.ts] ");
    expect(appendToken("", "/proj/a.ts", PROJ)).toBe("@[a.ts] ");
  });
  it("append is idempotent per path", () => {
    const once = appendToken("", "/proj/a.ts", PROJ);
    expect(appendToken(once, "/proj/a.ts", PROJ)).toBe(once);
    expect(hasToken(once, "/proj/a.ts", PROJ)).toBe(true);
  });
  it("append keeps absolute for outside paths", () => {
    expect(appendToken("", "/etc/hosts", PROJ)).toBe("@[/etc/hosts] ");
  });
});

describe("resolveTokenPath", () => {
  it("joins relative token paths onto the project root", () => {
    expect(resolveTokenPath("src/a.ts", "/proj")).toBe("/proj/src/a.ts");
    expect(resolveTokenPath("src/a.ts", "D:\\proj")).toBe("D:\\proj\\src\\a.ts");
  });
  it("passes absolute paths through", () => {
    expect(resolveTokenPath("/etc/hosts", "/proj")).toBe("/etc/hosts");
    expect(resolveTokenPath("C:\\x.txt", "D:\\proj")).toBe("C:\\x.txt");
    expect(resolveTokenPath("\\\\server\\share\\f.txt", "/proj")).toBe("\\\\server\\share\\f.txt");
  });
  it("keeps relative when no project", () => {
    expect(resolveTokenPath("a.ts", undefined)).toBe("a.ts");
  });
});
