/**
 * @vitest-environment jsdom
 */
import { Profiler } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";

vi.mock("../../../bridge/tauri", () => ({
  // agent.store 所需
  agentCreateSession: vi.fn(),
  agentSendPrompt: vi.fn(),
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
  onAgentNotification: () => Promise.resolve(() => {}),
  onAgentPermissionRequest: () => Promise.resolve(() => {}),
  onAgentPlanApprovalRequest: () => Promise.resolve(() => {}),
  onAgentAskQuestionRequest: () => Promise.resolve(() => {}),
  onAgentSessionTerminated: () => Promise.resolve(() => {}),
  // conversation.store 所需
  conversationCreate: vi.fn(),
  conversationList: vi.fn().mockResolvedValue([]),
  conversationGetMessages: vi.fn().mockResolvedValue([]),
  conversationUpdateTitle: vi.fn(),
  conversationAppendMessage: vi.fn(),
  // project.store 所需
  projectOpen: vi.fn(),
  projectList: vi.fn().mockResolvedValue([]),
}));

import { ThreadView } from "./ThreadView";
import { setupThreadStores } from "./threadTestUtils";
import { useAgentStore } from "../../../stores/agent.store";
import type { ThreadEntry } from "./types";

// jsdom 不提供 ResizeObserver;ThreadView 的贴底跟随 effect 需要它,以空实现打桩。
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("ResizeObserver", ResizeObserverStub);

beforeEach(() => {
  setupThreadStores("A", {
    A: [{ id: "a1", kind: "user_message", text: "hi", timestamp: 1 }],
    B: [{ id: "b1", kind: "user_message", text: "yo", timestamp: 2 }],
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ThreadView 订阅收窄", () => {
  it("后台会话的流式更新不触发前台 ThreadView 重渲染", async () => {
    const onRender = vi.fn();
    render(
      <Profiler id="thread" onRender={onRender}>
        <ThreadView />
      </Profiler>,
    );
    onRender.mockClear();

    act(() => {
      useAgentStore.setState((s) => {
        s.entriesByConversation["B"] = [
          ...(s.entriesByConversation["B"] ?? []),
          { id: "b2", kind: "user_message", text: "后台新增", timestamp: 3 } as ThreadEntry,
        ];
      });
    });

    expect(onRender).not.toHaveBeenCalled();
  });
});
