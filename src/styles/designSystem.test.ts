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
it("suppresses the vendored accent focus ring on file-tree rows", () => {
  // 文件树行是 tabindex=0 的 div。vendored 快照里
  // `.beautiful-ui :focus-visible { outline: 2px solid var(--accent) }` 是未分层
  // 规则、(0,2,0)，而 globals.css 里 .outline-none 在 @layer utilities 内、
  // (0,1,0)——未分层永远赢过分层，与特异性无关，所以行上那个 outline-none
  // 从来没能生效，每按一次上下键都冒出一圈 2px 浅灰（--accent: #d4d4d4）边框。
  // agent-ui.css 同为未分层，用 (0,3,0) 覆盖回去；焦点可见性由随箭头移动的
  // 选中底色承担。
  const css = withoutComments(readFileSync(resolve("src/styles/agent-ui.css"), "utf8"));
  expect(css).toMatch(
    /\.beautiful-ui \[role="treeitem"\]:focus-visible\s*\{\s*outline:\s*none;?\s*\}/,
  );
  // 侧栏按钮走的是另一条中性细描边（(0,2,1) 压过 vendored 的 (0,2,0)），不能被误伤
  expect(css).toMatch(/\.beautiful-ui button:focus-visible\s*\{[^}]*outline:\s*1px solid/);
});
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
