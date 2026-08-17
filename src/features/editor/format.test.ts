/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from "vitest";

const prettierFormat = vi.fn(async (text: string, _options?: unknown) => text);
vi.mock("prettier/standalone", () => ({
  default: { format: (text: string, options: unknown) => prettierFormat(text, options) },
  format: (text: string, options: unknown) => prettierFormat(text, options),
}));
vi.mock("prettier/plugins/estree", () => ({}));
vi.mock("prettier/plugins/babel", () => ({}));
vi.mock("prettier/plugins/typescript", () => ({}));
vi.mock("prettier/plugins/html", () => ({}));
vi.mock("prettier/plugins/markdown", () => ({}));
vi.mock("prettier/plugins/postcss", () => ({}));
vi.mock("prettier/plugins/yaml", () => ({}));

import { canFormatPath, formatParserForPath, formatTextForPath } from "./format";

describe("editor format helpers", () => {
  it("maps common source files to prettier parsers", () => {
    expect(formatParserForPath("/p/a.ts")).toBe("typescript");
    expect(formatParserForPath("/p/a.js")).toBe("babel");
    expect(formatParserForPath("/p/a.json")).toBe("json");
    expect(formatParserForPath("/p/a.jsonc")).toBe("json5");
    expect(formatParserForPath("/p/a.css")).toBe("css");
    expect(formatParserForPath("/p/a.html")).toBe("html");
    expect(formatParserForPath("/p/a.md")).toBe("markdown");
    expect(formatParserForPath("/p/a.yml")).toBe("yaml");
    expect(formatParserForPath("/p/a.rs")).toBeNull();
  });

  it("reports whether a path is formattable", () => {
    expect(canFormatPath("/p/a.ts")).toBe(true);
    expect(canFormatPath("/p/a.json")).toBe(true);
    expect(canFormatPath("/p/a.rs")).toBe(false);
  });

  it("delegates to prettier with the inferred parser", async () => {
    prettierFormat.mockResolvedValueOnce("const x = 1;\n");
    await expect(formatTextForPath("/p/a.ts", "const   x=1")).resolves.toBe("const x = 1;\n");
    expect(prettierFormat).toHaveBeenCalledWith(
      "const   x=1",
      expect.objectContaining({ parser: "typescript", filepath: "a.ts" }),
    );
  });

  it("throws clearly for unsupported file types", async () => {
    await expect(formatTextForPath("/p/a.rs", "fn main() {}\n")).rejects.toThrow("暂不支持");
  });
});
