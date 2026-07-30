/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

// 受控假 store：组件以 useAgentStore() 解构方式消费。
const loadAllServers = vi.fn().mockResolvedValue(undefined);
let fakeAgent: {
  servers: { id: string; name: string; kind: string; version?: string; description?: string }[];
  serversLoading: boolean;
  serversLoadedAt: number;
};
vi.mock("../../../stores/agent.store", () => ({
  useAgentStore: () => ({
    ...fakeAgent,
    loadAllServers,
    refreshRegistry: vi.fn().mockResolvedValue(undefined),
    upsertCustom: vi.fn().mockResolvedValue(undefined),
    deleteCustom: vi.fn().mockResolvedValue(undefined),
  }),
}));

import { AgentsSection } from "./AgentsSection";

beforeEach(() => {
  vi.clearAllMocks();
  fakeAgent = { servers: [], serversLoading: false, serversLoadedAt: 0 };
});

// vitest 未开 globals，RTL 自动清理不生效；仓库既有 jsdom 测试均显式 cleanup。
afterEach(() => {
  cleanup();
});

const SERVER = { id: "s1", name: "测试智能体", kind: "registry" };

describe("AgentsSection mount loading (M-6)", () => {
  it("loads when the list is empty", () => {
    render(<AgentsSection />);
    expect(loadAllServers).toHaveBeenCalledTimes(1);
  });

  it("skips loading when the list is fresh (< 60s)", () => {
    fakeAgent = { servers: [SERVER], serversLoading: false, serversLoadedAt: Date.now() - 10_000 };
    render(<AgentsSection />);
    expect(loadAllServers).not.toHaveBeenCalled();
  });

  it("loads when the list is stale (≥ 60s)", () => {
    fakeAgent = { servers: [SERVER], serversLoading: false, serversLoadedAt: Date.now() - 70_000 };
    render(<AgentsSection />);
    expect(loadAllServers).toHaveBeenCalledTimes(1);
  });

  it("skips loading when a load is already in flight", () => {
    fakeAgent = { servers: [], serversLoading: true, serversLoadedAt: 0 };
    render(<AgentsSection />);
    expect(loadAllServers).not.toHaveBeenCalled();
  });
});

describe("AgentsSection copy (M-5)", () => {
  it("uses Chinese labels for the registry controls", () => {
    fakeAgent = { servers: [{ ...SERVER, kind: "custom" }], serversLoading: false, serversLoadedAt: Date.now() };
    render(<AgentsSection />);
    expect(screen.getByTitle("刷新智能体注册表")).toBeTruthy();
    expect(screen.getByTitle("移除自定义智能体")).toBeTruthy();
  });
});
