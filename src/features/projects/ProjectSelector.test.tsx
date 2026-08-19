/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { ProjectSelector } from "./ProjectSelector";
import { useProjectStore } from "../../stores/project.store";
import { useConversationStore } from "../../stores/conversation.store";
import { useAgentStore } from "../../stores/agent.store";
import { useFsStore } from "../../stores/fs.store";
import type { Project } from "../../bridge/tauri";

type RemoveProjectFn = (id: string) => Promise<void>;
type RemoveProjectDataFn = (projectId: string) => void;
type SwitchProjectFn = (id: string) => void;
type PruneEntriesFn = (keep: Set<string>) => void;
type SaveEditorFn = (id: string) => Promise<void>;
type LoadEditorFn = (id: string) => Promise<void>;
type ClearTreeFn = (path: string) => void;
type SwitchSearchFn = (id: string | null) => void;

let removeProjectMock: Mock<RemoveProjectFn>;
let removeProjectDataMock: Mock<RemoveProjectDataFn>;
let switchProjectMock: Mock<SwitchProjectFn>;
let pruneEntriesMock: Mock<PruneEntriesFn>;
let saveEditorMock: Mock<SaveEditorFn>;
let loadEditorMock: Mock<LoadEditorFn>;
let clearTreeMock: Mock<ClearTreeFn>;
let switchSearchMock: Mock<SwitchSearchFn>;

const P1: Project = { id: "p1", name: "alpha", path: "/tmp/alpha", created_at: 0, last_opened: 2 };
const P2: Project = { id: "p2", name: "beta", path: "/tmp/beta", created_at: 0, last_opened: 1 };

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn().mockResolvedValue(null),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ setFocus: vi.fn().mockResolvedValue(undefined) }),
}));
vi.mock("../../bridge/tauri", () => ({
  fsWatchStart: vi.fn().mockResolvedValue(undefined),
  projectRemove: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("./restoreProjectConversationTabs", () => ({
  restoreProjectConversationTabs: vi.fn().mockResolvedValue(undefined),
}));

beforeEach(() => {
  removeProjectMock = vi.fn<RemoveProjectFn>().mockResolvedValue(undefined);
  removeProjectDataMock = vi.fn<RemoveProjectDataFn>();
  switchProjectMock = vi.fn<SwitchProjectFn>();
  pruneEntriesMock = vi.fn<PruneEntriesFn>();
  saveEditorMock = vi.fn<SaveEditorFn>().mockResolvedValue(undefined);
  loadEditorMock = vi.fn<LoadEditorFn>().mockResolvedValue(undefined);
  clearTreeMock = vi.fn<ClearTreeFn>();
  switchSearchMock = vi.fn<SwitchSearchFn>();

  useProjectStore.setState({
    projects: [P1, P2],
    activeProjectId: "p1",
    loading: false,
    error: null,
    switchProject: switchProjectMock,
    removeProject: removeProjectMock,
  });
  useConversationStore.setState({
    conversationsByProject: { p2: [{ id: "c1", project_id: "p2", title: "t", agent_type: "nex", status: "idle", created_at: 0, updated_at: 0 }] },
    tabsByProject: {},
    activeTabByProject: {},
    removeProjectData: removeProjectDataMock,
  });
  useAgentStore.setState({
    sessions: {},
    pruneEntriesExcept: pruneEntriesMock,
  });
  useFsStore.setState({
    saveCurrentEditorState: saveEditorMock,
    loadEditorState: loadEditorMock,
    clearTreeExcept: clearTreeMock,
    switchSearchProject: switchSearchMock,
  });
});
afterEach(() => cleanup());

function openDropdown() {
  render(<ProjectSelector />);
  fireEvent.pointerDown(screen.getByRole("button", { name: /alpha/ }));
}

describe("ProjectSelector dropdown", () => {
  it("底部动作为打开文件夹", () => {
    openDropdown();
    expect(screen.getByRole("menuitem", { name: /打开文件夹/ })).toBeTruthy();
  });

  it("非当前项目显示 X，点击后移除项目且不切换当前项目", async () => {
    openDropdown();
    // beta 行有 X 按钮
    const x = screen.getByRole("button", { name: "从项目列表移除 beta" });
    expect(x).toBeTruthy();
    // 模拟真机事件序列：pointerdown 必须正常冒泡到 MenuItem（Radix 用它标记
    // isPointerDown），否则 pointerup 时 Radix 会手动 click 整行触发 onSelect。
    fireEvent.pointerDown(x);
    fireEvent.pointerUp(x);
    fireEvent.click(x);
    await waitFor(() => expect(removeProjectMock).toHaveBeenCalledWith("p2"));
    expect(removeProjectDataMock).toHaveBeenCalledWith("p2");
    expect(switchProjectMock).not.toHaveBeenCalled();
    expect(useProjectStore.getState().activeProjectId).toBe("p1");
  });

  it("当前激活项目不渲染 X 按钮", async () => {
    openDropdown();
    expect(screen.queryByRole("button", { name: "从项目列表移除 alpha" })).toBeNull();
  });

  it("does not render project status dots", () => {
    useConversationStore.setState({
      conversationsByProject: {
        p1: [
          {
            id: "c-running",
            project_id: "p1",
            title: "running",
            agent_type: "nex",
            status: "active",
            created_at: 0,
            updated_at: 0,
          },
        ],
      },
    });
    useAgentStore.setState({
      sessions: {
        "c-running": { sessionId: "s1", conversationId: "c-running", status: "running" },
      },
    });

    render(<ProjectSelector />);
    expect(screen.queryByTitle("Agent 运行中")).toBeNull();
    expect(screen.queryByTitle("Agent 等待中")).toBeNull();
  });

  it("renders project rows without a leading monogram badge", () => {
    openDropdown();
    const alphaRow = screen.getByRole("menuitem", { name: /alpha/i });
    expect(alphaRow.textContent?.trim().startsWith("alpha")).toBe(true);
  });
});
