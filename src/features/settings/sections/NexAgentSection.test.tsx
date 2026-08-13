/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { NativeAgentConfig } from "../../../bridge/tauri";

const nativeAgentGetConfig = vi.fn();
const nativeAgentSetConfig = vi.fn();
const nativeAgentListMcp = vi.fn().mockResolvedValue([]);
const nativeAgentListSkills = vi.fn().mockResolvedValue([]);
const nativeAgentListModels = vi.fn().mockResolvedValue([]);
const nativeAgentProbeReasoning = vi.fn();
const nativeAgentProbeMcp = vi.fn();
const nativeAgentSetMcpEnabled = vi.fn();
const nativeAgentDeleteMcp = vi.fn();
const nativeAgentUpsertMcp = vi.fn();
const nativeAgentSetSkillEnabled = vi.fn();
const nativeAgentDeleteSkill = vi.fn();
const nativeAgentOpenSkillsDir = vi.fn();
const refreshNativeAutoReview = vi.fn().mockResolvedValue(undefined);

vi.mock("../../../bridge/tauri", () => ({
  nativeAgentDeleteMcp: (...args: unknown[]) => nativeAgentDeleteMcp(...args),
  nativeAgentDeleteSkill: (...args: unknown[]) => nativeAgentDeleteSkill(...args),
  nativeAgentGetConfig: (...args: unknown[]) => nativeAgentGetConfig(...args),
  nativeAgentListMcp: (...args: unknown[]) => nativeAgentListMcp(...args),
  nativeAgentListModels: (...args: unknown[]) => nativeAgentListModels(...args),
  nativeAgentListSkills: (...args: unknown[]) => nativeAgentListSkills(...args),
  nativeAgentOpenSkillsDir: (...args: unknown[]) => nativeAgentOpenSkillsDir(...args),
  nativeAgentProbeMcp: (...args: unknown[]) => nativeAgentProbeMcp(...args),
  nativeAgentProbeReasoning: (...args: unknown[]) => nativeAgentProbeReasoning(...args),
  nativeAgentSetConfig: (...args: unknown[]) => nativeAgentSetConfig(...args),
  nativeAgentSetMcpEnabled: (...args: unknown[]) => nativeAgentSetMcpEnabled(...args),
  nativeAgentSetSkillEnabled: (...args: unknown[]) => nativeAgentSetSkillEnabled(...args),
  nativeAgentUpsertMcp: (...args: unknown[]) => nativeAgentUpsertMcp(...args),
}));

vi.mock("../../../stores/agent.store", () => ({
  useAgentStore: {
    getState: () => ({ refreshNativeAutoReview }),
  },
}));

import { NexAgentSection } from "./NexAgentSection";

const baseConfig: NativeAgentConfig = {
  providers: [],
  defaultModel: null,
  agent: {
    maxSteps: 0,
    contextWindow: 0,
    bashTimeoutSecs: 120,
    maxSubagentConcurrency: 6,
    autoReview: false,
  },
  disabledSkills: [],
  disabledMcpServers: [],
};

describe("NexAgentSection auto-saving", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    nativeAgentGetConfig.mockResolvedValue(structuredClone(baseConfig));
    nativeAgentSetConfig.mockResolvedValue(undefined);
    nativeAgentListMcp.mockResolvedValue([]);
    nativeAgentListSkills.mockResolvedValue([]);
    refreshNativeAutoReview.mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
  });

  it("auto-saves a new provider from the add dialog and hides the outer save button on the providers tab", async () => {
    render(<NexAgentSection />);

    await screen.findByText("尚未配置供应商");
    expect(screen.queryByRole("button", { name: "保存" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "添加供应商" }));
    fireEvent.change(screen.getByPlaceholderText("如 DeepSeek"), { target: { value: "OpenAI" } });
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "添加供应商" }));

    await waitFor(() => expect(nativeAgentSetConfig).toHaveBeenCalledTimes(1));
    expect(nativeAgentSetConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        providers: [
          expect.objectContaining({
            name: "OpenAI",
            baseUrl: "https://api.deepseek.com/v1",
          }),
        ],
      }),
    );
    expect(refreshNativeAutoReview).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole("heading", { name: "添加供应商" })).toBeNull());
  });

  it("keeps advanced draft changes out of provider auto-save", async () => {
    let releaseFirstSave: () => void = () => {};
    nativeAgentSetConfig.mockImplementationOnce(
      () => new Promise<void>((resolve) => { releaseFirstSave = resolve; }),
    );

    render(<NexAgentSection />);

    await screen.findByText("尚未配置供应商");
    fireEvent.click(screen.getByRole("button", { name: "高级" }));
    fireEvent.change(screen.getByLabelText("最大步数"), { target: { value: "9" } });
    await waitFor(() => expect(nativeAgentSetConfig).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: "模型供应商" }));
    await screen.findByRole("button", { name: "添加供应商" });
    fireEvent.click(screen.getByRole("button", { name: "添加供应商" }));

    const dialog = screen.getByRole("dialog");
    fireEvent.change(screen.getByPlaceholderText("如 DeepSeek"), { target: { value: "OpenAI" } });
    expect((within(dialog).getByRole("button", { name: "保存中…" }) as HTMLButtonElement).disabled).toBe(true);
    expect(nativeAgentSetConfig).toHaveBeenCalledTimes(1);
    expect(nativeAgentSetConfig.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        providers: [],
        agent: expect.objectContaining({ maxSteps: 9 }),
      }),
    );

    releaseFirstSave();
    await waitFor(() => {
      const submit = within(dialog).getByRole("button", { name: "添加供应商" }) as HTMLButtonElement;
      expect(submit.disabled).toBe(false);
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "添加供应商" }));

    await waitFor(() => expect(nativeAgentSetConfig).toHaveBeenCalledTimes(2));
    expect(nativeAgentSetConfig).toHaveBeenLastCalledWith(
      expect.objectContaining({
        providers: [expect.objectContaining({ name: "OpenAI" })],
        agent: expect.objectContaining({ maxSteps: 9 }),
      }),
    );
  });

  it("shows provider save errors without closing the dialog", async () => {
    nativeAgentSetConfig.mockRejectedValueOnce(new Error("save failed"));
    render(<NexAgentSection />);

    await screen.findByText("尚未配置供应商");
    fireEvent.click(screen.getByRole("button", { name: "添加供应商" }));
    fireEvent.change(screen.getByPlaceholderText("如 DeepSeek"), { target: { value: "OpenAI" } });
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "添加供应商" }));

    await within(screen.getByRole("dialog")).findByText("save failed");
    expect(screen.getByRole("heading", { name: "添加供应商" })).toBeTruthy();
    expect(nativeAgentSetConfig).toHaveBeenCalledTimes(1);
  });

  it("auto-saves advanced maxSteps changes and keeps the save button hidden", async () => {
    render(<NexAgentSection />);

    await screen.findByText("尚未配置供应商");
    fireEvent.click(screen.getByRole("button", { name: "高级" }));
    expect(screen.queryByRole("button", { name: "保存" })).toBeNull();

    fireEvent.change(screen.getByLabelText("最大步数"), { target: { value: "9" } });

    await waitFor(() => expect(nativeAgentSetConfig).toHaveBeenCalledTimes(1));
    expect(nativeAgentSetConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: expect.objectContaining({ maxSteps: 9 }),
      }),
    );
    expect(refreshNativeAutoReview).toHaveBeenCalledTimes(1);
  });

  it("reverts advanced changes when auto-save fails", async () => {
    nativeAgentSetConfig.mockRejectedValueOnce(new Error("advanced save failed"));
    render(<NexAgentSection />);

    await screen.findByText("尚未配置供应商");
    fireEvent.click(screen.getByRole("button", { name: "高级" }));
    const input = screen.getByLabelText("最大步数") as HTMLInputElement;
    expect(input.value).toBe("0");

    fireEvent.change(input, { target: { value: "9" } });

    await screen.findByText("advanced save failed");
    expect(input.value).toBe("0");
    expect(nativeAgentSetConfig).toHaveBeenCalledTimes(1);
  });

  it("auto-saves provider deletion and clears the default model when it belonged to that provider", async () => {
    nativeAgentGetConfig.mockResolvedValue({
      ...structuredClone(baseConfig),
      providers: [
        {
          id: "provider-1",
          name: "DeepSeek",
          baseUrl: "https://api.deepseek.com/v1",
          apiKey: "secret",
          models: [
            {
              id: "deepseek-chat",
              reasoningSupport: "unknown",
              capabilities: { tools: true, vision: false, reasoning: false },
              reasoningLevels: [],
              contextWindow: null,
              reasoningManual: false,
              reasoningSource: "none",
            },
          ],
        },
      ],
      defaultModel: "provider-1/deepseek-chat",
    });

    render(<NexAgentSection />);

    await screen.findByText("DeepSeek");
    fireEvent.click(screen.getByRole("link", { name: "编辑" }));
    fireEvent.click(await screen.findByRole("button", { name: /删除供应商/ }));

    await waitFor(() => expect(nativeAgentSetConfig).toHaveBeenCalledTimes(1));
    expect(nativeAgentSetConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        providers: [],
        defaultModel: null,
      }),
    );
    expect(refreshNativeAutoReview).toHaveBeenCalledTimes(1);
  });
});

const sampleMcp = {
  name: "filesystem",
  command: "npx",
  args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
  env: {},
  url: null,
  headers: {},
  enabled: true,
  source: "user",
};

const sampleSkill = {
  name: "my-skill",
  description: "does things",
  enabled: true,
  source: "user" as const,
};

describe("NexAgentSection MCP and skills", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    nativeAgentGetConfig.mockResolvedValue(structuredClone(baseConfig));
    nativeAgentSetConfig.mockResolvedValue(undefined);
    nativeAgentListMcp.mockResolvedValue([]);
    nativeAgentListSkills.mockResolvedValue([]);
    nativeAgentProbeMcp.mockResolvedValue("connected:2 tools");
    nativeAgentUpsertMcp.mockResolvedValue(undefined);
    nativeAgentSetMcpEnabled.mockResolvedValue(undefined);
    nativeAgentDeleteMcp.mockResolvedValue(undefined);
    nativeAgentSetSkillEnabled.mockResolvedValue(undefined);
    nativeAgentDeleteSkill.mockResolvedValue(undefined);
    nativeAgentOpenSkillsDir.mockResolvedValue(undefined);
    refreshNativeAutoReview.mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
  });

  it("auto-probes enabled MCP servers and shows connected status in green", async () => {
    nativeAgentListMcp.mockResolvedValue([sampleMcp]);
    render(<NexAgentSection />);

    fireEvent.click(await screen.findByRole("button", { name: "MCP" }));
    await waitFor(() => expect(nativeAgentProbeMcp).toHaveBeenCalledWith("filesystem"));
    const status = await screen.findByText("connected:2 tools");
    expect(status.className).toContain("text-[var(--success)]");
    expect(screen.getByRole("button", { name: "探测 filesystem" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "删除 filesystem" })).toBeTruthy();
    expect(screen.getByRole("switch", { name: "启用 filesystem" })).toBeTruthy();
  });

  it("adds MCP servers from JSON", async () => {
    nativeAgentUpsertMcp.mockImplementation(async () => {
      nativeAgentListMcp.mockResolvedValue([sampleMcp]);
    });
    render(<NexAgentSection />);

    fireEvent.click(await screen.findByRole("button", { name: "MCP" }));
    fireEvent.click(await screen.findByRole("button", { name: /添加 MCP/ }));
    const textarea = await screen.findByLabelText("MCP JSON");
    fireEvent.change(textarea, {
      target: {
        value: JSON.stringify({
          mcpServers: {
            filesystem: { command: "npx", args: ["-y", "pkg"] },
          },
        }),
      },
    });
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "添加" }));

    await waitFor(() => expect(nativeAgentUpsertMcp).toHaveBeenCalledTimes(1));
    expect(nativeAgentUpsertMcp).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "filesystem",
        command: "npx",
        args: ["-y", "pkg"],
      }),
    );
    await waitFor(() => expect(screen.queryByRole("heading", { name: "添加 MCP 服务器" })).toBeNull());
    await screen.findByText("filesystem");
  });

  it("toggles MCP with a switch and deletes with the icon button", async () => {
    nativeAgentListMcp.mockResolvedValue([sampleMcp]);
    nativeAgentSetMcpEnabled.mockImplementation(async (_name: unknown, enabled: unknown) => {
      nativeAgentListMcp.mockResolvedValue([{ ...sampleMcp, enabled: Boolean(enabled) }]);
    });
    nativeAgentDeleteMcp.mockImplementation(async () => {
      nativeAgentListMcp.mockResolvedValue([]);
    });
    render(<NexAgentSection />);

    fireEvent.click(await screen.findByRole("button", { name: "MCP" }));
    await screen.findByText("filesystem");
    fireEvent.click(screen.getByRole("switch", { name: "启用 filesystem" }));
    await waitFor(() => expect(nativeAgentSetMcpEnabled).toHaveBeenCalledWith("filesystem", false));
    await screen.findByText("已禁用");

    fireEvent.click(screen.getByRole("button", { name: "删除 filesystem" }));
    await waitFor(() => expect(nativeAgentDeleteMcp).toHaveBeenCalledWith("filesystem"));
    await screen.findByText("尚未配置 MCP 服务器");
  });

  it("toggles skills with a switch and deletes user skills with an icon button", async () => {
    nativeAgentListSkills.mockResolvedValue([sampleSkill]);
    nativeAgentSetSkillEnabled.mockImplementation(async (_name: unknown, enabled: unknown) => {
      nativeAgentListSkills.mockResolvedValue([{ ...sampleSkill, enabled: Boolean(enabled) }]);
    });
    nativeAgentDeleteSkill.mockImplementation(async () => {
      nativeAgentListSkills.mockResolvedValue([]);
    });
    render(<NexAgentSection />);

    fireEvent.click(await screen.findByRole("button", { name: "技能" }));
    await screen.findByText("my-skill");
    expect(screen.queryByRole("button", { name: "删除" })).toBeNull();
    fireEvent.click(screen.getByRole("switch", { name: "启用 my-skill" }));
    await waitFor(() => expect(nativeAgentSetSkillEnabled).toHaveBeenCalledWith("my-skill", false));

    fireEvent.click(screen.getByRole("button", { name: "删除 my-skill" }));
    await waitFor(() => expect(nativeAgentDeleteSkill).toHaveBeenCalledWith("my-skill"));
    await screen.findByText(/暂无技能/);
  });
});
