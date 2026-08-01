/**
 * @vitest-environment jsdom
 */
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThreadDiffBlock } from "./ThreadDiffBlock";

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

describe("ThreadDiffBlock", () => {
  it("延迟后渲染 CodeMirror merge 视图与路径头", async () => {
    const { container, getByText } = render(
      <ThreadDiffBlock path="src/foo.ts" oldText={"const a = 1;\n"} newText={"const a = 2;\n"} />,
    );
    expect(getByText("src/foo.ts")).toBeTruthy();
    expect(container.querySelector(".cm-editor")).toBeNull(); // 占位阶段

    await flushMountDelay();
    expect(container.querySelector(".cm-editor")).toBeTruthy();
  });

  it("无 path 时不渲染头部(延迟后编辑器照常出现)", async () => {
    const { container, queryByText } = render(<ThreadDiffBlock oldText="a" newText="b" />);
    expect(queryByText("src/foo.ts")).toBeNull();
    await flushMountDelay();
    expect(container.querySelector(".cm-editor")).toBeTruthy();
  });

  it("延迟期内卸载则不挂载编辑器且不报错", () => {
    const { container, unmount } = render(<ThreadDiffBlock oldText="a" newText="b" />);
    expect(container.querySelector(".cm-editor")).toBeNull();
    unmount();
    expect(() => act(() => { vi.advanceTimersByTime(150); })).not.toThrow();
  });
});
