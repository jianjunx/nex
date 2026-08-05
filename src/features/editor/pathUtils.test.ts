import { describe, expect, it } from "vitest";
import { fileBasename, isSameOrDescendant, relativeToProject } from "./pathUtils";

describe("fileBasename", () => {
  it("handles posix and windows separators", () => {
    expect(fileBasename("/a/b/c.ts")).toBe("c.ts");
    expect(fileBasename("C:\\a\\b\\c.ts")).toBe("c.ts");
    expect(fileBasename("c.ts")).toBe("c.ts");
  });
});

describe("isSameOrDescendant", () => {
  it("matches self and children, not sibling prefixes", () => {
    expect(isSameOrDescendant("/proj/src", "/proj/src")).toBe(true);
    expect(isSameOrDescendant("/proj/src/a", "/proj/src")).toBe(true);
    expect(isSameOrDescendant("/proj/src2", "/proj/src")).toBe(false);
    expect(isSameOrDescendant("C:\\proj\\src\\a", "C:\\proj\\src")).toBe(true);
  });
});

describe("relativeToProject", () => {
  it("returns project-relative path when under root", () => {
    expect(relativeToProject("/proj/src/a.ts", "/proj")).toBe("src/a.ts");
    expect(relativeToProject("C:\\proj\\src\\a.ts", "C:\\proj")).toBe("src/a.ts");
  });

  it("falls back to absolute when no root or outside root", () => {
    expect(relativeToProject("/other/a.ts", "/proj")).toBe("/other/a.ts");
    expect(relativeToProject("/proj/a.ts", null)).toBe("/proj/a.ts");
  });
});
