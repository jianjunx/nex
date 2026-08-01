/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";

vi.mock("../../../bridge/tauri", () => ({
  agentCreateSession: vi.fn(),
  agentSendPrompt: vi.fn(),
  agentCancel: vi.fn(),
  agentRespondPermission: vi.fn(),
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
  onAgentNotification: () => Promise.resolve(() => {}),
  onAgentPermissionRequest: () => Promise.resolve(() => {}),
  onAgentSessionTerminated: () => Promise.resolve(() => {}),
  conversationCreate: vi.fn(),
  conversationList: vi.fn().mockResolvedValue([]),
  conversationGetMessages: vi.fn().mockResolvedValue([]),
  conversationUpdateTitle: vi.fn(),
  conversationAppendMessage: vi.fn(),
  projectOpen: vi.fn(),
  projectList: vi.fn().mockResolvedValue([]),
}));

import { ThreadView } from "./ThreadView";
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
});
