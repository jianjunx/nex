/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { NewConversationDropdown } from "./NewConversationDropdown";
import { useUiStore } from "../../stores/ui.store";
import { useAgentStore } from "../../stores/agent.store";
import { useConversationStore } from "../../stores/conversation.store";
import { useProjectStore } from "../../stores/project.store";
import type { Conversation, ServerDescriptor } from "../../bridge/tauri";

// 模块级可变 let 持有 mock action，beforeEach 经 setState 注入真 store
//（约束 4 模式的 zustand 变体：store 实例保持真实，只换动作，数据字段可断言）。
let createConversationMock: ReturnType<typeof vi.fn>;
let createSessionMock: ReturnType<typeof vi.fn>;
let closeTabMock: ReturnType<typeof vi.fn>;
let loadAllServersMock: ReturnType<typeof vi.fn>;
let refreshRegistryMock: ReturnType<typeof vi.fn>;

const realCloseNewConversation = useUiStore.getState().closeNewConversation;

const SERVER_CLAUDE: ServerDescriptor = {
  id: "claude-code", name: "Claude Code", version: "1.2.3",
  description: "Anthropic 的智能体", icon: null, kind: "registry",
};
const SERVER_CUSTOM: ServerDescriptor = {
  id: "my-agent", name: "My Agent", version: "",
  description: "", icon: null, kind: "custom",
};
const CONV: Conversation = {
  id: "conv-1", project_id: "p1", title: "新对话", agent_type: "claude-code",
  status: "active", created_at: 0, updated_at: 0,
};

beforeEach(() => {
  createConversationMock = vi.fn().mockResolvedValue(CONV);
  createSessionMock = vi.fn().mockResolvedValue("sess-1");
  closeTabMock = vi.fn();
  loadAllServersMock = vi.fn().mockResolvedValue(undefined);
  refreshRegistryMock = vi.fn().mockResolvedValue(undefined);

  useUiStore.setState({
    newConversationOpen: false,
    settingsOpen: false,
    settingsSection: null,
    closeNewConversation: realCloseNewConversation,
  });
  useProjectStore.setState({
    projects: [{ id: "p1", name: "demo", path: "/tmp/demo", created_at: 0, last_opened: 0 }],
    activeProjectId: "p1",
  });
  useAgentStore.setState({
    servers: [SERVER_CLAUDE, SERVER_CUSTOM],
    serversLoading: false,
    serversLoadedAt: Date.now(),
    error: null,
    createSession: createSessionMock,
    loadAllServers: loadAllServersMock,
    refreshRegistry: refreshRegistryMock,
  });
  useConversationStore.setState({
    createConversation: createConversationMock,
    closeTab: closeTabMock,
  });
});
afterEach(() => cleanup());

// Radix 触发器无 onClick 路径：pointerDown 才匹配真机事件流（技术背景实测条目；
// fireEvent.click 开菜单是本计划曾踩的 Blocker——jsdom 全绿、真机双触发失效）。
function openDropdown() {
  render(<NewConversationDropdown triggerSize="icon" />);
  fireEvent.pointerDown(screen.getByRole("button", { name: "新建会话" }));
}

describe("NewConversationDropdown", () => {
  it("the + trigger toggles the controlled panel", () => {
    render(<NewConversationDropdown triggerSize="icon" />);
    fireEvent.pointerDown(screen.getByRole("button", { name: "新建会话" }));
    expect(useUiStore.getState().newConversationOpen).toBe(true);
    expect(screen.getByText("选择智能体")).toBeTruthy();
    // 菜单打开期间 Radix 给 portal 之外的整棵 DOM 打 aria-hidden（实测 DOM 证据），
    // getByRole 默认排除隐藏元素，故关面板这一下查询需带 hidden:true；
    // fireEvent 本身不受 aria-hidden 影响，事件流与真机一致。
    fireEvent.pointerDown(screen.getByRole("button", { name: "新建会话", hidden: true }));
    expect(useUiStore.getState().newConversationOpen).toBe(false);
  });

  it("clicking a registry row creates immediately and closes the panel", async () => {
    openDropdown();
    fireEvent.click(screen.getByText("Claude Code"));
    await waitFor(() =>
      expect(createConversationMock).toHaveBeenCalledWith("p1", "claude-code")
    );
    expect(createSessionMock).toHaveBeenCalledWith(
      "conv-1", { type: "registry", id: "claude-code" }, "/tmp/demo"
    );
    expect(useUiStore.getState().newConversationOpen).toBe(false);
  });

  it("custom kind maps to a custom session target", async () => {
    openDropdown();
    fireEvent.click(screen.getByText("My Agent"));
    await waitFor(() =>
      expect(createSessionMock).toHaveBeenCalledWith(
        "conv-1", { type: "custom", id: "my-agent" }, "/tmp/demo"
      )
    );
  });

  it("createConversation failure: inline error row, panel stays open, no session", async () => {
    createConversationMock.mockRejectedValue({ message: "创建失败" });
    openDropdown();
    fireEvent.click(screen.getByText("Claude Code"));
    await screen.findByText("创建失败");
    expect(useUiStore.getState().newConversationOpen).toBe(true);
    expect(createSessionMock).not.toHaveBeenCalled();
    expect(closeTabMock).not.toHaveBeenCalled();
  });

  it("clears the stale error row when the panel reopens (R4)", async () => {
    createConversationMock.mockRejectedValueOnce({ message: "旧错误" });
    const utils = render(<NewConversationDropdown triggerSize="icon" />);
    fireEvent.pointerDown(screen.getByRole("button", { name: "新建会话" }));
    fireEvent.click(screen.getByText("Claude Code"));
    await screen.findByText("旧错误");
    fireEvent.keyDown(document.body, { key: "Escape" });
    await waitFor(() => expect(useUiStore.getState().newConversationOpen).toBe(false));
    utils.rerender(<NewConversationDropdown triggerSize="icon" />);
    fireEvent.pointerDown(screen.getByRole("button", { name: "新建会话" }));
    expect(screen.queryByText("旧错误")).toBeNull();
  });

  it("rolls the tab back (closeTab) when a post-creation sync step fails", async () => {
    // 契约：标签已建之后的任何同步失败都必须回滚标签。
    useUiStore.setState({
      closeNewConversation: () => { throw new Error("store boom"); },
    });
    openDropdown();
    fireEvent.click(screen.getByText("Claude Code"));
    await screen.findByText("store boom");
    expect(closeTabMock).toHaveBeenCalledWith("conv-1");
  });

  it("anti-double-click: sibling rows are disabled while creating", async () => {
    let release: (v: Conversation) => void = () => {};
    createConversationMock.mockImplementation(
      () => new Promise<Conversation>((res) => { release = res; })
    );
    openDropdown();
    const row = screen.getByText("Claude Code").closest('[role="menuitem"]')!;
    fireEvent.click(row);
    const other = screen.getByText("My Agent").closest('[role="menuitem"]')!;
    expect(other.getAttribute("data-disabled")).toBe("");
    release(CONV);
    await waitFor(() => expect(createSessionMock).toHaveBeenCalled());
  });

  it("freshness guard: stale servers trigger loadAllServers on open", () => {
    useAgentStore.setState({ serversLoadedAt: Date.now() - 120_000 });
    render(<NewConversationDropdown triggerSize="icon" />);
    expect(loadAllServersMock).not.toHaveBeenCalled();
    fireEvent.pointerDown(screen.getByRole("button", { name: "新建会话" }));
    expect(loadAllServersMock).toHaveBeenCalledTimes(1);
  });

  it("freshness guard: fresh servers skip the reload", () => {
    openDropdown();
    expect(loadAllServersMock).not.toHaveBeenCalled();
  });

  it("shows a loading row when empty and loading", () => {
    useAgentStore.setState({ servers: [], serversLoading: true });
    openDropdown();
    expect(screen.getByText("正在加载智能体列表…")).toBeTruthy();
  });

  it("shows empty hint + refresh when no servers", () => {
    useAgentStore.setState({ servers: [], serversLoading: false });
    openDropdown();
    expect(screen.getByText("暂无可用智能体")).toBeTruthy();
    const refreshButtons = screen.getAllByTitle("刷新智能体注册表");
    fireEvent.click(refreshButtons[0]);
    expect(refreshRegistryMock).toHaveBeenCalled();
  });

  it("'管理智能体…' targets the agents section and opens settings", () => {
    openDropdown();
    fireEvent.click(screen.getByText("管理智能体…"));
    expect(useUiStore.getState().settingsSection).toBe("agents");
    expect(useUiStore.getState().settingsOpen).toBe(true);
    expect(useUiStore.getState().newConversationOpen).toBe(false);
  });
});
