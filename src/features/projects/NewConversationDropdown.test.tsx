// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NewConversationDropdown } from "./NewConversationDropdown";
import { useProjectStore } from "@/stores/project.store";
import { useConversationStore } from "@/stores/conversation.store";
import { useUiStore } from "@/stores/ui.store";
import { activateProject } from "./activateProject";
vi.mock("./activateProject", () => ({
  activateProject: vi.fn().mockResolvedValue(undefined),
}));
const create = vi.fn();
beforeEach(() => {
  create.mockReset().mockResolvedValue({ id: "c" });
  useProjectStore.setState({
    projects: ["first", "second"].map((id) => ({
      id,
      name: id,
      path: "/" + id,
      created_at: 0,
      last_opened: 0,
    })),
    activeProjectId: "second",
  });
  useConversationStore.setState({ createConversation: create });
  useUiStore.setState({ newConversationOpen: false });
});
afterEach(cleanup);
it("creates in the first project regardless of current project", async () => {
  render(<NewConversationDropdown triggerSize="icon" />);
  fireEvent.click(screen.getByRole("button", { name: "新建任务" }));
  await waitFor(() => expect(create).toHaveBeenCalledWith("first", "nex"));
  expect(activateProject).toHaveBeenCalledWith(
    expect.objectContaining({ id: "first" }),
  );
  expect(screen.queryByRole("menu")).toBeNull();
});
it("reports missing project without creating a conversation", () => {
  useProjectStore.setState({ projects: [] });
  render(<NewConversationDropdown triggerSize="icon" />);
  fireEvent.click(screen.getByRole("button", { name: "新建任务" }));
  expect(screen.getByRole("alert").textContent).toContain("请先添加项目");
  expect(create).not.toHaveBeenCalled();
});
it("reports creation failure and allows retry", async () => {
  create.mockRejectedValueOnce(new Error("创建失败"));
  render(<NewConversationDropdown triggerSize="icon" />);
  fireEvent.click(screen.getByRole("button", { name: "新建任务" }));
  await screen.findByRole("alert");
  fireEvent.click(screen.getByRole("button", { name: "新建任务" }));
  await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
});
it("prevents duplicate creates while pending", async () => {
  create.mockReturnValue(new Promise(() => {}));
  render(<NewConversationDropdown triggerSize="icon" />);
  const button = screen.getByRole("button", { name: "新建任务" });
  fireEvent.click(button);
  fireEvent.click(button);
  await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
});
