// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useProjectStore } from "@/stores/project.store";
import { useConversationStore } from "@/stores/conversation.store";
import { WorkspaceSidebar } from "./WorkspaceSidebar";
import { activateProject } from "../projects/activateProject";
import { startNewTask } from "../projects/startTask";

vi.mock("../projects/NewConversationDropdown", () => ({
  NewConversationDropdown: () => null,
}));
vi.mock("../projects/ProjectSelector", () => ({ ProjectSelector: () => null }));
vi.mock("../projects/startTask", () => ({
  startNewTask: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../projects/activateProject", () => ({ activateProject: vi.fn() }));
vi.mock("../projects/restoreProjectConversationTabs", () => ({
  restoreProjectConversationTabs: vi.fn(),
}));
afterEach(cleanup);
beforeEach(() => {
  vi.mocked(activateProject).mockImplementation(async (project) => {
    useProjectStore.setState({ activeProjectId: project.id });
  });
  useProjectStore.setState({
    activeProjectId: "p1",
    projects: ["p1", "p2"].map((id) => ({
      id,
      name: id,
      path: "/" + id,
      created_at: 0,
      last_opened: 0,
    })),
  });
  useConversationStore.setState({
    conversationsByProject: Object.fromEntries(
      ["p1", "p2"].map((id) => [
        id,
        [
          {
            id: "c" + id,
            project_id: id,
            title: "任务 " + id,
            agent_type: "nex",
            status: "active",
            created_at: 0,
            updated_at: 0,
          },
        ],
      ]),
    ),
    tabsByProject: { p1: ["cp1"], p2: ["cp2"] },
    activeTabByProject: { p1: "cp1", p2: "cp2" },
  });
});
it("groups conversations by project instead of recent tasks and tabs", async () => {
  render(<WorkspaceSidebar />);
  expect(screen.queryByText(/最近任务/)).toBeNull();
  expect(screen.getByRole("navigation", { name: "项目与会话" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "任务 p2" }));
  await waitFor(() =>
    expect(useProjectStore.getState().activeProjectId).toBe("p2"),
  );
  await waitFor(() =>
    expect(
      screen
        .getByRole("button", { name: "任务 p2" })
        .getAttribute("aria-current"),
    ).toBe("page"),
  );
  expect(activateProject).toHaveBeenCalledWith(
    expect.objectContaining({ id: "p2" }),
  );
});
it("collapses the current project without deleting its conversations", () => {
  render(<WorkspaceSidebar />);
  fireEvent.click(screen.getByRole("button", { name: "p1" }));
  expect(screen.queryByRole("button", { name: "任务 p1" })).toBeNull();
  expect(
    useConversationStore.getState().conversationsByProject.p1,
  ).toHaveLength(1);
});

it("adds a new-task button at the end of each project row", async () => {
  render(<WorkspaceSidebar />);
  fireEvent.click(screen.getByRole("button", { name: "在 p2 中新建任务" }));
  await waitFor(() =>
    expect(startNewTask).toHaveBeenCalledWith(
      expect.objectContaining({ id: "p2" }),
    ),
  );
});
it("shows the agent icon before each conversation title", () => {
  render(<WorkspaceSidebar />);
  const row = screen.getByRole("button", { name: "任务 p1" });
  expect(row.querySelector("svg[aria-label='Nex agent']")).toBeTruthy();
});
it("deletes a conversation only after confirmation", async () => {
  render(<WorkspaceSidebar />);
  fireEvent.click(screen.getByRole("button", { name: "删除对话 任务 p1" }));
  expect(await screen.findByText("删除对话？")).toBeTruthy();
  expect(
    useConversationStore.getState().conversationsByProject.p1,
  ).toHaveLength(1);
});
