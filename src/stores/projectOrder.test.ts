import { beforeEach, expect, it, vi } from "vitest";
import { useProjectStore } from "./project.store";
import { projectList, projectOpen, projectTouch } from "@/bridge/tauri";
vi.mock("@/bridge/tauri", () => ({
  projectList: vi.fn(),
  projectOpen: vi.fn(),
  projectTouch: vi.fn(),
  projectRemove: vi.fn(),
}));
const projects = ["first", "second"].map((id, i) => ({
  id,
  name: id,
  path: "/" + id,
  created_at: i,
  last_opened: i,
}));
beforeEach(() => {
  useProjectStore.setState({
    projects,
    projectOrder: ["first", "second"],
    activeProjectId: "first",
  });
  vi.mocked(projectTouch).mockResolvedValue(999);
});
it("does not reorder on switch or backend reload", async () => {
  useProjectStore.getState().switchProject("second");
  await Promise.resolve();
  expect(useProjectStore.getState().projects.map((p) => p.id)).toEqual([
    "first",
    "second",
  ]);
  vi.mocked(projectList).mockResolvedValue([...projects].reverse());
  await useProjectStore.getState().loadProjects();
  expect(useProjectStore.getState().projects.map((p) => p.id)).toEqual([
    "first",
    "second",
  ]);
});
it("appends a new project without moving existing projects", async () => {
  vi.mocked(projectOpen).mockResolvedValue({
    id: "new",
    name: "new",
    path: "/new",
    created_at: 3,
    last_opened: 4,
  });
  await useProjectStore.getState().openProject("/new");
  expect(useProjectStore.getState().projectOrder).toEqual([
    "first",
    "second",
    "new",
  ]);
});
