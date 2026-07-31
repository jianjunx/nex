/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { DiffView, patchLineClasses } from "./DiffView";

afterEach(() => cleanup());

const base = {
  mode: "patch" as const,
  title: "提交 abc1234",
  languageHint: "",
  original: "",
  revised: "",
  binary: false,
};

describe("patchLineClasses", () => {
  it("classifies +/- lines and leaves context/header lines null", () => {
    expect(patchLineClasses("+a\n-b\n c\n@@ -1 +1 @@\ndiff --git x x")).toEqual([
      "add",
      "del",
      null,
      null,
      null,
    ]);
  });

  it("returns [null] for the empty string", () => {
    expect(patchLineClasses("")).toEqual([null]);
  });
});

describe("DiffView", () => {
  it("binary payload renders the placeholder and no editor", () => {
    const { container, getByText } = render(
      <DiffView payload={{ ...base, binary: true }} theme={[]} extensions={[]} />,
    );
    expect(getByText("二进制文件 — 无法显示文本差异")).toBeTruthy();
    expect(container.querySelector(".cm-editor")).toBeNull();
  });

  it("patch mode mounts a read-only editor containing the patch text", () => {
    const { container } = render(
      <DiffView payload={{ ...base, revised: "+v2\n-v1\n" }} theme={[]} extensions={[]} />,
    );
    expect(container.querySelector(".cm-editor")).toBeTruthy();
    expect(container.textContent).toContain("+v2");
  });

  it("merge mode mounts an editor for the revised document", () => {
    const { container } = render(
      <DiffView
        payload={{ ...base, mode: "merge", original: "v1", revised: "v2" }}
        theme={[]}
        extensions={[]}
      />,
    );
    expect(container.querySelector(".cm-editor")).toBeTruthy();
  });
});
