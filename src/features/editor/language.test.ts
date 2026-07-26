import { describe, expect, it } from "vitest";
import { languageExtensionsForPath } from "./language";

describe("languageExtensionsForPath", () => {
  it("returns a non-empty extension array for known types", () => {
    expect(languageExtensionsForPath("a.ts").length).toBeGreaterThan(0);
    expect(languageExtensionsForPath("a.py").length).toBeGreaterThan(0);
    expect(languageExtensionsForPath("a.rs").length).toBeGreaterThan(0);
    expect(languageExtensionsForPath("a.sh").length).toBeGreaterThan(0);
  });

  it("returns empty for unknown extensions", () => {
    expect(languageExtensionsForPath("a.unknownext")).toEqual([]);
  });
});
