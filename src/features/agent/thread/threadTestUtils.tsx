/**
 * 线程视图的测试夹具。仅被 .test.tsx 引用,不进生产 bundle。
 * seedSyntheticThread 供手动压测时自行 import 灌入合成数据。
 */
import { vi } from "vitest";
import { useAgentStore } from "../../../stores/agent.store";
import { useProjectStore } from "../../../stores/project.store";
import { useConversationStore } from "../../../stores/conversation.store";
import type { ThreadEntry } from "./types";

/** 把 ThreadView 所需的三个 store 摆成"项目 p1、指定活动 tab、给定 entries"的状态。 */
export function setupThreadStores(
  activeTabId: string,
  entriesByConversation: Record<string, ThreadEntry[]>,
) {
  useProjectStore.setState({ activeProjectId: "p1" });
  useConversationStore.setState((s) => {
    s.tabsByProject = { p1: Object.keys(entriesByConversation) };
    s.activeTabByProject = { p1: activeTabId };
  });
  useAgentStore.setState((s) => {
    s.entriesByConversation = entriesByConversation;
  });
}

/* ---------- jsdom 布局 mock:让 useVirtualizer 在无真实布局环境下工作 ---------- */

const mockHeights = new WeakMap<Element, number>();
const mockScrollHeights = new WeakMap<Element, number>();
const mockScrollTops = new WeakMap<Element, number>();

export function setMockScrollHeight(el: Element, h: number) {
  mockScrollHeights.set(el, h);
}

/** 取 ThreadView 的滚动容器。 */
export function getScroller(container: HTMLElement): HTMLElement {
  const el = container.querySelector<HTMLElement>(".overflow-y-auto");
  if (!el) throw new Error("未找到 .overflow-y-auto 滚动容器");
  return el;
}

/**
 * 安装虚拟列表所需的布局 mock。规则:
 * - 带 data-index 的行元素 → rowHeight(默认 60)
 * - classList 含 overflow-y-auto 的滚动容器 → viewportHeight(默认 600)
 * - 显式 setMockScrollHeight 设置过的 → 该值
 * 若 @tanstack/virtual-core 版本的取数 API 与上述不符(用 scrollLeft/其他读法),
 * 调试方法:render 后打印 virtualizer.scrollRect / scrollOffset / range,
 * 看哪个读数为 0,再按 node_modules/@tanstack/virtual-core 源码调整本 mock。
 */
export function installVirtualListMocks(opts?: { viewportHeight?: number; rowHeight?: number }) {
  const viewportHeight = opts?.viewportHeight ?? 600;
  const rowHeight = opts?.rowHeight ?? 60;

  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );

  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (
    this: Element,
  ) {
    let h = mockHeights.get(this);
    if (h === undefined) {
      if (this instanceof HTMLElement && this.classList.contains("overflow-y-auto")) {
        h = viewportHeight;
      } else if (this.hasAttribute("data-index")) {
        h = rowHeight;
      } else {
        h = 0;
      }
    }
    return {
      x: 0, y: 0, top: 0, left: 0, width: 800, height: h, right: 800, bottom: h,
      toJSON() { return this; },
    } as DOMRect;
  });

  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return Math.round(this.getBoundingClientRect().height);
    },
  });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return Math.round(this.getBoundingClientRect().height);
    },
  });
  Object.defineProperty(Element.prototype, "scrollHeight", {
    configurable: true,
    get(this: Element) {
      return mockScrollHeights.get(this) ?? 0;
    },
  });
  Object.defineProperty(Element.prototype, "scrollTop", {
    configurable: true,
    get(this: Element) {
      return mockScrollTops.get(this) ?? 0;
    },
    set(this: Element, v: number) {
      mockScrollTops.set(this, v);
    },
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (Element.prototype as any).scrollTo = function (
    this: Element,
    xOrOpts: number | ScrollToOptions,
    y?: number,
  ) {
    const top = typeof xOrOpts === "number" ? (y ?? 0) : (xOrOpts?.top ?? 0);
    mockScrollTops.set(this, top);
  };
}

/** 生成交替的 user/assistant 合成条目。 */
export function makeEntries(count: number): ThreadEntry[] {
  return Array.from({ length: count }, (_, i) =>
    i % 2 === 0
      ? { id: `e${i}`, kind: "user_message", text: `消息 ${i}`, timestamp: i }
      : {
          id: `e${i}`,
          kind: "assistant_message",
          chunks: [{ type: "message", text: `回复 ${i}` }],
          timestamp: i,
        },
  ) as ThreadEntry[];
}

/**
 * 性能验证种子:2000 条 entries、约 1/6 为展开态 edit 卡(含真实 diff 文本)。
 * 用于 pnpm dev 下手动压测;留存为测试夹具。
 */
export function seedSyntheticThread(conversationId: string, count = 2000) {
  const oldText = "const a = 1;\n".repeat(40);
  const newText = "const a = 2;\n".repeat(40);
  const entries: ThreadEntry[] = Array.from({ length: count }, (_, i) => {
    if (i % 6 === 3) {
      return {
        id: `e${i}`, kind: "tool_call", toolCallId: `tc${i}`,
        title: `Edit file_${i}.ts`, toolKind: "edit", status: "completed",
        timestamp: i,
        content: [{ type: "diff", path: `src/file_${i}.ts`, oldText, newText }],
      };
    }
    if (i % 2 === 0) {
      return { id: `e${i}`, kind: "user_message", text: `用户消息 ${i}`, timestamp: i };
    }
    return {
      id: `e${i}`, kind: "assistant_message",
      chunks: [{ type: "message", text: `助手回复 ${i}\n\n一些内容。`.repeat(3) }],
      timestamp: i,
    };
  }) as ThreadEntry[];
  useAgentStore.getState().hydrateEntries(conversationId, entries);
}
