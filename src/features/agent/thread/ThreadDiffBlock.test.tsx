/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { ThreadDiffBlock } from "./ThreadDiffBlock";

vi.mock("../../../stores/settings.store", () => ({
  useSettingsStore: (sel: (s: { theme: "light" | "dark" }) => unknown) =>
    sel({ theme: "light" }),
}));

afterEach(() => cleanup());

describe("ThreadDiffBlock", () => {
  it("renders a CodeMirror merge view with path header", () => {
    const { container, getByText } = render(
      <ThreadDiffBlock
        path="src/foo.ts"
        oldText={"const a = 1;\n"}
        newText={"const a = 2;\n"}
      />,
    );
    expect(getByText("src/foo.ts")).toBeTruthy();
    expect(container.querySelector(".cm-editor")).toBeTruthy();
  });

  it("works without a path (no header)", () => {
    const { container, queryByText } = render(
      <ThreadDiffBlock oldText="a" newText="b" />,
    );
    expect(queryByText("src/foo.ts")).toBeNull();
    expect(container.querySelector(".cm-editor")).toBeTruthy();
  });
});
