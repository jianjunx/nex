import { beforeEach, describe, expect, it, vi } from "vitest";

// mock 桥接层：模块级可变 fn + 工厂闭包延迟读取（调用时才命中当前 mock 实现）。
const agentListServers = vi.fn();
const agentListAllServers = vi.fn();
const agentCreateSession = vi.fn();
const agentSetSessionMode = vi.fn();
const agentSetSessionModel = vi.fn();
const agentSetSessionConfigOption = vi.fn();
const agentRespondPermission = vi.fn();
let permissionHandler: ((payload: unknown) => void) | null = null;

vi.mock("../bridge/tauri", () => ({
  agentListServers: (...args: unknown[]) => agentListServers(...args),
  agentListAllServers: (...args: unknown[]) => agentListAllServers(...args),
  agentCreateSession: (...args: unknown[]) => agentCreateSession(...args),
  agentSetSessionMode: (...args: unknown[]) => agentSetSessionMode(...args),
  agentSetSessionModel: (...args: unknown[]) => agentSetSessionModel(...args),
  agentSetSessionConfigOption: (...args: unknown[]) => agentSetSessionConfigOption(...args),
  agentRespondPermission: (...args: unknown[]) => agentRespondPermission(...args),
  agentSendPrompt: vi.fn(),
  agentCancel: vi.fn(),
  agentCloseSession: vi.fn(),
  agentRefreshRegistry: vi.fn(),
  agentCustomUpsert: vi.fn(),
  agentCustomDelete: vi.fn(),
  conversationReplaceThreadEntries: vi.fn(),
  onAgentNotification: () => Promise.resolve(() => {}),
  onAgentPermissionRequest: (cb: (payload: unknown) => void) => {
    permissionHandler = cb;
    return Promise.resolve(() => {});
  },
  onAgentSessionTerminated: () => Promise.resolve(() => {}),
}));

import { useAgentStore } from "./agent.store";

const SERVER = { id: "s1", name: "测试智能体", version: "1.0", description: "", icon: null, kind: "registry" };

let listenersTeardown: (() => void) | null = null;

beforeEach(() => {
  listenersTeardown?.();
  listenersTeardown = null;
  vi.clearAllMocks();
  permissionHandler = null;
  // 每例前把打点相关字段重置回初始态（store 为单例）。
  useAgentStore.setState({
    servers: [],
    serversLoading: false,
    serversLoadedAt: 0,
    error: null,
    sessions: {},
    metaByConversation: {},
    sessionPrefsByConversation: {},
    permissionQueues: {},
    pendingPermission: null,
    inlinePermissionIds: {},
  });
});

describe("agent.store serversLoadedAt 打点语义", () => {
  it("loadAllServers 成功 → serversLoadedAt > 0", async () => {
    agentListAllServers.mockResolvedValue([SERVER]);
    await useAgentStore.getState().loadAllServers();
    const s = useAgentStore.getState();
    expect(s.servers).toHaveLength(1);
    expect(s.serversLoadedAt).toBeGreaterThan(0);
    expect(s.serversLoading).toBe(false);
  });

  it("loadAllServers 失败 → serversLoadedAt > 0（失败也打点，防自激重试）且 error 写入", async () => {
    agentListAllServers.mockRejectedValue(new Error("backend down"));
    await useAgentStore.getState().loadAllServers();
    const s = useAgentStore.getState();
    expect(s.serversLoadedAt).toBeGreaterThan(0);
    expect(s.error).toBe("backend down");
    expect(s.serversLoading).toBe(false);
  });

  it("loadServers 成功 → serversLoadedAt > 0（新建会话新鲜度守卫需要打点）", async () => {
    agentListServers.mockResolvedValue([SERVER]);
    await useAgentStore.getState().loadServers();
    const s = useAgentStore.getState();
    expect(s.servers).toHaveLength(1);
    expect(s.serversLoadedAt).toBeGreaterThan(0);
    expect(s.serversLoading).toBe(false);
  });
});

describe("agent.store session prefs", () => {
  it("setAuthMode 写入按会话偏好", () => {
    useAgentStore.getState().setAuthMode("conv-1", "allow");
    expect(useAgentStore.getState().sessionPrefsByConversation["conv-1"]?.authMode).toBe("allow");
  });

  it("setMode 成功后记住 modeId", async () => {
    agentSetSessionMode.mockResolvedValue(undefined);
    useAgentStore.setState({
      sessions: {
        "conv-1": { sessionId: "sid-1", conversationId: "conv-1", status: "idle" },
      },
      metaByConversation: {
        "conv-1": {
          modes: [{ id: "agent", name: "Agent" }],
          currentModeId: "ask",
          models: [],
          currentModelId: null,
          configOptions: [],
          availableCommands: [],
          plan: null,
        },
      },
    });
    await useAgentStore.getState().setMode("sid-1", "agent");
    expect(agentSetSessionMode).toHaveBeenCalledWith("sid-1", "agent");
    expect(useAgentStore.getState().sessionPrefsByConversation["conv-1"]?.modeId).toBe("agent");
    expect(useAgentStore.getState().metaByConversation["conv-1"]?.currentModeId).toBe("agent");
  });

  it("createSession 后把已存 prefs 应用到 ACP", async () => {
    agentCreateSession.mockResolvedValue({
      sessionId: "sid-new",
      modes: {
        currentModeId: "ask",
        availableModes: [
          { id: "ask", name: "Ask" },
          { id: "agent", name: "Agent" },
        ],
      },
      models: {
        currentModelId: "m1",
        availableModels: [
          { id: "m1", name: "M1" },
          { id: "m2", name: "M2" },
        ],
      },
      configOptions: [
        {
          id: "effort",
          name: "Effort",
          currentValueId: "low",
          options: [
            { id: "low", name: "Low" },
            { id: "high", name: "High" },
          ],
        },
      ],
    });
    agentSetSessionMode.mockResolvedValue(undefined);
    agentSetSessionModel.mockResolvedValue(undefined);
    agentSetSessionConfigOption.mockResolvedValue(null);
    useAgentStore.setState({
      sessionPrefsByConversation: {
        "conv-1": { modeId: "agent", modelId: "m2", configValues: { effort: "high" } },
      },
    });

    await useAgentStore.getState().createSession("conv-1", { type: "registry", id: "cursor" }, "/tmp");

    expect(agentSetSessionMode).toHaveBeenCalledWith("sid-new", "agent");
    expect(agentSetSessionModel).toHaveBeenCalledWith("sid-new", "m2");
    expect(agentSetSessionConfigOption).toHaveBeenCalledWith("sid-new", "effort", "high");
    expect(useAgentStore.getState().metaByConversation["conv-1"]?.currentModeId).toBe("agent");
    expect(useAgentStore.getState().metaByConversation["conv-1"]?.currentModelId).toBe("m2");
  });
});

describe("agent.store Allow 授权模式", () => {
  it("authMode=allow 时权限请求自动 respond，不进 pendingPermission", async () => {
    agentRespondPermission.mockResolvedValue(undefined);
    useAgentStore.setState({
      sessions: {
        "conv-1": { sessionId: "sid-1", conversationId: "conv-1", status: "running" },
      },
      sessionPrefsByConversation: { "conv-1": { authMode: "allow" } },
    });
    listenersTeardown = useAgentStore.getState().initListeners();
    expect(permissionHandler).toBeTruthy();

    permissionHandler!({
      sessionId: "sid-1",
      requestId: "req-1",
      toolCallId: "tool-1",
      options: [
        { optionId: "allow-once", label: "Allow", kind: "allow_once" },
        { optionId: "reject", label: "Reject", kind: "reject_once" },
      ],
    });

    await vi.waitFor(() => {
      expect(agentRespondPermission).toHaveBeenCalledWith("req-1", "allow-once");
    });
    expect(useAgentStore.getState().pendingPermission).toBeNull();
    expect(useAgentStore.getState().permissionQueues["sid-1"]).toBeUndefined();
    expect(useAgentStore.getState().sessions["conv-1"]?.status).toBe("running");
  });
});
