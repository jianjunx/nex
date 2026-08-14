/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";

vi.mock("../../../bridge/tauri", () => ({
  agentCreateSession: vi.fn(),
  agentSendPrompt: vi.fn().mockResolvedValue({ hadMutations: false }),
  agentCancel: vi.fn(),
  agentRespondPermission: vi.fn(),
  agentRespondPlan: vi.fn(),
  agentRespondAskQuestion: vi.fn(),
  agentCloseSession: vi.fn(),
  agentListServers: vi.fn().mockResolvedValue([]),
  agentListAllServers: vi.fn().mockResolvedValue([]),
  agentRefreshRegistry: vi.fn(),
  agentCustomUpsert: vi.fn(),
  agentCustomDelete: vi.fn(),
  agentSetSessionMode: vi.fn(),
  agentSetSessionModel: vi.fn(),
  agentSetSessionConfigOption: vi.fn(),
  conversationReplaceThreadEntries: vi.fn(),
  nativeAgentGetConfig: vi.fn().mockResolvedValue({
    providers: [],
    agent: { maxSteps: 0, contextWindow: 0, bashTimeoutSecs: 120, maxSubagentConcurrency: 6, autoReview: false },
  }),
  onAgentNotification: () => Promise.resolve(() => {}),
  onAgentPermissionRequest: () => Promise.resolve(() => {}),
  onAgentPlanApprovalRequest: () => Promise.resolve(() => {}),
  onAgentAskQuestionRequest: () => Promise.resolve(() => {}),
  onAgentSessionTerminated: () => Promise.resolve(() => {}),
  conversationCreate: vi.fn(),
  conversationList: vi.fn().mockResolvedValue([]),
  conversationGetMessages: vi.fn().mockResolvedValue([]),
  conversationUpdateTitle: vi.fn(),
  conversationAppendMessage: vi.fn(),
  projectOpen: vi.fn(),
  projectList: vi.fn().mockResolvedValue([]),
}));

import { extractPinnedRange, ThreadView } from "./ThreadView";
import { useAgentStore } from "../../../stores/agent.store";
import { useConversationStore } from "../../../stores/conversation.store";
import {
  getScroller,
  installVirtualListMocks,
  makeEntries,
  setMockScrollHeight,
  setupThreadStores,
} from "./threadTestUtils";

beforeEach(() => {
  installVirtualListMocks();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ThreadView 虚拟化", () => {
  it("1000 条 entries 只渲染视口附近的行(DOM 行数 < 60)", () => {
    setupThreadStores("A", { A: makeEntries(1000) });
    const { container } = render(<ThreadView />);
    const scroller = getScroller(container);
    setMockScrollHeight(scroller, 1000 * 60);

    // 虚拟化后行元素带 data-index;未虚拟化时退而统计内容区实际渲染的子节点数
    // (即全量行数)。两种阶段统计口径不同,但窗口化冒烟断言一致:行数 < 60。
    const virtualRows = container.querySelectorAll("[data-index]");
    const renderedRows =
      virtualRows.length > 0 ? virtualRows.length : (scroller.firstElementChild?.children.length ?? 0);

    expect(renderedRows).toBeGreaterThan(0);
    expect(renderedRows).toBeLessThan(60); // 视口 10 行 + overscan 5×2,远小于 1000
  });

  it("跟随态:追加条目后自动滚动到底部", async () => {
    setupThreadStores("A", { A: makeEntries(100) });
    const { container } = render(<ThreadView />);
    const scroller = getScroller(container);
    setMockScrollHeight(scroller, 100 * 60);
    await act(async () => {}); // 让挂载后的测量/滚动 settle

    act(() => {
      useAgentStore.setState((s) => {
        s.entriesByConversation["A"] = [
          ...(s.entriesByConversation["A"] ?? []),
          { id: "new1", kind: "user_message", text: "新消息", timestamp: 999 },
        ];
      });
    });
    await act(async () => {});

    // 101 行 × 60px − 视口 600px ≈ 5460;断言已滚到靠近底部
    expect(scroller.scrollTop).toBeGreaterThan(4000);
  });

  it("跟随态会滚到实际滚动容器底部，包含上下内边距", async () => {
    setupThreadStores("A", { A: makeEntries(100) });
    const { container } = render(<ThreadView />);
    const scroller = getScroller(container);
    // ThreadView 的滚动容器有 py-3，真实 scrollHeight 比虚拟列表高 24px。
    setMockScrollHeight(scroller, 100 * 60 + 24);
    await act(async () => {});

    // 在条目追加前同步浏览器会在下一帧报告的实际滚动高度。
    setMockScrollHeight(scroller, 101 * 60 + 24);
    act(() => {
      useAgentStore.setState((s) => {
        s.entriesByConversation["A"] = [
          ...(s.entriesByConversation["A"] ?? []),
          {
            id: "new-tail",
            kind: "assistant_message",
            chunks: [{ type: "message", text: "新回复" }],
            timestamp: 999,
          },
        ];
      });
    });
    await act(async () => {});

    expect(scroller.scrollTop).toBe(scroller.scrollHeight - scroller.clientHeight);
  });

  it("上滚超过 80px 后取消跟随,新条目不再拉回底部", async () => {
    setupThreadStores("A", { A: makeEntries(100) });
    const { container } = render(<ThreadView />);
    const scroller = getScroller(container);
    setMockScrollHeight(scroller, 100 * 60);
    await act(async () => {});

    scroller.scrollTop = 0; // 手动到顶
    act(() => {
      scroller.dispatchEvent(new Event("scroll"));
    });

    // 追加非 user 条目(助手消息):上滚取消跟随后,这类条目不应把视图拉回底部。
    // 注意:不能追加 user_message——发送新消息是显式回底语义(见下方用例),二者故意分开。
    act(() => {
      useAgentStore.setState((s) => {
        s.entriesByConversation["A"] = [
          ...(s.entriesByConversation["A"] ?? []),
          {
            id: "new1",
            kind: "assistant_message",
            chunks: [{ type: "message", text: "新回复" }],
            timestamp: 999,
          },
        ];
      });
    });
    await act(async () => {});

    expect(scroller.scrollTop).toBe(0);
  });

  it("上滚取消跟随后追加 user_message 应回底(发送即回底)", async () => {
    setupThreadStores("A", { A: makeEntries(100) });
    const { container } = render(<ThreadView />);
    const scroller = getScroller(container);
    setMockScrollHeight(scroller, 100 * 60);
    await act(async () => {});

    // 上滚到顶(距底 5400px > 80)并触发 onScroll → 取消跟随,此刻不贴底
    scroller.scrollTop = 0;
    act(() => {
      scroller.dispatchEvent(new Event("scroll"));
    });
    expect(scroller.scrollTop).toBe(0);

    // 追加一条 user_message:发送新消息应强制恢复跟随并在 effect 内立即回底,
    // 不依赖后续 count/totalSize 再变化触发的 follow effect。
    act(() => {
      useAgentStore.setState((s) => {
        s.entriesByConversation["A"] = [
          ...(s.entriesByConversation["A"] ?? []),
          { id: "new1", kind: "user_message", text: "新消息", timestamp: 999 },
        ];
      });
    });
    await act(async () => {});

    // 101 行 × 60px − 视口 600px ≈ 5460;断言已回底(与跟随用例同口径)
    expect(scroller.scrollTop).toBeGreaterThan(4000);
  });

  it("切换会话后恢复跟随并滚动到新会话底部", async () => {
    setupThreadStores("A", { A: makeEntries(100), B: makeEntries(50) });
    const { container } = render(<ThreadView />);
    const scroller = getScroller(container);
    setMockScrollHeight(scroller, 100 * 60);
    await act(async () => {});

    scroller.scrollTop = 0;
    act(() => {
      scroller.dispatchEvent(new Event("scroll"));
    });

    act(() => {
      useConversationStore.setState((s) => {
        s.activeTabByProject = { p1: "B" };
      });
    });
    await act(async () => {});

    expect(scroller.scrollTop).toBeGreaterThan(0); // B:50×60−600=2400
  });

  it("滚动后只吸顶一条已滚过顶部的用户消息", async () => {
    setupThreadStores("A", { A: makeEntries(40) });
    const { container } = render(<ThreadView />);
    const scroller = getScroller(container);
    setMockScrollHeight(scroller, 40 * 60);
    await act(async () => {});

    scroller.scrollTop = 200;
    act(() => {
      scroller.dispatchEvent(new Event("scroll"));
    });

    const pinned = container.querySelectorAll("[data-sticky-user-message]");
    expect(pinned).toHaveLength(1);
    expect(pinned[0].getAttribute("data-sticky-user-message")).toBe("e2");
  });

  it("在列表顶部时不吸顶", async () => {
    setupThreadStores("A", { A: makeEntries(40) });
    const { container } = render(<ThreadView />);
    const scroller = getScroller(container);
    setMockScrollHeight(scroller, 40 * 60);
    await act(async () => {});

    scroller.scrollTop = 0;
    act(() => {
      scroller.dispatchEvent(new Event("scroll"));
    });

    expect(container.querySelector("[data-sticky-user-message]")).toBeNull();
  });

  it("第一条短消息从顶部开始且列表高度不超过视口", async () => {
    setupThreadStores("A", {
      A: [{ id: "u1", kind: "user_message", text: "git status", timestamp: 1 }],
    });
    const { container } = render(<ThreadView />);
    await act(async () => {});
    const scroller = getScroller(container);
    const inner = scroller.firstElementChild as HTMLElement;
    const h = parseFloat(inner.style.height || "0");
    expect(h).toBeGreaterThan(0);
    expect(h).toBeLessThan(600);
    const rows = [...scroller.querySelectorAll<HTMLElement>("[data-index]")];
    expect(rows.length).toBeGreaterThan(0);
    const y = Number(/translateY\(([-\d.]+)px\)/.exec(rows[0]!.style.transform)?.[1] ?? 0);
    expect(y).toBeLessThan(8);
  });

  it("从长会话切到只有一条消息的会话时列表高度回落到视口内", async () => {
    setupThreadStores("A", {
      A: makeEntries(80),
      B: [{ id: "u1", kind: "user_message", text: "git status", timestamp: 1 }],
    });
    const { container } = render(<ThreadView />);
    const scroller = getScroller(container);
    setMockScrollHeight(scroller, 80 * 60);
    await act(async () => {});

    act(() => {
      useConversationStore.setState((s) => {
        s.activeTabByProject = { p1: "B" };
      });
    });
    await act(async () => {});

    const inner = scroller.firstElementChild as HTMLElement;
    const h = parseFloat(inner.style.height || "0");
    expect(h).toBeGreaterThan(0);
    expect(h).toBeLessThan(600);
    const rows = [...scroller.querySelectorAll<HTMLElement>("[data-index]")];
    const y = Number(/translateY\(([-\d.]+)px\)/.exec(rows[0]!.style.transform)?.[1] ?? 0);
    expect(y).toBeLessThan(8);
  });

  it("从已吸顶的长会话切到短会话时不崩溃且行 key 唯一", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    setupThreadStores("A", {
      A: makeEntries(40),
      B: [{ id: "u1", kind: "user_message", text: "git status", timestamp: 1 }],
    });
    const { container } = render(<ThreadView />);
    const scroller = getScroller(container);
    setMockScrollHeight(scroller, 40 * 60);
    await act(async () => {});

    scroller.scrollTop = 200;
    act(() => {
      scroller.dispatchEvent(new Event("scroll"));
    });
    expect(container.querySelector("[data-sticky-user-message]")).not.toBeNull();

    expect(() => {
      act(() => {
        useConversationStore.setState((s) => {
          s.activeTabByProject = { p1: "B" };
        });
      });
    }).not.toThrow();
    await act(async () => {});

    const indexes = [...container.querySelectorAll("[data-index]")].map((el) =>
      el.getAttribute("data-index"),
    );
    expect(new Set(indexes).size).toBe(indexes.length);
    expect(consoleError.mock.calls.some((c) => String(c[0]).includes("same key"))).toBe(false);
    consoleError.mockRestore();
  });
});

describe("extractPinnedRange", () => {
  const range = { startIndex: 10, endIndex: 20, overscan: 5, count: 40 };

  it("吸顶行已在 overscan 窗口内时不重复 prepend", () => {
    const indexes = extractPinnedRange(range, 7);
    expect(indexes.filter((i) => i === 7)).toHaveLength(1);
    expect(indexes[0]).toBe(5);
  });

  it("吸顶行超出 count 时忽略,避免 measurements 空洞", () => {
    expect(extractPinnedRange(range, 80)).toEqual(extractPinnedRange(range, null));
    expect(extractPinnedRange({ ...range, count: 8 }, 20).every((i) => i < 8)).toBe(true);
  });

  it("吸顶行在窗口外时只 prepend 一次", () => {
    const indexes = extractPinnedRange(range, 2);
    expect(indexes[0]).toBe(2);
    expect(indexes.filter((i) => i === 2)).toHaveLength(1);
  });
});
