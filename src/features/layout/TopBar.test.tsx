/**
 * @vitest-environment jsdom
 */
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

// TopBar 触碰 Tauri 窗口 API 与重子组件；全部打桩。NewConversationDropdown
// 保持真实（本文件同时覆盖 F5 轮廓与 F6 接线）。
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    startDragging: () => Promise.resolve(),
    toggleMaximize: () => Promise.resolve(),
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
import { getCommand } from "../../commands/registry";
import { useProjectStore } from "../../stores/project.store";
import { useConversationStore } from "../../stores/conversation.store";
import { useAgentStore } from "../../stores/agent.store";
import { useUiStore } from "../../stores/ui.store";
import type { Conversation, ServerDescriptor, SessionTarget } from "../../bridge/tauri";

// mock 函数类型与真 store 的动作签名逐一对齐（tsc -b 门槛要求 setState
// 注入时 Mock<T> 可赋给具体动作类型）。
type CreateConversationFn = (projectId: string, agentType: string) => Promise<Conversation>;
type CreateSessionFn = (conversationId: string, target: SessionTarget, cwd: string) => Promise<string>;
type LoadAllServersFn = () => Promise<void>;
type RefreshRegistryFn = () => Promise<void>;

// 模块级可变 let 持有 mock action，beforeEach 经 setState 注入真 store。
let createConversationMock: Mock<CreateConversationFn>;
let createSessionMock: Mock<CreateSessionFn>;
let loadAllServersMock: Mock<LoadAllServersFn>;
let refreshRegistryMock: Mock<RefreshRegistryFn>;

const SERVER_CLAUDE: ServerDescriptor = {
  id: "claude-code", name: "Claude Code", version: "1.2.3",
  description: "Anthropic 的智能体", icon: null, kind: "registry",
};

// mock 的 createConversation 与真实动作的副作用逐一对齐（conversationsByProject.unshift
// + tabs.push + 激活）——TopBar 的页签标题从 conversationsByProject 解析，漏掉 unshift
// 会让标题回退成 tab id，"新对话"断言必挂。
const fakeCreateConversation = async (projectId: string, agentType: string): Promise<Conversation> => {
  const conv: Conversation = {
    id: "conv-1", project_id: projectId, title: "新对话", agent_type: agentType,
    status: "active", created_at: 0, updated_at: 0,
  };
  useConversationStore.setState((s) => {
    if (!s.conversationsByProject[projectId]) s.conversationsByProject[projectId] = [];
    s.conversationsByProject[projectId].unshift(conv);
    const tabs = s.tabsByProject[projectId] ?? [];
    s.tabsByProject[projectId] = [...tabs, conv.id];
    s.activeTabByProject[projectId] = conv.id;
  });
  return conv;
};

beforeEach(() => {
  createConversationMock = vi.fn<CreateConversationFn>().mockImplementation(fakeCreateConversation);
  createSessionMock = vi.fn<CreateSessionFn>().mockResolvedValue("sess-1");
  loadAllServersMock = vi.fn<LoadAllServersFn>().mockResolvedValue(undefined);
  refreshRegistryMock = vi.fn<RefreshRegistryFn>().mockResolvedValue(undefined);

  useUiStore.setState({ newConversationOpen: false });
  useProjectStore.setState({
    projects: [{ id: "p1", name: "demo", path: "/tmp/demo", created_at: 0, last_opened: 0 }],
    activeProjectId: "p1",
  });
  useConversationStore.setState({
    conversationsByProject: {
      p1: [
        { id: "c1", project_id: "p1", title: "第一个会话", agent_type: "x", status: "active", created_at: 0, updated_at: 0 },
        { id: "c2", project_id: "p1", title: "第二个会话", agent_type: "x", status: "active", created_at: 0, updated_at: 0 },
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

describe("conversation tab outline (F5)", () => {
  it("active trigger carries capsule outline classes (glass bg, border, top highlight)", () => {
    render(<TopBar />);
    const active = screen.getByRole("tab", { name: /第一个会话/ });
    expect(active.className).toContain(
      "group-data-[variant=line]/tabs-list:data-[state=active]:bg-[var(--glass-2-surface)]"
    );
    expect(active.className).toContain(
      "group-data-[variant=line]/tabs-list:data-[state=active]:border-[color:var(--border-default)]"
    );
    expect(active.className).toContain(
      "group-data-[variant=line]/tabs-list:data-[state=active]:shadow-[inset_0_1px_0_0_rgba(255,255,255,0.06)]"
    );
    expect(active.className).not.toContain("before:bg-[var(--accent)]");
    expect(active.className).toContain("rounded-[var(--radius-sm)]");
    expect(active.className).not.toContain("rounded-[var(--radius-md)]");
    expect(active.className).toContain(
      "group-data-[variant=line]/tabs-list:data-[state=active]:after:opacity-0"
    );
    // dark 对偶类必须在场（R1：顶掉 ui/tabs.tsx 内置 dark:bg-transparent/border-transparent）
    expect(active.className).toContain(
      "dark:group-data-[variant=line]/tabs-list:data-[state=active]:bg-[var(--glass-2-surface)]"
    );
    expect(active.className).toContain(
      "dark:group-data-[variant=line]/tabs-list:data-[state=active]:border-[color:var(--border-default)]"
    );
  });

  it("legacy bottom-line shadow and large radius are gone", () => {
    render(<TopBar />);
    const active = screen.getByRole("tab", { name: /第一个会话/ });
    expect(active.className).not.toContain("shadow-[inset_0_-2px_0_0_var(--accent)]");
    expect(active.className).not.toContain("rounded-[var(--radius-md)]");
  });

  it("inactive triggers keep a light outline + hover lift/bg/stronger border", () => {
    render(<TopBar />);
    const inactive = screen.getByRole("tab", { name: /第二个会话/ });
    expect(inactive.className).toContain("border-[color:var(--border-subtle)]");
    expect(inactive.className).toContain("hover:-translate-y-px");
    expect(inactive.className).toContain(
      "group-data-[variant=line]/tabs-list:hover:bg-[var(--overlay-hover)]"
    );
    expect(inactive.className).toContain("hover:border-[color:var(--border-default)]");
    expect(inactive.className).toContain("data-[state=active]:hover:translate-y-0");
  });

  it("hides the close icon until the tab is hovered", () => {
    render(<TopBar />);
    const active = screen.getByRole("tab", { name: /第一个会话/ });
    expect(active.className).toContain("group/tab");
    const close = active.querySelector("[data-tab-close]");
    expect(close?.className).toContain("opacity-0");
    expect(close?.className).toContain("group-hover/tab:opacity-70");
  });

  it("renders scrollbar-hidden overflow with left/right fade masks", () => {
    const { container } = render(<TopBar />);
    expect(container.innerHTML).toContain("overflow-x-auto scrollbar-none");
    expect(container.innerHTML).toContain("bg-gradient-to-r from-[var(--background)] to-transparent");
    expect(container.innerHTML).toContain("bg-gradient-to-l from-[var(--background)] to-transparent");
    expect(container.innerHTML).toContain("pointer-events-none");
  });

  it("mousedown on an inactive tab switches the active conversation", () => {
    render(<TopBar />);
    fireEvent.mouseDown(screen.getByRole("tab", { name: /第二个会话/ }));
    expect(useConversationStore.getState().activeTabByProject.p1).toBe("c2");
  });
});

describe("new-conversation dropdown wiring (F6)", () => {
  it("clicking + opens the dropdown; Esc closes it", async () => {
    render(<TopBar />);
    fireEvent.pointerDown(screen.getByRole("button", { name: "新建会话" }));
    expect(screen.getByText("选择智能体")).toBeTruthy();
    fireEvent.keyDown(document.body, { key: "Escape" });
    await waitFor(() => expect(screen.queryByText("选择智能体")).toBeNull());
    expect(useUiStore.getState().newConversationOpen).toBe(false);
  });

  it("Ctrl+Shift+N (command run) opens the dropdown", () => {
    render(<TopBar />);
    act(() => {
      getCommand("workbench.newConversation")!.run();
    });
    expect(screen.getByText("选择智能体")).toBeTruthy();
  });

  it("clicking an agent row creates a conversation and shows the tab immediately", async () => {
    render(<TopBar />);
    fireEvent.pointerDown(screen.getByRole("button", { name: "新建会话" }));
    fireEvent.click(screen.getByText("Claude Code"));
    await waitFor(() =>
      expect(createConversationMock).toHaveBeenCalledWith("p1", "claude-code")
    );
    expect(useUiStore.getState().newConversationOpen).toBe(false);
    expect(await screen.findByRole("tab", { name: /新对话/ })).toBeTruthy();
  });
});
