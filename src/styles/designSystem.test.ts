import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(dir, entry.name);
    return entry.isDirectory()
      ? sources(path)
      : entry.name.endsWith(".tsx") && !entry.name.includes(".test.")
        ? [path]
        : [];
  });
}
it("business UI cannot reintroduce glass aliases, inset highlights or blur", () => {
  for (const file of [
    ...sources(resolve("src/features")),
    ...sources(resolve("src/components/ui")),
  ]) {
    const source = readFileSync(file, "utf8");
    expect(source, file).not.toMatch(
      /--glass-[\w-]+|shadow-\[inset|backdrop-blur-/,
    );
  }
});
it("shared theme uses neutral surfaces with no backdrop blur recipes", () => {
  const css = readFileSync(resolve("src/styles/globals.css"), "utf8");
  expect(css).not.toMatch(/--glass-[\w-]+|backdrop-filter:\s*blur/);
  expect(css).toContain("--primary: var(--text-primary)");
  expect(css).toContain("--material-panel: #ffffff");
  expect(css).toContain("prefers-contrast: more");
  expect(css).toContain("prefers-reduced-motion: reduce");
});
