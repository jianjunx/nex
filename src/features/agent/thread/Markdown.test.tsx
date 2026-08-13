/**
 * @vitest-environment jsdom
 */
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Markdown } from "./Markdown";

vi.mock("../../../stores/settings.store", () => ({
  useSettingsStore: (sel: (s: { theme: "light" | "dark" }) => unknown) =>
    sel({ theme: "dark" }),
}));

// Mermaid pulls in DOM access (DOMPurify, layout) we don't need for these
// parser-level tests — stub it out and assert our renderer is *invoked*
// with the expected fenced code rather than asserting SVG output (which
// would require a fuller jsdom + happy-dom setup).
vi.mock("./MermaidBlock", () => ({
  MermaidBlock: ({ code }: { code: string }) => (
    <div data-testid="mermaid-stub" data-code={code} />
  ),
}));

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Markdown", () => {
  it("renders a GFM table with proper structure (not literal pipes)", () => {
    const src = [
      "| 检查项 | 结果 | 备注 |",
      "| --- | --- | --- |",
      "| 行 1 | OK | — |",
      "| 行 2 | FAIL | 重试 |",
    ].join("\n");
    const { container } = render(<Markdown>{src}</Markdown>);

    const table = container.querySelector("table");
    expect(table).not.toBeNull();
    expect(container.querySelector("thead th")).not.toBeNull();
    expect(container.querySelectorAll("tbody tr").length).toBe(2);
    expect(container.querySelectorAll("tbody td").length).toBe(6);

    // No raw pipe characters rendered as text outside of cell boundaries —
    // pipe literally inside <td> is fine, but the markdown separator row
    // (`| --- |`) should not produce a literal "| ---" anywhere.
    expect(container.textContent).not.toMatch(/\|\s*---/);
  });

  it("wraps the table in a rounded frame without a filled surface", () => {
    const src = [
      "| a | b |",
      "| --- | --- |",
      "| 1 | 2 |",
    ].join("\n");
    const { container } = render(<Markdown>{src}</Markdown>);

    const wrapper = container.querySelector("table")?.parentElement;
    expect(wrapper?.className).toMatch(/rounded-/);
    expect(wrapper?.className).toMatch(/border/);
    expect(wrapper?.className).toMatch(/bg-transparent/);
    expect(wrapper?.className).not.toMatch(/glass-3-surface/);

    const th = container.querySelector("thead th");
    expect(th?.className).toMatch(/border-b/);

    const td = container.querySelector("tbody td");
    expect(td?.className).toMatch(/border-b/);

    const row = container.querySelector("tbody tr");
    expect(row?.className).toMatch(/transition-colors/);
    expect(row?.className).toMatch(/hover:/);
    expect(row?.className).not.toMatch(/bg-\[var\(--glass/);
  });

  it("renders fenced code blocks with rehype-highlight token classes", async () => {
    const src = "```ts\nconst greeting: string = \"hi\";\n```";
    const { container } = render(<Markdown>{src}</Markdown>);

    await waitFor(() => {
      const code = container.querySelector("pre code");
      expect(code).not.toBeNull();
      // rehype-highlight should attach language class.
      expect(code!.className).toMatch(/language-ts/);
      // At least one token span should be present.
      expect(container.querySelector("pre code .hljs-keyword")).not.toBeNull();
    });
  });

  it("shows a language label chip on fenced code blocks", () => {
    const src = "```python\ndef hi(): pass\n```";
    const { container } = render(<Markdown>{src}</Markdown>);

    // Language label is rendered as a sibling span of <pre>; look for any
    // node containing the language word in upper-case form.
    const label = Array.from(container.querySelectorAll("span")).find(
      (el) => el.textContent?.trim().toLowerCase() === "python",
    );
    expect(label).not.toBeUndefined();
    expect(label!.className).toMatch(/uppercase/);
  });

  it("routes ```mermaid blocks to MermaidBlock instead of raw code", async () => {
    const src = "```mermaid\ngraph TD; A-->B;\n```";
    const { container } = render(<Markdown>{src}</Markdown>);

    await waitFor(() => {
      const stub = container.querySelector('[data-testid="mermaid-stub"]');
      expect(stub).not.toBeNull();
      expect(stub!.getAttribute("data-code")).toContain("graph TD; A-->B;");
    });
    // Sanity: no <pre><code> wrapper for the mermaid block.
    expect(container.querySelector("pre code.language-mermaid")).toBeNull();
  });

  it("renders inline code as a chip, not a code block", () => {
    const { container } = render(<Markdown>Use `npm install` first.</Markdown>);
    // Inline <code> directly inside <p>, not wrapped in <pre>.
    const code = container.querySelector("p code");
    expect(code).not.toBeNull();
    expect(container.querySelector("pre code")).toBeNull();
    expect(code!.textContent).toBe("npm install");
  });

  it("opens links with target=_blank and rel=noopener noreferrer", () => {
    const { container } = render(
      <Markdown>See [docs](https://example.com).</Markdown>,
    );
    const a = container.querySelector("a");
    expect(a).not.toBeNull();
    expect(a!.getAttribute("target")).toBe("_blank");
    expect(a!.getAttribute("rel")).toBe("noopener noreferrer");
    expect(a!.getAttribute("href")).toBe("https://example.com");
    // Links should be visually anchored (no surprise hover-only underline).
    expect(a!.className).toMatch(/underline/);
  });

  it("renders a blockquote with the accent left border", () => {
    const { container } = render(<Markdown>{"> note from the agent"}</Markdown>);
    const bq = container.querySelector("blockquote");
    expect(bq).not.toBeNull();
    // Class wiring goes through the component map; assert it has the
    // expected border-l-2 utility (Tailwind compiled).
    expect(bq!.className).toMatch(/border-l-/);
  });

  it("renders GFM task list items with a checkbox input", () => {
    const { container } = render(
      <Markdown>{`- [x] done\n- [ ] todo`}</Markdown>,
    );
    const boxes = container.querySelectorAll('li input[type="checkbox"]');
    expect(boxes.length).toBe(2);
    expect((boxes[0] as HTMLInputElement).checked).toBe(true);
    expect((boxes[1] as HTMLInputElement).checked).toBe(false);
  });

  it("renders strikethrough with a destructive-color underline", () => {
    const { container } = render(<Markdown>~~old~~ new</Markdown>);
    const del = container.querySelector("del");
    expect(del).not.toBeNull();
    expect(del!.className).toMatch(/line-through/);
    expect(del!.className).toMatch(/destructive/);
  });

  it("renders an h1 with a bottom border to anchor the heading", () => {
    const { container } = render(<Markdown>{"# Title"}</Markdown>);
    const h1 = container.querySelector("h1");
    expect(h1).not.toBeNull();
    expect(h1!.className).toMatch(/border-b/);
  });
});
