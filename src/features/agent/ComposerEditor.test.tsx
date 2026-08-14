/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { ComposerEditor } from "./ComposerEditor";

afterEach(() => cleanup());

describe("ComposerEditor", () => {
  it("enables CodeMirror soft wrapping for long input", () => {
    const { container } = render(
      <ComposerEditor
        initialText={"x".repeat(2_000)}
        placeholder="描述任务"
        disabled={false}
        onChange={() => {}}
        onKeyDown={() => false}
        onPaste={() => {}}
      />,
    );

    const content = container.querySelector<HTMLElement>(".cm-content");
    expect(content?.classList.contains("cm-lineWrapping")).toBe(true);
  });
});
