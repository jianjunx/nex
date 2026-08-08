import { beforeEach, describe, expect, it, vi } from "vitest";

// mock 桥接层：模块级可变 fn + 工厂闭包延迟读取（调用时才命中当前 mock 实现）。
const agentListServers = vi.fn();
const agentListAllServers = vi.fn();
const agentCreateSession = vi.fn();
const agentSetSessionMode = vi.fn();
const agentSetSessionModel = vi.fn();
const agentSetSessionConfigOption = vi.fn();
const agentRespondPermission = vi.fn();
const agentRespondPlan = vi.fn();
const agentRespondAskQuestion = vi.fn();
const agentSendPrompt = vi.fn().mockResolvedValue({ hadMutations: false });
const agentCancel = vi.fn().mockResolvedValue(undefined);
const conversationReplaceThreadEntries = vi.fn().mockResolvedValue(undefined);
const nativeAgentGetConfig = vi.fn().mockResolvedValue({
  providers: [],
  agent: { maxSteps: 0, contextWindow: 0, bashTimeoutSecs: 120, maxSubagentConcurrency: 6, autoReview: false },
});
let permissionHandler: ((payload: unknown) => void) | null = null;
let notificationHandler: ((payload: { sessionId: string; update: unknown }) => void) | null = null;

vi.mock("../bridge/tauri", () => ({
  agentListServers: (...args: unknown[]) => agentListServers(...args),
  agentListAllServers: (...args: unknown[]) => agentListAllServers(...args),
  agentCreateSession: (...args: unknown[]) => agentCreateSession(...args),
  agentSetSessionMode: (...args: unknown[]) => agentSetSessionMode(...args),
  agentSetSessionModel: (...args: unknown[]) => agentSetSessionModel(...args),
  agentSetSessionConfigOption: (...args: unknown[]) => agentSetSessionConfigOption(...args),
  agentRespondPermission: (...args: unknown[]) => agentRespondPermission(...args),
  agentRespondPlan: (...args: unknown[]) => agentRespondPlan(...args),
  agentRespondAskQuestion: (...args: unknown[]) => agentRespondAskQuestion(...args),
  agentSendPrompt: (...args: unknown[]) => agentSendPrompt(...args),
  agentCancel: (...args: unknown[]) => agentCancel(...args),
  agentCloseSession: vi.fn(),
  agentRefreshRegistry: vi.fn(),
  agentCustomUpsert: vi.fn(),
  agentCustomDelete: vi.fn(),
  conversationReplaceThreadEntries: (...args: unknown[]) => conversationReplaceThreadEntries(...args),
  nativeAgentGetConfig: (...args: unknown[]) => nativeAgentGetConfig(...args),
  onAgentNotification: (cb: (payload: { sessionId: string; update: unknown }) => void) => {
    notificationHandler = cb;
    return Promise.resolve(() => {});
  },
  onAgentPermissionRequest: (cb: (payload: unknown) => void) => {
    permissionHandler = cb;
    return Promise.resolve(() => {});
  },
  onAgentPlanApprovalRequest: () => Promise.resolve(() => {}),
  onAgentAskQuestionRequest: () => Promise.resolve(() => {}),
  onAgentSessionTerminated: () => Promise.resolve(() => {}),
}));

import { useAgentStore } from "./agent.store";
import { useConversationStore } from "./conversation.store";

const SERVER = { id: "s1", name: "测试智能体", version: "1.0", description: "", icon: null, kind: "registry" };

let listenersTeardown: (() => void) | null = null;

beforeEach(() => {
  listenersTeardown?.();
  listenersTeardown = null;
  vi.clearAllMocks();
  permissionHandler = null;
  notificationHandler = null;
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
    planApprovalQueues: {},
    pendingPlanApproval: null,
    askQuestionQueues: {},
    pendingAskQuestion: null,
    entriesByConversation: {},
    pendingMessagesByConversation: {},
    nativeAutoReview: false,
  });
  useConversationStore.setState({ conversationsByProject: {} });
  agentSendPrompt.mockResolvedValue({ hadMutations: false });
  agentCancel.mockResolvedValue(undefined);
  agentRespondPlan.mockResolvedValue(undefined);
  agentRespondAskQuestion.mockResolvedValue(undefined);
  agentSetSessionMode.mockResolvedValue(undefined);
  conversationReplaceThreadEntries.mockResolvedValue(undefined);
  nativeAgentGetConfig.mockResolvedValue({
    providers: [],
    agent: { maxSteps: 0, contextWindow: 0, bashTimeoutSecs: 120, maxSubagentConcurrency: 6, autoReview: false },
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
          contextUsage: null,
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

  it("createSession 从 CreateSessionResult 写入 availableCommands", async () => {
    agentCreateSession.mockResolvedValue({
      sessionId: "sid-cmds",
      availableCommands: [
        { name: "review", description: "Review code", inputHint: "files" },
        { name: "compact", description: "Compact context" },
      ],
    });
    await useAgentStore.getState().createSession("conv-1", { type: "native", id: "nex" }, "/tmp");
    const cmds = useAgentStore.getState().metaByConversation["conv-1"]?.availableCommands;
    expect(cmds).toEqual([
      { name: "review", description: "Review code", inputHint: "files" },
      { name: "compact", description: "Compact context", inputHint: undefined },
    ]);
  });

  it("available_commands_update 早于 sessionId 注册时会被缓冲并在 createSession 后应用", async () => {
    listenersTeardown = useAgentStore.getState().initListeners();
    expect(notificationHandler).toBeTruthy();

    // Race: notification arrives while createSession RPC is in flight.
    let resolveCreate!: (v: unknown) => void;
    agentCreateSession.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCreate = resolve;
        }),
    );

    const createPromise = useAgentStore
      .getState()
      .createSession("conv-1", { type: "native", id: "nex" }, "/tmp");

    notificationHandler!({
      sessionId: "sid-race",
      update: {
        sessionUpdate: "available_commands_update",
        availableCommands: [{ name: "review", description: "Review code." }],
      },
    });
    // Still starting — placeholder sessionId is "" so update must not apply yet.
    expect(useAgentStore.getState().metaByConversation["conv-1"]?.availableCommands ?? []).toEqual(
      [],
    );

    resolveCreate({ sessionId: "sid-race" });
    await createPromise;

    expect(useAgentStore.getState().metaByConversation["conv-1"]?.availableCommands).toEqual([
      { name: "review", description: "Review code.", inputHint: undefined },
    ]);
  });

  it("createSession 失败时丢弃已缓冲的 notification，不污染后续会话", async () => {
    listenersTeardown = useAgentStore.getState().initListeners();

    let rejectCreate!: (err: Error) => void;
    agentCreateSession.mockImplementation(
      () =>
        new Promise((_, reject) => {
          rejectCreate = reject;
        }),
    );

    const failPromise = useAgentStore
      .getState()
      .createSession("conv-1", { type: "native", id: "nex" }, "/tmp");

    notificationHandler!({
      sessionId: "sid-orphan",
      update: {
        sessionUpdate: "available_commands_update",
        availableCommands: [{ name: "review", description: "should be dropped" }],
      },
    });
    // Stream chunks must not be buffered either.
    notificationHandler!({
      sessionId: "sid-orphan",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "hi" },
      },
    });

    rejectCreate(new Error("spawn failed"));
    await expect(failPromise).rejects.toThrow("spawn failed");

    agentCreateSession.mockResolvedValue({ sessionId: "sid-orphan" });
    await useAgentStore.getState().createSession("conv-2", { type: "native", id: "nex" }, "/tmp");

    expect(useAgentStore.getState().metaByConversation["conv-2"]?.availableCommands ?? []).toEqual(
      [],
    );
    expect(useAgentStore.getState().entriesByConversation["conv-2"] ?? []).toEqual([]);
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

describe("entriesByConversation 结构共享", () => {
  it("更新会话 A 不改变会话 B 的数组引用", () => {
    useAgentStore.setState((s) => {
      s.entriesByConversation = {
        A: [{ id: "a1", kind: "user_message", text: "hi", timestamp: 1 }],
        B: [{ id: "b1", kind: "user_message", text: "yo", timestamp: 2 }],
      };
    });
    const beforeB = useAgentStore.getState().entriesByConversation["B"];
    const beforeA = useAgentStore.getState().entriesByConversation["A"];

    useAgentStore.setState((s) => {
      s.entriesByConversation["A"]?.push({
        id: "a2",
        kind: "user_message",
        text: "more",
        timestamp: 3,
      });
    });

    const after = useAgentStore.getState().entriesByConversation;
    expect(after["B"]).toBe(beforeB); // B 引用不变 → 收窄 selector 不会重渲染
    expect(after["A"]).not.toBe(beforeA);
  });
});

describe("switch-project memory: live sessions", () => {
  beforeEach(() => {
    useAgentStore.setState({
      sessions: {},
      entriesByConversation: {},
    });
  });

  it("pruneEntriesExcept keeps threads for live running sessions", () => {
    useAgentStore.setState({
      sessions: {
        "conv-live": {
          sessionId: "sid",
          conversationId: "conv-live",
          status: "running",
        },
      },
      entriesByConversation: {
        "conv-live": [
          { id: "e1", kind: "user_message", text: "run", timestamp: 1 },
          {
            id: "e2",
            kind: "assistant_message",
            timestamp: 2,
            chunks: [{ type: "message", text: "streaming…" }],
          },
        ],
        "conv-other": [{ id: "o1", kind: "user_message", text: "old", timestamp: 1 }],
      },
    });

    // New project tabs do not include conv-live — previously this wiped the turn.
    useAgentStore.getState().pruneEntriesExcept(new Set(["conv-new-proj"]));

    const entries = useAgentStore.getState().entriesByConversation;
    expect(entries["conv-live"]).toHaveLength(2);
    expect(entries["conv-other"]).toBeUndefined();
  });

  it("hydrateEntries does not overwrite a running session thread", () => {
    useAgentStore.setState({
      sessions: {
        "conv-live": {
          sessionId: "sid",
          conversationId: "conv-live",
          status: "running",
        },
      },
      entriesByConversation: {
        "conv-live": [
          { id: "e1", kind: "user_message", text: "run", timestamp: 1 },
          {
            id: "e2",
            kind: "assistant_message",
            timestamp: 2,
            chunks: [{ type: "message", text: "streaming…" }],
          },
        ],
      },
    });

    useAgentStore.getState().hydrateEntries("conv-live", [
      { id: "stale", kind: "user_message", text: "from-db", timestamp: 1 },
    ]);

    const entries = useAgentStore.getState().entriesByConversation["conv-live"];
    expect(entries?.[0]?.id).toBe("e1");
    expect(entries).toHaveLength(2);
  });

  it("hydrateEntries replaces idle / no-session threads", () => {
    useAgentStore.setState({
      sessions: {},
      entriesByConversation: {
        "conv-a": [{ id: "old", kind: "user_message", text: "old", timestamp: 1 }],
      },
    });
    useAgentStore.getState().hydrateEntries("conv-a", [
      { id: "new", kind: "user_message", text: "new", timestamp: 2 },
    ]);
    expect(useAgentStore.getState().entriesByConversation["conv-a"]?.[0]?.id).toBe("new");
  });

  it("hydrateEntries hydrates a starting session whose thread is still empty (cold restart race)", () => {
    // Cold restart: the composer auto-spawns the active tab's session
    // ("starting", empty thread) before restore finishes. The hydrate must
    // still land or the conversation renders blank until revisited.
    useAgentStore.setState({
      sessions: {
        "conv-cold": {
          sessionId: "",
          conversationId: "conv-cold",
          status: "starting",
        },
      },
      entriesByConversation: { "conv-cold": [] },
    });

    useAgentStore.getState().hydrateEntries("conv-cold", [
      { id: "h1", kind: "user_message", text: "from-db", timestamp: 1 },
    ]);

    const entries = useAgentStore.getState().entriesByConversation["conv-cold"];
    expect(entries).toHaveLength(1);
    expect(entries?.[0]?.id).toBe("h1");
  });
});

const PLAN_PAYLOAD = {
  sessionId: "sid-1",
  requestId: "plan-1",
  name: "Ship it",
  overview: null,
  plan: "1. do thing",
  todos: [{ id: "t1", content: "do thing", status: "pending" }],
};

describe("respondPlan / respondAskQuestion re-queue", () => {
  it("RPC 失败时把 plan 请求重新入队并回滚卡片 pending", async () => {
    agentRespondPlan.mockRejectedValue(new Error("backend down"));
    useAgentStore.setState({
      sessions: {
        "conv-1": { sessionId: "sid-1", conversationId: "conv-1", status: "waiting" },
      },
      planApprovalQueues: { "sid-1": [{ ...PLAN_PAYLOAD, todos: [...PLAN_PAYLOAD.todos] }] },
      pendingPlanApproval: { ...PLAN_PAYLOAD, todos: [...PLAN_PAYLOAD.todos] },
      entriesByConversation: {
        "conv-1": [
          {
            id: "card-1",
            kind: "plan_approval",
            timestamp: 1,
            requestId: "plan-1",
            plan: "1. do thing",
            todos: [{ id: "t1", content: "do thing", status: "pending" }],
            status: "pending",
          },
        ],
      },
    });

    await useAgentStore.getState().respondPlan("plan-1", "accepted");

    const s = useAgentStore.getState();
    expect(s.error).toBe("backend down");
    expect(s.planApprovalQueues["sid-1"]?.[0]?.requestId).toBe("plan-1");
    expect(s.pendingPlanApproval?.requestId).toBe("plan-1");
    const card = s.entriesByConversation["conv-1"]?.[0];
    expect(card?.kind).toBe("plan_approval");
    if (card?.kind === "plan_approval") expect(card.status).toBe("pending");
    expect(agentSetSessionMode).not.toHaveBeenCalled();
  });

  it("RPC 失败时把 ask_question 请求重新入队", async () => {
    agentRespondAskQuestion.mockRejectedValue(new Error("ask failed"));
    const ask = {
      sessionId: "sid-1",
      requestId: "ask-1",
      title: null as string | null,
      questions: [
        {
          id: "q1",
          prompt: "Which?",
          options: [{ id: "a", label: "A" }],
          allowMultiple: false,
        },
      ],
    };
    useAgentStore.setState({
      sessions: {
        "conv-1": { sessionId: "sid-1", conversationId: "conv-1", status: "waiting" },
      },
      askQuestionQueues: { "sid-1": [ask] },
      pendingAskQuestion: ask,
    });

    await useAgentStore.getState().respondAskQuestion("ask-1", "answered", [
      { questionId: "q1", selectedOptionIds: ["a"] },
    ]);

    const s = useAgentStore.getState();
    expect(s.error).toBe("ask failed");
    expect(s.askQuestionQueues["sid-1"]?.[0]?.requestId).toBe("ask-1");
    expect(s.pendingAskQuestion?.requestId).toBe("ask-1");
  });

  it("accept 成功后 handoff：切可执行模式并续跑", async () => {
    agentRespondPlan.mockResolvedValue(undefined);
    agentSetSessionMode.mockResolvedValue(undefined);
    agentSendPrompt.mockResolvedValue({ hadMutations: false });
    useAgentStore.setState({
      sessions: {
        "conv-1": { sessionId: "sid-1", conversationId: "conv-1", status: "idle" },
      },
      metaByConversation: {
        "conv-1": {
          modes: [
            { id: "plan", name: "Plan" },
            { id: "agent", name: "Agent" },
          ],
          currentModeId: "plan",
          models: [],
          currentModelId: null,
          configOptions: [],
          availableCommands: [],
          plan: null,
          contextUsage: null,
        },
      },
      planApprovalQueues: { "sid-1": [{ ...PLAN_PAYLOAD, todos: [...PLAN_PAYLOAD.todos] }] },
      pendingPlanApproval: { ...PLAN_PAYLOAD, todos: [...PLAN_PAYLOAD.todos] },
      entriesByConversation: {
        "conv-1": [
          {
            id: "card-1",
            kind: "plan_approval",
            timestamp: 1,
            requestId: "plan-1",
            plan: "1. do thing",
            todos: [],
            status: "pending",
          },
        ],
      },
    });

    await useAgentStore.getState().respondPlan("plan-1", "accepted");

    expect(agentSetSessionMode).toHaveBeenCalledWith("sid-1", "agent");
    expect(useAgentStore.getState().metaByConversation["conv-1"]?.currentModeId).toBe("agent");
    expect(agentSendPrompt).toHaveBeenCalledWith("sid-1", [
      { type: "text", text: "计划已确认，请开始执行。" },
    ]);
    const card = useAgentStore.getState().entriesByConversation["conv-1"]?.[0];
    if (card?.kind === "plan_approval") expect(card.status).toBe("accepted");
  });
});

describe("cancel marks pending plan cards", () => {
  it("cancel 将会话内 pending plan_approval 标为 cancelled", async () => {
    useAgentStore.setState({
      sessions: {
        "conv-1": { sessionId: "sid-1", conversationId: "conv-1", status: "waiting" },
      },
      planApprovalQueues: { "sid-1": [{ ...PLAN_PAYLOAD, todos: [...PLAN_PAYLOAD.todos] }] },
      pendingPlanApproval: { ...PLAN_PAYLOAD, todos: [...PLAN_PAYLOAD.todos] },
      entriesByConversation: {
        "conv-1": [
          {
            id: "card-1",
            kind: "plan_approval",
            timestamp: 1,
            requestId: "plan-1",
            plan: "x",
            todos: [],
            status: "pending",
          },
          {
            id: "card-2",
            kind: "plan_approval",
            timestamp: 2,
            requestId: "plan-old",
            plan: "y",
            todos: [],
            status: "accepted",
          },
        ],
      },
    });

    await useAgentStore.getState().cancel("sid-1");

    const entries = useAgentStore.getState().entriesByConversation["conv-1"] ?? [];
    const pending = entries.find((e) => e.kind === "plan_approval" && e.requestId === "plan-1");
    const kept = entries.find((e) => e.kind === "plan_approval" && e.requestId === "plan-old");
    if (pending?.kind === "plan_approval") expect(pending.status).toBe("cancelled");
    if (kept?.kind === "plan_approval") expect(kept.status).toBe("accepted");
    expect(useAgentStore.getState().planApprovalQueues["sid-1"]).toBeUndefined();
  });
});

describe("native auto /review", () => {
  it("mutating turn + autoReview 链式发送 /review（且 /review 自身不再链式）", async () => {
    agentSendPrompt
      .mockResolvedValueOnce({ hadMutations: true })
      .mockResolvedValueOnce({ hadMutations: true });
    useConversationStore.setState({
      conversationsByProject: {
        p1: [
          {
            id: "conv-1",
            project_id: "p1",
            title: "Chat",
            agent_type: "nex",
            status: "active",
            created_at: 1,
            updated_at: 1,
          },
        ],
      },
    });
    useAgentStore.setState({
      nativeAutoReview: true,
      sessions: {
        "conv-1": { sessionId: "sid-1", conversationId: "conv-1", status: "idle" },
      },
      entriesByConversation: {
        "conv-1": [{ id: "u1", kind: "user_message", text: "edit", timestamp: 1 }],
      },
    });

    await useAgentStore.getState().sendPrompt("sid-1", [{ type: "text", text: "edit files" }]);

    expect(agentSendPrompt).toHaveBeenCalledTimes(2);
    expect(agentSendPrompt).toHaveBeenNthCalledWith(1, "sid-1", [
      { type: "text", text: "edit files" },
    ]);
    expect(agentSendPrompt).toHaveBeenNthCalledWith(2, "sid-1", [
      { type: "text", text: "/review" },
    ]);
  });

  it("未改代码（hadMutations=false）不触发 auto /review", async () => {
    agentSendPrompt.mockResolvedValue({ hadMutations: false });
    useConversationStore.setState({
      conversationsByProject: {
        p1: [
          {
            id: "conv-1",
            project_id: "p1",
            title: "Chat",
            agent_type: "nex",
            status: "active",
            created_at: 1,
            updated_at: 1,
          },
        ],
      },
    });
    useAgentStore.setState({
      nativeAutoReview: true,
      sessions: {
        "conv-1": { sessionId: "sid-1", conversationId: "conv-1", status: "idle" },
      },
      entriesByConversation: {
        "conv-1": [{ id: "u1", kind: "user_message", text: "just ask", timestamp: 1 }],
      },
    });

    await useAgentStore.getState().sendPrompt("sid-1", [{ type: "text", text: "just ask" }]);
    expect(agentSendPrompt).toHaveBeenCalledTimes(1);
  });

  it("非 nex/native 会话不触发 auto /review", async () => {
    agentSendPrompt.mockResolvedValue({ hadMutations: true });
    useConversationStore.setState({
      conversationsByProject: {
        p1: [
          {
            id: "conv-1",
            project_id: "p1",
            title: "Chat",
            agent_type: "cursor",
            status: "active",
            created_at: 1,
            updated_at: 1,
          },
        ],
      },
    });
    useAgentStore.setState({
      nativeAutoReview: true,
      sessions: {
        "conv-1": { sessionId: "sid-1", conversationId: "conv-1", status: "idle" },
      },
      entriesByConversation: {
        "conv-1": [{ id: "u1", kind: "user_message", text: "edit", timestamp: 1 }],
      },
    });

    await useAgentStore.getState().sendPrompt("sid-1", [{ type: "text", text: "edit" }]);
    expect(agentSendPrompt).toHaveBeenCalledTimes(1);
  });
});
