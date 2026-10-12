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
/** Drop CSS comments so assertions inspect rules, not prose about them. */
function withoutComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}
it("keeps the CSS spinner's gap above the .beautiful-ui border-color shorthand", () => {
  // Beautiful UI 的转圈指示器是 `border border-current border-t-transparent`
  // 画出的弧。styles.css 把颜色工具按 `.beautiful-ui .border-current
  // { border-color }` 的作用域重发了一遍——两条规则同在 @layer utilities，
  // 而它多一个类、特异性 (0,2,0) 压过主包的 `.border-t-transparent`
  // (0,1,0)。border-color 是简写，会把四条边一起刷掉，缺口消失、弧退化成
  // 整圈。agent-ui.css 不带 @layer，未分层样式压过所有层，补这条同名校正即可。
  const css = withoutComments(readFileSync(resolve("src/styles/agent-ui.css"), "utf8"));
  expect(css).toMatch(/\.border-t-transparent\s*\{\s*border-top-color:\s*transparent;\s*\}/);
  // 未分层是这条校正能赢过高特异性规则的前提
  expect(css).not.toContain("@layer");
});
