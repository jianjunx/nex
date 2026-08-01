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
  // jsdom 默认没有 ResizeObserver;提供 no-op stub,渲染到就绪的用例不会因 new ResizeObserver 抛错。
  // 需要捕获回调的用例(M-1)可在其内部再次 stubGlobal 覆盖,afterEach 统一还原。
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
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** 构造仅高度有意义的 DOMRect(与 threadTestUtils 的 mock 形状一致)。 */
function rectWithHeight(h: number): DOMRect {
  return {
    x: 0, y: 0, top: 0, left: 0, width: 800, height: h, right: 800, bottom: h,
    toJSON() { return this; },
  } as DOMRect;
}

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

  it("就绪后 ResizeObserver 收敛写入缓存:同 key 回看占位复现缓存高度(M-1)", async () => {
    // 自定义 RO mock:记录每个实例及其观察的元素,测试里手动触发「观察 slot 的那个实例」
    // 的回调以模拟布局收敛。不能用单一全局 cb:CodeMirror 就绪后也会构造自己的 RO,
    // 单一 cb 会被 CM 实例覆盖,导致组件的写入回调永远不被触发(缓存静默失效的缩影)。
    type RoLike = { cb: () => void; els: Set<Element> };
    const roInstances: RoLike[] = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        cb: () => void;
        els = new Set<Element>();
        constructor(cb: () => void) {
          this.cb = cb;
          roInstances.push(this);
        }
        observe(el: Element) {
          this.els.add(el);
        }
        unobserve(el: Element) {
          this.els.delete(el);
        }
        disconnect() {
          this.els.clear();
        }
      },
    );
    // slot(就绪后含 .cm-editor 的包裹 div)固定返回 123;其余元素 0,不干扰 CM 内部测量。
    const gBCR = vi
      .spyOn(Element.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: Element) {
        return rectWithHeight(this.querySelector(".cm-editor") ? 123 : 0);
      });

    const key = "t:cache-roundtrip";
    const oldText = linesText(3);
    const newText = linesText(3);

    const first = render(
      <ThreadDiffBlock cacheKey={key} oldText={oldText} newText={newText} />,
    );
    // 占位阶段:缓存未命中 → 走预估(3 行 = 54px)。
    const firstPlaceholder = first.container.querySelector<HTMLElement>('[aria-hidden="true"]');
    expect(firstPlaceholder!.style.minHeight).toBe("54px");

    await flushMountDelay(); // ready → 组件 useEffect 建 RO 并 observe slot

    // 无 path 时根 div 唯一子节点即 slot;组件的 RO 观察的是它(CM 的 RO 观察 .cm-editor 内部元素)。
    const slotEl = first.container.firstElementChild!.lastElementChild as HTMLElement;
    const componentRo = roInstances.find((ro) => ro.els.has(slotEl));
    expect(componentRo).toBeTruthy();

    act(() => {
      componentRo!.cb(); // 模拟布局收敛触发 → 写入 diffHeights(123)
    });
    first.unmount(); // cleanup 断开 RO
    gBCR.mockRestore();

    // 同 key 回看:占位应命中缓存复现 123px,而非预估 54px。
    // 该断言对「缓存静默失效」有区分力:写入路径坏了则回落到 54px,断言失败。
    const second = render(
      <ThreadDiffBlock cacheKey={key} oldText={oldText} newText={newText} />,
    );
    const secondPlaceholder = second.container.querySelector<HTMLElement>('[aria-hidden="true"]');
    expect(secondPlaceholder).toBeTruthy();
    expect(secondPlaceholder!.style.minHeight).toBe("123px");
    second.unmount();
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
