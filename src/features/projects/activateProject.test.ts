import { beforeEach, describe, expect, it, vi } from "vitest";

const fsWatchStart = vi.fn();
const restoreProjectConversationTabs = vi.fn();

vi.mock("../../bridge/tauri", () => ({
  fsWatchStart: (...args: unknown[]) => fsWatchStart(...args),
}));

vi.mock("./restoreProjectConversationTabs", () => ({
  restoreProjectConversationTabs: (...args: unknown[]) => restoreProjectConversationTabs(...args),
}));

import { activateProject } from "./activateProject";
import { useAgentStore } from "../../stores/agent.store";
import { useClipboardStore } from "../../stores/clipboard.store";
import { useConversationStore } from "../../stores/conversation.store";
import { useFsStore } from "../../stores/fs.store";
import { useProjectStore } from "../../stores/project.store";

const projectA = { id: "p1", name: "alpha", path: "/tmp/alpha", created_at: 0, last_opened: 0 };
const projectB = { id: "p2", name: "beta", path: "/tmp/beta", created_at: 0, last_opened: 0 };

describe("activateProject", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fsWatchStart.mockResolvedValue(undefined);
    restoreProjectConversationTabs.mockResolvedValue(undefined);

    useProjectStore.setState({
      projects: [projectA, projectB],
      activeProjectId: "p1",
      loading: false,
      error: null,
      switchProject: vi.fn(),
    });

    useConversationStore.setState({
      conversationsByProject: {
        p2: [
          { id: "conv-old", project_id: "p2", title: "old", agent_type: "nex", status: "idle", created_at: 0, updated_at: 5 },
          { id: "conv-active", project_id: "p2", title: "active", agent_type: "nex", status: "idle", created_at: 0, updated_at: 10 },
        ],
      },
      tabsByProject: { p2: ["conv-active", "conv-old"] },
      activeTabByProject: { p2: "conv-active" },
      messagesByConversation: {},
      loading: false,
      error: null,
    });

    useAgentStore.setState({
      sessions: {},
      pruneEntriesExcept: vi.fn(),
    });

    useFsStore.setState({
      saveCurrentEditorState: vi.fn().mockResolvedValue(undefined),
      loadEditorState: vi.fn().mockResolvedValue(undefined),
      clearTreeExcept: vi.fn(),
      switchSearchProject: vi.fn(),
    });

    useClipboardStore.setState({ entries: [] });
  });

  it("keeps the restored active tab instead of switching to latest", async () => {
    const switchTab = vi.spyOn(useConversationStore.getState(), "switchTab");

    await activateProject(projectB);

    expect(useConversationStore.getState().activeTabByProject.p2).toBe("conv-active");
    expect(switchTab).not.toHaveBeenCalled();
  });

  it("falls back to the most recent open tab when no active tab is restored", async () => {
    useConversationStore.setState({
      tabsByProject: { p2: ["conv-old", "conv-active"] },
      activeTabByProject: { p2: null },
    });

    const switchTab = vi.spyOn(useConversationStore.getState(), "switchTab");

    await activateProject(projectB);

    expect(switchTab).toHaveBeenCalledWith("conv-active");
  });
});
