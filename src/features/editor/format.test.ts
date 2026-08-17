/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from "vitest";

const prettierFormat = vi.fn(async (text: string, _options?: unknown) => text);
const rustFormat = vi.fn(async (text: string, _options?: unknown) => text);
const goFormat = vi.fn((text: string) => text);
const pythonFormat = vi.fn((text: string, _filename?: string) => text);

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
vi.mock("prettier-plugin-sh", () => ({ default: {} }));
vi.mock("prettier-plugin-toml", () => ({ default: {} }));
vi.mock("prettier-plugin-sql", () => ({ default: {} }));
vi.mock("@scalar/rust-fmt", () => ({ format: (text: string, options?: unknown) => rustFormat(text, options) }));
vi.mock("@wasm-fmt/gofmt", () => ({ format: (text: string) => goFormat(text) }));
vi.mock("@wasm-fmt/ruff_fmt", () => ({ format: (text: string, filename: string) => pythonFormat(text, filename) }));

import { canFormatPath, formatParserForPath, formatTextForPath } from "./format";

describe("editor format helpers", () => {
  it("maps common source files to formatter ids/parsers", () => {
    expect(formatParserForPath("/p/a.ts")).toBe("typescript");
    expect(formatParserForPath("/p/a.js")).toBe("babel");
    expect(formatParserForPath("/p/a.json")).toBe("json");
    expect(formatParserForPath("/p/a.jsonc")).toBe("json5");
    expect(formatParserForPath("/p/a.css")).toBe("css");
    expect(formatParserForPath("/p/a.html")).toBe("html");
    expect(formatParserForPath("/p/a.md")).toBe("markdown");
    expect(formatParserForPath("/p/a.yml")).toBe("yaml");
    expect(formatParserForPath("/p/a.sh")).toBe("sh");
    expect(formatParserForPath("/p/a.toml")).toBe("toml");
    expect(formatParserForPath("/p/a.sql")).toBe("sql");
    expect(formatParserForPath("/p/a.rs")).toBe("rust");
    expect(formatParserForPath("/p/a.go")).toBe("go");
    expect(formatParserForPath("/p/a.py")).toBe("python");
  });

  it("reports whether a path is formattable", () => {
    expect(canFormatPath("/p/a.ts")).toBe(true);
    expect(canFormatPath("/p/a.json")).toBe(true);
    expect(canFormatPath("/p/a.rs")).toBe(true);
    expect(canFormatPath("/p/a.go")).toBe(true);
    expect(canFormatPath("/p/a.py")).toBe(true);
    expect(canFormatPath("/p/a.txt")).toBe(false);
  });

  it("delegates TypeScript to prettier with the inferred parser", async () => {
    prettierFormat.mockResolvedValueOnce("const x = 1;\n");
    await expect(formatTextForPath("/p/a.ts", "const   x=1")).resolves.toBe("const x = 1;\n");
    expect(prettierFormat).toHaveBeenCalledWith(
      "const   x=1",
      expect.objectContaining({ parser: "typescript", filepath: "a.ts" }),
    );
  });

  it("delegates Rust/Go/Python to their wasm formatters", async () => {
    rustFormat.mockResolvedValueOnce("fn main() {}\n");
    goFormat.mockReturnValueOnce("package main\n");
    pythonFormat.mockReturnValueOnce("x = 1\n");

    await expect(formatTextForPath("/p/a.rs", "fn  main( ){}" )).resolves.toBe("fn main() {}\n");
    await expect(formatTextForPath("/p/a.go", "package main" )).resolves.toBe("package main\n");
    await expect(formatTextForPath("/p/a.py", "x=1" )).resolves.toBe("x = 1\n");

    expect(rustFormat).toHaveBeenCalled();
    expect(goFormat).toHaveBeenCalledWith("package main");
    expect(pythonFormat).toHaveBeenCalledWith("x=1", "a.py");
  });

  it("passes SQL dialect hints to prettier-plugin-sql", async () => {
    prettierFormat.mockResolvedValueOnce("SELECT *\nFROM users\n");
    await formatTextForPath("/p/a.pgsql", "select * from users");
    expect(prettierFormat).toHaveBeenCalledWith(
      "select * from users",
      expect.objectContaining({ parser: "sql", language: "postgresql" }),
    );
  });

  it("throws clearly for unsupported file types", async () => {
    await expect(formatTextForPath("/p/a.txt", "hello\n")).rejects.toThrow("暂不支持");
  });
});
