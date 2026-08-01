/**
 * @vitest-environment jsdom
 */
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThreadDiffBlock, estimateDiffHeight } from "./ThreadDiffBlock";

vi.mock("../../../stores/settings.store", () => ({
  useSettingsStore: (sel: (s: { theme: "light" | "dark" }) => unknown) =>
    sel({ theme: "light" }),
}));

beforeEach(() => {
  // 只 fake 计时器,保留 rAF(CodeMirror 需要)。
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

async function flushMountDelay() {
  await act(async () => {
    vi.advanceTimersByTime(150);
  });
}

/** 生成恰好 n 行的文本(无尾随空行,split("\n").length === n)。 */
function linesText(n: number): string {
  return Array.from({ length: n }, (_, i) => `line ${i}`).join("\n");
}

describe("ThreadDiffBlock", () => {
  it("延迟后渲染 CodeMirror merge 视图与路径头", async () => {
    const { container, getByText } = render(
      <ThreadDiffBlock
        cacheKey="t:path-header"
        path="src/foo.ts"
        oldText={"const a = 1;\n"}
        newText={"const a = 2;\n"}
      />,
    );
    expect(getByText("src/foo.ts")).toBeTruthy();
    expect(container.querySelector(".cm-editor")).toBeNull(); // 占位阶段

    await flushMountDelay();
    expect(container.querySelector(".cm-editor")).toBeTruthy();
  });

  it("无 path 时不渲染头部(延迟后编辑器照常出现)", async () => {
    const { container, queryByText } = render(
      <ThreadDiffBlock cacheKey="t:no-path" oldText="a" newText="b" />,
    );
    expect(queryByText("src/foo.ts")).toBeNull();
    await flushMountDelay();
    expect(container.querySelector(".cm-editor")).toBeTruthy();
  });

  it("延迟期内卸载则不挂载编辑器且不报错", () => {
    const { container, unmount } = render(
      <ThreadDiffBlock cacheKey="t:unmount" oldText="a" newText="b" />,
    );
    expect(container.querySelector(".cm-editor")).toBeNull();
    unmount();
    expect(() => act(() => { vi.advanceTimersByTime(150); })).not.toThrow();
  });

  it("首次渲染(未过延迟)占位高度按行数预估,而非固定 350", () => {
    const oldText = linesText(3);
    const newText = linesText(3);
    const { container } = render(
      <ThreadDiffBlock cacheKey="t:placeholder-estimate" oldText={oldText} newText={newText} />,
    );
    const placeholder = container.querySelector<HTMLElement>('[aria-hidden="true"]');
    expect(placeholder).toBeTruthy();
    // 3 行 → 3*18=54px(高于 FLOOR 48),验证占位走 estimateDiffHeight 而非旧固定值 350。
    expect(placeholder!.style.minHeight).toBe(`${estimateDiffHeight(oldText, newText)}px`);
    expect(placeholder!.style.minHeight).toBe("54px");
  });
});

describe("estimateDiffHeight", () => {
  it("40 行 diff 触发封顶 320", () => {
    expect(estimateDiffHeight(linesText(40), undefined)).toBe(320);
  });

  it("3 行 diff 预估为 54(3*18,高于下限)", () => {
    expect(estimateDiffHeight(linesText(3), undefined)).toBe(54);
  });

  it("空/undefined 文本回退到下限 48", () => {
    expect(estimateDiffHeight(undefined, undefined)).toBe(48);
    expect(estimateDiffHeight("", "")).toBe(48);
  });

  it("1 行 diff 低于下限,取底 48", () => {
    expect(estimateDiffHeight("x", undefined)).toBe(48);
  });
});
