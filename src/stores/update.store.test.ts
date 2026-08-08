import { beforeEach, describe, expect, it, vi } from "vitest";

const updateCheckLatest = vi.fn();
const updateDownloadAndInstall = vi.fn();
const onUpdateDownloadProgress = vi.fn();
const conversationReplaceThreadEntries = vi.fn();

vi.mock("../bridge/tauri", () => ({
  updateCheckLatest: (...args: unknown[]) => updateCheckLatest(...args),
  updateDownloadAndInstall: (...args: unknown[]) => updateDownloadAndInstall(...args),
  onUpdateDownloadProgress: (...args: unknown[]) => onUpdateDownloadProgress(...args),
  conversationCreate: vi.fn(),
  conversationList: vi.fn(),
  conversationGetMessages: vi.fn(),
  conversationUpdateTitle: vi.fn(),
  conversationAppendMessage: vi.fn(),
  conversationGetThreadEntries: vi.fn(),
  conversationReplaceThreadEntries: (...args: unknown[]) => conversationReplaceThreadEntries(...args),
  agentCreateSession: vi.fn(),
  agentSendPrompt: vi.fn().mockResolvedValue({ hadMutations: false }),
  nativeAgentGetConfig: vi.fn().mockResolvedValue({
    providers: [],
    agent: { maxSteps: 0, contextWindow: 0, bashTimeoutSecs: 120, maxSubagentConcurrency: 6, autoReview: false },
  }),
  agentCancel: vi.fn(),
  agentRespondPermission: vi.fn(),
  agentRespondPlan: vi.fn(),
  agentRespondAskQuestion: vi.fn(),
  agentCloseSession: vi.fn(),
  agentListServers: vi.fn(),
  agentListAllServers: vi.fn(),
  agentRefreshRegistry: vi.fn(),
  agentSetSessionMode: vi.fn(),
  agentSetSessionModel: vi.fn(),
  agentSetSessionConfigOption: vi.fn(),
  agentCustomUpsert: vi.fn(),
  agentCustomDelete: vi.fn(),
  onAgentNotification: () => Promise.resolve(() => {}),
  onAgentPermissionRequest: () => Promise.resolve(() => {}),
  onAgentPlanApprovalRequest: () => Promise.resolve(() => {}),
  onAgentAskQuestionRequest: () => Promise.resolve(() => {}),
  onAgentSessionTerminated: () => Promise.resolve(() => {}),
}));

vi.mock("./project.store", () => ({
  useProjectStore: { getState: () => ({ activeProjectId: null }) },
}));

import { useUpdateStore } from "./update.store";

const INFO_NEWER = {
  current_version: "1.0.0",
  latest_version: "1.1.0",
  update_available: true,
  release_name: "Nex v1.1.0",
  release_url: "https://github.com/jianjunx/nex/releases/tag/v1.1.0",
  release_notes: "",
  asset_name: "Nex_1.1.0_x64-setup.exe",
  asset_url: "https://github.com/jianjunx/nex/releases/download/v1.1.0/Nex_1.1.0_x64-setup.exe",
};

const INFO_CURRENT = { ...INFO_NEWER, latest_version: "1.0.0", update_available: false };

describe("update.store", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    onUpdateDownloadProgress.mockResolvedValue(() => {});
    useUpdateStore.setState({
      status: "idle",
      info: null,
      progress: null,
      error: null,
      bannerDismissed: false,
    });
  });

  it("手动检查发现新版本 → available 且横幅可再次出现", async () => {
    updateCheckLatest.mockResolvedValueOnce(INFO_NEWER);
    useUpdateStore.setState({ bannerDismissed: true });

    await useUpdateStore.getState().check(false);

    const s = useUpdateStore.getState();
    expect(s.status).toBe("available");
    expect(s.info?.latest_version).toBe("1.1.0");
    expect(s.bannerDismissed).toBe(false);
  });

  it("手动检查无更新 → up-to-date", async () => {
    updateCheckLatest.mockResolvedValueOnce(INFO_CURRENT);

    await useUpdateStore.getState().check(false);

    expect(useUpdateStore.getState().status).toBe("up-to-date");
  });

  it("静默检查无更新 → 保持 idle（不弹提示）", async () => {
    updateCheckLatest.mockResolvedValueOnce(INFO_CURRENT);

    await useUpdateStore.getState().check(true);

    expect(useUpdateStore.getState().status).toBe("idle");
  });

  it("静默检查失败 → 静默回 idle，不写 error", async () => {
    updateCheckLatest.mockRejectedValueOnce(new Error("network down"));

    await useUpdateStore.getState().check(true);

    const s = useUpdateStore.getState();
    expect(s.status).toBe("idle");
    expect(s.error).toBeNull();
  });

  it("手动检查失败 → error 状态带原因", async () => {
    updateCheckLatest.mockRejectedValueOnce(new Error("查询更新失败: GitHub 返回 403"));

    await useUpdateStore.getState().check(false);

    const s = useUpdateStore.getState();
    expect(s.status).toBe("error");
    expect(s.error).toContain("403");
  });

  it("检查进行中时重复调用被忽略", async () => {
    let resolveCheck!: (v: unknown) => void;
    updateCheckLatest.mockReturnValueOnce(new Promise((r) => (resolveCheck = r)));

    const first = useUpdateStore.getState().check(false);
    await useUpdateStore.getState().check(false);
    expect(updateCheckLatest).toHaveBeenCalledTimes(1);

    resolveCheck(INFO_CURRENT);
    await first;
    expect(useUpdateStore.getState().status).toBe("up-to-date");
  });

  it("无当前平台安装包时下载给出明确错误", async () => {
    useUpdateStore.setState({
      status: "available",
      info: { ...INFO_NEWER, asset_name: null, asset_url: null },
    });

    await useUpdateStore.getState().downloadAndInstall();

    const s = useUpdateStore.getState();
    expect(s.status).toBe("error");
    expect(s.error).toContain("没有当前平台的安装包");
    expect(updateDownloadAndInstall).not.toHaveBeenCalled();
  });

  it("下载安装透传资产信息并监听进度", async () => {
    updateDownloadAndInstall.mockResolvedValueOnce(undefined);
    useUpdateStore.setState({ status: "available", info: INFO_NEWER });

    await useUpdateStore.getState().downloadAndInstall();

    expect(updateDownloadAndInstall).toHaveBeenCalledWith(INFO_NEWER.asset_url, INFO_NEWER.asset_name);
    expect(onUpdateDownloadProgress).toHaveBeenCalledTimes(1);
  });
});
