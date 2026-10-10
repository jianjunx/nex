// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NewTaskBar } from "./NewTaskBar";
import { useAgentStore } from "@/stores/agent.store";
import { useConversationStore } from "@/stores/conversation.store";
import { useProjectStore } from "@/stores/project.store";
import { moveDraftToProject } from "../projects/startTask";

vi.mock("../projects/startTask", () => ({
  moveDraftToProject: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../projects/openProjectFolder", () => ({
  openProjectFolder: vi.fn().mockResolvedValue(undefined),
}));

const projects = ["p1", "p2"].map((id) => ({
  id,
  name: id,
  path: "/" + id,
  created_at: 0,
  last_opened: 0,
}));
const conversation = {
  id: "c",
  project_id: "p1",
  title: "New Chat",
  agent_type: "nex",
  status: "active",
  created_at: 0,
  updated_at: 0,
};

beforeEach(() => {
  vi.clearAllMocks();
  useProjectStore.setState({ projects, activeProjectId: "p1" });
  useAgentStore.setState({
    sessions: {},
    entriesByConversation: {},
    pendingMessagesByConversation: {},
    servers: [
      { id: "other", name: "Other", kind: "registry", version: "1", description: "", icon: null },
    ],
  });
  useConversationStore.setState({ messagesByConversation: {} });
});
afterEach(cleanup);

const renderBar = () =>
  render(
    <NewTaskBar
      conversation={conversation}
      project={projects[0]}
      onBusyChange={() => {}}
    />,
  );

it("shows the project and agent pickers before the conversation starts", () => {
  renderBar();
  expect(screen.getByRole("button", { name: "项目" }).textContent).toContain("p1");
  expect(screen.getByRole("button", { name: "智能体" })).toBeTruthy();
});

it("moves the draft when another project is chosen", async () => {
  renderBar();
  fireEvent.pointerDown(screen.getByRole("button", { name: "项目" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: /p2/ }));
  expect(moveDraftToProject).toHaveBeenCalledWith(
    conversation,
    expect.objectContaining({ id: "p2" }),
  );
});

it("offers opening a new folder from the project menu", async () => {
  renderBar();
  fireEvent.pointerDown(screen.getByRole("button", { name: "项目" }));
  expect(await screen.findByRole("menuitem", { name: /打开文件夹/ })).toBeTruthy();
});

it("disappears once the conversation has content", () => {
  useAgentStore.setState({
    entriesByConversation: {
      c: [{ id: "m", kind: "user_message", text: "hi", timestamp: 1 }],
    },
  });
  renderBar();
  expect(screen.queryByTestId("new-task-bar")).toBeNull();
});
