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
    pinnedProjectIds: [],
    projectOrder: ["first", "second"],
    activeProjectId: "first",
  });
  vi.mocked(projectTouch).mockResolvedValue(999);
});
it("does not reorder on switch", async () => {
  useProjectStore.getState().switchProject("second");
  await Promise.resolve();
  expect(useProjectStore.getState().projects.map((p) => p.id)).toEqual([
    "first",
    "second",
  ]);
});
it("re-sorts by recency on every startup, ignoring the persisted order", async () => {
  // 持久化顺序把 second 放前面，但 second 的 last_opened 更早——启动时必须
  // 以活跃度为准，否则很久没碰的项目会一直赖在最前面。
  useProjectStore.setState({ projectOrder: ["second", "first"] });
  vi.mocked(projectList).mockResolvedValue([...projects].reverse());
  await useProjectStore.getState().loadProjects();
  expect(useProjectStore.getState().projects.map((p) => p.id)).toEqual([
    "second",
    "first",
  ]);
  expect(useProjectStore.getState().projectOrder).toEqual(["second", "first"]);
});
it("breaks recency ties deterministically", async () => {
  const tied = [
    { id: "b", name: "b", path: "/b", created_at: 5, last_opened: 100 },
    { id: "a", name: "a", path: "/a", created_at: 9, last_opened: 100 },
    { id: "c", name: "c", path: "/c", created_at: 1, last_opened: 100 },
  ];
  vi.mocked(projectList).mockResolvedValue(tied);
  await useProjectStore.getState().loadProjects();
  // last_opened 相同 → 按 created_at 升序（与 sortByProjectOrder 的兜底一致）
  expect(useProjectStore.getState().projects.map((p) => p.id)).toEqual(["c", "b", "a"]);
});
it("puts a newly opened project first and keeps the rest in place", async () => {
  vi.mocked(projectOpen).mockResolvedValue({
    id: "new",
    name: "new",
    path: "/new",
    created_at: 3,
    last_opened: 4,
  });
  await useProjectStore.getState().openProject("/new");
  expect(useProjectStore.getState().projects.map((p) => p.id)).toEqual([
    "new",
    "first",
    "second",
  ]);
  expect(useProjectStore.getState().projectOrder).toEqual(["new", "first", "second"]);
  expect(useProjectStore.getState().activeProjectId).toBe("new");
});
it("re-opening a listed project promotes it instead of duplicating the row", async () => {
  vi.mocked(projectOpen).mockResolvedValue({
    id: "second",
    name: "second",
    path: "/second",
    created_at: 1,
    last_opened: 9,
  });
  await useProjectStore.getState().openProject("/second");
  expect(useProjectStore.getState().projects.map((p) => p.id)).toEqual([
    "second",
    "first",
  ]);
  expect(useProjectStore.getState().projectOrder).toEqual(["second", "first"]);
});

it("keeps pinned projects above recent projects after reload and opening a folder", async () => {
  useProjectStore.getState().toggleProjectPin("first");
  vi.mocked(projectList).mockResolvedValue(projects);
  await useProjectStore.getState().loadProjects();
  expect(useProjectStore.getState().projects.map((p) => p.id)).toEqual(["first", "second"]);
  vi.mocked(projectOpen).mockResolvedValue({ ...projects[1], id: "new" });
  await useProjectStore.getState().openProject("/new");
  useProjectStore.getState().switchProject("second");
  await Promise.resolve();
  expect(useProjectStore.getState().projects.map((p) => p.id)).toEqual(["first", "new", "second"]);
  useProjectStore.getState().toggleProjectPin("first");
  expect(useProjectStore.getState().pinnedProjectIds).toEqual([]);
});
