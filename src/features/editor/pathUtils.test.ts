import { describe, expect, it } from "vitest";
import { fileBasename, relativeToProject } from "./pathUtils";

describe("fileBasename", () => {
  it("handles posix and windows separators", () => {
    expect(fileBasename("/a/b/c.ts")).toBe("c.ts");
    expect(fileBasename("C:\\a\\b\\c.ts")).toBe("c.ts");
    expect(fileBasename("c.ts")).toBe("c.ts");
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
