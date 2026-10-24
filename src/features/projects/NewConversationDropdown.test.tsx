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
import { useToastStore } from "@/stores/toast.store";
import { ToastStack } from "../layout/ToastStack";
const create = vi.fn();
beforeEach(() => {
  useToastStore.setState({ items: [] });
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
it("creates in the currently selected project", async () => {
  render(<><NewConversationDropdown triggerSize="icon" /><ToastStack /></>);
  fireEvent.click(screen.getByRole("button", { name: "新建任务" }));
  await waitFor(() => expect(create).toHaveBeenCalledWith("second", "nex"));
  expect(activateProject).toHaveBeenCalledWith(
    expect.objectContaining({ id: "second" }),
  );
  expect(screen.queryByRole("menu")).toBeNull();
});
it("falls back to the first project when none is selected", async () => {
  useProjectStore.setState({ activeProjectId: null });
  render(<><NewConversationDropdown triggerSize="icon" /><ToastStack /></>);
  fireEvent.click(screen.getByRole("button", { name: "新建任务" }));
  await waitFor(() => expect(create).toHaveBeenCalledWith("first", "nex"));
});
it("reports missing project without creating a conversation", () => {
  useProjectStore.setState({ projects: [] });
  render(<><NewConversationDropdown triggerSize="icon" /><ToastStack /></>);
  fireEvent.click(screen.getByRole("button", { name: "新建任务" }));
  expect(screen.getByRole("status").textContent).toContain("请先添加项目");
  expect(create).not.toHaveBeenCalled();
});
it("reports creation failure and allows retry", async () => {
  create.mockRejectedValueOnce(new Error("No such file or directory (os error 2)"));
  render(<><NewConversationDropdown triggerSize="icon" /><ToastStack /></>);
  fireEvent.click(screen.getByRole("button", { name: "新建任务" }));
  expect((await screen.findByRole("status")).textContent).toContain("No such file or directory (os error 2)");
  expect(screen.queryByRole("alert")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "新建任务" }));
  await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
});
it("prevents duplicate creates while pending", async () => {
  create.mockReturnValue(new Promise(() => {}));
  render(<><NewConversationDropdown triggerSize="icon" /><ToastStack /></>);
  const button = screen.getByRole("button", { name: "新建任务" });
  fireEvent.click(button);
  fireEvent.click(button);
  await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
});
