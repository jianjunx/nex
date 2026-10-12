import { beforeEach, describe, expect, it, vi } from "vitest";

const dialogOpen = vi.fn();
const fsWatchStart = vi.fn();
const restoreProjectConversationTabs = vi.fn();
const startNewTask = vi.fn();

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: (...args: unknown[]) => dialogOpen(...args),
}));
vi.mock("../../bridge/tauri", () => ({
  fsWatchStart: (...args: unknown[]) => fsWatchStart(...args),
}));
vi.mock("./restoreProjectConversationTabs", () => ({
  restoreProjectConversationTabs: (...args: unknown[]) => restoreProjectConversationTabs(...args),
}));
vi.mock("./startTask", () => ({
  startNewTask: (...args: unknown[]) => startNewTask(...args),
}));
vi.mock("./activateProject", () => ({
  resetFsSelectionForProjectSwitch: vi.fn(),
}));

import { openProjectFolder } from "./openProjectFolder";
import { useProjectStore } from "../../stores/project.store";
import { useFsStore } from "../../stores/fs.store";

const project = {
  id: "p2",
  name: "beta",
  path: "/tmp/beta",
  created_at: 0,
  last_opened: 0,
};

describe("openProjectFolder", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dialogOpen.mockResolvedValue("/tmp/beta");
    fsWatchStart.mockResolvedValue(undefined);
    restoreProjectConversationTabs.mockResolvedValue(undefined);
    startNewTask.mockResolvedValue(undefined);

    useProjectStore.setState({
      projects: [project],
      activeProjectId: "p2",
      loading: false,
      error: null,
      openProject: vi.fn().mockResolvedValue(undefined),
    });
    useFsStore.setState({
      saveCurrentEditorState: vi.fn().mockResolvedValue(undefined),
      loadEditorState: vi.fn().mockResolvedValue(undefined),
      switchSearchProject: vi.fn(),
      clearTreeExcept: vi.fn(),
    });
  });

  it("starts a task in the newly opened project by default", async () => {
    await openProjectFolder();

    expect(startNewTask).toHaveBeenCalledTimes(1);
    expect(startNewTask).toHaveBeenCalledWith(project);
  });

  it("skips the auto task when the caller moves its own draft over", async () => {
    await openProjectFolder({ startTask: false });

    expect(startNewTask).not.toHaveBeenCalled();
  });

  it("does nothing when the folder dialog is cancelled", async () => {
    dialogOpen.mockResolvedValue(null);

    await openProjectFolder();

    expect(startNewTask).not.toHaveBeenCalled();
  });

  it("surfaces the open error instead of starting a task", async () => {
    useProjectStore.setState({ error: "boom" });

    await expect(openProjectFolder()).rejects.toThrow("boom");
    expect(startNewTask).not.toHaveBeenCalled();
  });
});
