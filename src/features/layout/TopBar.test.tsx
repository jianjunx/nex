/**
 * @vitest-environment jsdom
 */
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

// TopBar 触碰 Tauri 窗口 API 与重子组件；全部打桩。NewConversationDropdown
// 保持真实（本文件同时覆盖 F5 轮廓与 F6 接线）。
// startDragging/toggleMaximize 用 hoisted spy，供空白区拖拽/双击断言。
const { startDraggingMock, toggleMaximizeMock } = vi.hoisted(() => ({
  startDraggingMock: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  toggleMaximizeMock: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    startDragging: () => startDraggingMock(),
    toggleMaximize: () => toggleMaximizeMock(),
    isFullscreen: () => Promise.resolve(false),
    onResized: () => Promise.resolve(() => {}),
  }),
}));
vi.mock("../projects/ProjectSelector", () => ({
  ProjectSelector: () => <div data-testid="project-selector" />,
}));
vi.mock("./WindowControls", () => ({ WindowControls: () => null }));
vi.mock("../agent/CloseTabConfirmDialog", () => ({
  CloseTabConfirmDialog: () => null,
}));

import { TopBar } from "./TopBar";
import { WorkspaceSidebar } from "./WorkspaceSidebar";
import { getCommand } from "../../commands/registry";
import { useProjectStore } from "../../stores/project.store";
import { useConversationStore } from "../../stores/conversation.store";
import { useAgentStore } from "../../stores/agent.store";
import { useUiStore } from "../../stores/ui.store";
import type {
  Conversation,
  ServerDescriptor,
  SessionTarget,
} from "../../bridge/tauri";

// mock 函数类型与真 store 的动作签名逐一对齐（tsc -b 门槛要求 setState
// 注入时 Mock<T> 可赋给具体动作类型）。
type CreateConversationFn = (
  projectId: string,
  agentType: string,
) => Promise<Conversation>;
type CreateSessionFn = (
  conversationId: string,
  target: SessionTarget,
  cwd: string,
) => Promise<string>;
type LoadAllServersFn = () => Promise<void>;
type RefreshRegistryFn = () => Promise<void>;

// 模块级可变 let 持有 mock action，beforeEach 经 setState 注入真 store。
let createConversationMock: Mock<CreateConversationFn>;
let createSessionMock: Mock<CreateSessionFn>;
let loadAllServersMock: Mock<LoadAllServersFn>;
let refreshRegistryMock: Mock<RefreshRegistryFn>;

const SERVER_CLAUDE: ServerDescriptor = {
  id: "claude-code",
  name: "Claude Code",
  version: "1.2.3",
  description: "Anthropic 的智能体",
  icon: null,
  kind: "registry",
};

// mock 的 createConversation 与真实动作的副作用逐一对齐（conversationsByProject.unshift
// + tabs.push + 激活）——TopBar 的页签标题从 conversationsByProject 解析，漏掉 unshift
// 会让标题回退成 tab id，"新对话"断言必挂。
const fakeCreateConversation = async (
  projectId: string,
  agentType: string,
): Promise<Conversation> => {
  const conv: Conversation = {
    id: "conv-1",
    project_id: projectId,
    title: "新对话",
    agent_type: agentType,
    status: "active",
    created_at: 0,
    updated_at: 0,
  };
  useConversationStore.setState((s) => {
    if (!s.conversationsByProject[projectId])
      s.conversationsByProject[projectId] = [];
    s.conversationsByProject[projectId].unshift(conv);
    const tabs = s.tabsByProject[projectId] ?? [];
    s.tabsByProject[projectId] = [...tabs, conv.id];
    s.activeTabByProject[projectId] = conv.id;
  });
  return conv;
};

beforeEach(() => {
  startDraggingMock.mockClear();
  toggleMaximizeMock.mockClear();
  createConversationMock = vi
    .fn<CreateConversationFn>()
    .mockImplementation(fakeCreateConversation);
  createSessionMock = vi.fn<CreateSessionFn>().mockResolvedValue("sess-1");
  loadAllServersMock = vi.fn<LoadAllServersFn>().mockResolvedValue(undefined);
  refreshRegistryMock = vi.fn<RefreshRegistryFn>().mockResolvedValue(undefined);

  useUiStore.setState({ newConversationOpen: false });
  useProjectStore.setState({
    projects: [
      {
        id: "p1",
        name: "demo",
        path: "/tmp/demo",
        created_at: 0,
        last_opened: 0,
      },
    ],
    activeProjectId: "p1",
  });
  useConversationStore.setState({
    conversationsByProject: {
      p1: [
        {
          id: "c1",
          project_id: "p1",
          title: "第一个会话",
          agent_type: "x",
          status: "active",
          created_at: 0,
          updated_at: 0,
        },
        {
          id: "c2",
          project_id: "p1",
          title: "第二个会话",
          agent_type: "x",
          status: "active",
          created_at: 0,
          updated_at: 0,
        },
      ],
    },
    tabsByProject: { p1: ["c1", "c2"] },
    activeTabByProject: { p1: "c1" },
  });
  useAgentStore.setState({
    servers: [SERVER_CLAUDE],
    serversLoading: false,
    serversLoadedAt: Date.now(),
    error: null,
    createSession: createSessionMock,
    loadAllServers: loadAllServersMock,
    refreshRegistry: refreshRegistryMock,
  });
  useConversationStore.setState({
    createConversation: createConversationMock,
  });
});
afterEach(() => cleanup());

describe("compact toolbar", () => {
  it("removes project picker and tabs from the top bar", () => {
    render(<TopBar />);
    expect(screen.queryByRole("tab")).toBeNull();
    expect(screen.queryByTestId("project-selector")).toBeNull();
    expect(screen.getByRole("toolbar", { name: "工作区工具" })).toBeTruthy();
  });
  it("toggles and switches side panels", () => {
    useUiStore.setState({ sidePanelVisible: false });
    render(<TopBar />);
    fireEvent.click(screen.getByRole("button", { name: "文件" }));
    expect(useUiStore.getState().sidePanelVisible).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "搜索" }));
    expect(useUiStore.getState().sidePanelTab).toBe("search");
    fireEvent.click(screen.getByRole("button", { name: "搜索" }));
    expect(useUiStore.getState().sidePanelVisible).toBe(false);
  });
});

describe("blank-area window controls", () => {
  it("single mousedown on blank area starts window drag", () => {
    vi.useFakeTimers({ now: 1000 });
    try {
      const { container } = render(<TopBar />);
      fireEvent.mouseDown(container.firstElementChild!, {
        screenX: 100,
        screenY: 20,
      });
      expect(startDraggingMock).toHaveBeenCalledTimes(1);
      expect(toggleMaximizeMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  // Windows 上 startDragging 吞掉 dblclick 事件，双击必须靠 mousedown
  // 计时检测：500ms 内、位置基本不动的第二次按下 → toggleMaximize，
  // 且不再触发第二次拖拽。
  it("second mousedown within 500ms toggles maximize instead of dragging", () => {
    vi.useFakeTimers({ now: 1000 });
    try {
      const { container } = render(<TopBar />);
      const bar = container.firstElementChild!;
      fireEvent.mouseDown(bar, { screenX: 100, screenY: 20 });
      vi.setSystemTime(1400);
      fireEvent.mouseDown(bar, { screenX: 102, screenY: 21 });
      expect(startDraggingMock).toHaveBeenCalledTimes(1);
      expect(toggleMaximizeMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("mousedown again after the 500ms window starts a drag, not a maximize", () => {
    vi.useFakeTimers({ now: 1000 });
    try {
      const { container } = render(<TopBar />);
      const bar = container.firstElementChild!;
      fireEvent.mouseDown(bar, { screenX: 100, screenY: 20 });
      vi.setSystemTime(1600);
      fireEvent.mouseDown(bar, { screenX: 100, screenY: 20 });
      expect(startDraggingMock).toHaveBeenCalledTimes(2);
      expect(toggleMaximizeMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("mousedown on interactive children neither drags nor maximizes", () => {
    render(<TopBar />);
    fireEvent.mouseDown(screen.getByRole("button", { name: "文件" }), {
      screenX: 100,
      screenY: 20,
    });
    expect(startDraggingMock).not.toHaveBeenCalled();
    expect(toggleMaximizeMock).not.toHaveBeenCalled();
  });
});

describe("new-task command", () => {
  it("creates NexAgent immediately from the sidebar command", async () => {
    render(<WorkspaceSidebar/>);
    act(()=>getCommand("workbench.newConversation")!.run());
    await waitFor(()=>expect(createConversationMock).toHaveBeenCalledWith("p1","nex"));
    expect(screen.queryByText("选择智能体")).toBeNull();
  });
});
