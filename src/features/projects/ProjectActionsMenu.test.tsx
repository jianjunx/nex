// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ProjectActionsMenu } from "./ProjectActionsMenu";
import { useProjectStore } from "@/stores/project.store";
import { useConversationStore } from "@/stores/conversation.store";
import { useAgentStore } from "@/stores/agent.store";
import { useFsStore } from "@/stores/fs.store";
import { fsRevealEntry, projectRemove } from "@/bridge/tauri";

vi.mock("@/bridge/tauri", () => ({
  fsRevealEntry: vi.fn().mockResolvedValue(undefined),
  fsWatchStop: vi.fn().mockResolvedValue(undefined),
  agentCloseSession: vi.fn().mockResolvedValue(undefined),
  projectRemove: vi.fn().mockResolvedValue(undefined),
}));
const project = { id: "p2", name: "demo", path: "/demo", created_at: 0, last_opened: 0 };
const onError = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  useAgentStore.setState({ sessions: {}, pendingMessagesByConversation: {} });
  useFsStore.setState({ openFiles: [], activePath: null });
  useConversationStore.setState({ conversationsByProject: { p2: [
    { id: "c2", project_id: "p2", title: "chat", agent_type: "nex", status: "active", created_at: 0, updated_at: 0 },
  ] }, tabsByProject: { p2: ["c2"] }, activeTabByProject: { p2: "c2" }, messagesByConversation: { c2: [] } });
  useProjectStore.setState({ projects: [project], activeProjectId: "p1", projectOrder: ["p2"], pinnedProjectIds: [] });
});
afterEach(cleanup);
function openMenu() {
  render(<ProjectActionsMenu project={project} onError={onError} />);
  fireEvent.keyDown(screen.getByRole("button", { name: "更多项目操作：demo" }), { key: "ArrowDown" });
}
it("pins the project without switching it", async () => {
  openMenu();
  fireEvent.click(await screen.findByRole("menuitem", { name: "置顶" }));
  expect(useProjectStore.getState().pinnedProjectIds).toEqual(["p2"]);
  expect(useProjectStore.getState().activeProjectId).toBe("p1");
});
it("reveals the selected project folder", async () => {
  openMenu();
  fireEvent.click(await screen.findByRole("menuitem", { name: "在 Finder 中显示" }));
  await waitFor(() => expect(fsRevealEntry).toHaveBeenCalledWith("/demo"));
});
it("requires confirmation before removing a project", async () => {
  openMenu();
  fireEvent.click(await screen.findByRole("menuitem", { name: "移除项目" }));
  await screen.findByRole("dialog");
  expect(projectRemove).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "移除项目" }));
  await waitFor(() => expect(projectRemove).toHaveBeenCalledWith("p2"));
  await waitFor(() => expect(useProjectStore.getState().projects).toEqual([]));
});
it("removes the current project and clears all its conversation state", async () => {
  useProjectStore.setState({ activeProjectId: "p2" });
  useAgentStore.setState({ sessions: { c2: { sessionId: "s2", conversationId: "c2", status: "idle" } } });
  openMenu();
  fireEvent.click(await screen.findByRole("menuitem", { name: "移除项目" }));
  await screen.findByRole("dialog");
  fireEvent.click(screen.getByRole("button", { name: "移除项目" }));
  await waitFor(() => expect(useProjectStore.getState().activeProjectId).toBeNull());
  expect(useConversationStore.getState().conversationsByProject.p2).toBeUndefined();
  expect(useConversationStore.getState().tabsByProject.p2).toBeUndefined();
  expect(useConversationStore.getState().messagesByConversation.c2).toBeUndefined();
  await waitFor(() => expect(useAgentStore.getState().sessions.c2).toBeUndefined());
  expect(useFsStore.getState().openFiles).toEqual([]);
});
it.each(["starting", "running", "waiting"] as const)("disables removal with a %s conversation in a background project", async (status) => {
  useAgentStore.setState({ sessions: { c2: { sessionId: "s2", conversationId: "c2", status } } });
  openMenu();
  expect((await screen.findByRole("menuitem", { name: "移除项目" })).getAttribute("aria-disabled")).toBe("true");
  await expect(useProjectStore.getState().removeProject("p2")).rejects.toThrow("进行中的会话");
  expect(projectRemove).not.toHaveBeenCalled();
});
it("blocks confirmation when a conversation starts while the dialog is open", async () => {
  openMenu();
  fireEvent.click(await screen.findByRole("menuitem", { name: "移除项目" }));
  await screen.findByRole("dialog");
  act(() => useAgentStore.setState({ sessions: { c2: { sessionId: "s2", conversationId: "c2", status: "running" } } }));
  const confirm = screen.getByRole("button", { name: "移除项目" });
  expect(confirm.hasAttribute("disabled")).toBe(true);
  fireEvent.click(confirm);
  expect(projectRemove).not.toHaveBeenCalled();
});
