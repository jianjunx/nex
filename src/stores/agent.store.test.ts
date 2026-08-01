import { beforeEach, describe, expect, it, vi } from "vitest";

// mock 桥接层：模块级可变 fn + 工厂闭包延迟读取（调用时才命中当前 mock 实现）。
const agentListServers = vi.fn();
const agentListAllServers = vi.fn();
vi.mock("../bridge/tauri", () => ({
  agentListServers: (...args: unknown[]) => agentListServers(...args),
  agentListAllServers: (...args: unknown[]) => agentListAllServers(...args),
}));

import { useAgentStore } from "./agent.store";

const SERVER = { id: "s1", name: "测试智能体", version: "1.0", description: "", icon: null, kind: "registry" };

beforeEach(() => {
  vi.clearAllMocks();
  // 每例前把打点相关字段重置回初始态（store 为单例）。
  useAgentStore.setState({
    servers: [],
    serversLoading: false,
    serversLoadedAt: 0,
    error: null,
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
