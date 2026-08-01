/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

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
});
