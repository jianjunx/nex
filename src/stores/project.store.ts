import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { persist } from "zustand/middleware";
import {
  projectOpen,
  projectList,
  projectRemove,
  projectTouch,
  type Project,
} from "../bridge/tauri";
import { errorMessage } from "../lib/errors";

interface ProjectStore {
  projects: Project[];
  projectOrder: string[];
  activeProjectId: string | null;
  loading: boolean;
  error: string | null;

  loadProjects: () => Promise<void>;
  openProject: (path: string) => Promise<void>;
  switchProject: (id: string) => void;
  removeProject: (id: string) => Promise<void>;
}

// Backend errors arrive as { type, message }; fall back to String(err).
function sortByProjectOrder(projects: Project[]): Project[] {
  const order = useProjectStore.getState().projectOrder;
  return [...projects].sort((a, b) => {
    const ai = order.indexOf(a.id),
      bi = order.indexOf(b.id);
    return (
      (ai < 0 ? Number.MAX_SAFE_INTEGER : ai) -
        (bi < 0 ? Number.MAX_SAFE_INTEGER : bi) ||
      a.created_at - b.created_at ||
      a.id.localeCompare(b.id)
    );
  });
}

function bumpLastOpened(
  projects: Project[],
  id: string,
  lastOpened: number,
): Project[] {
  return sortByProjectOrder(
    projects.map((p) => (p.id === id ? { ...p, last_opened: lastOpened } : p)),
  );
}

export const useProjectStore = create<ProjectStore>()(
  persist(
    immer((set) => ({
      projects: [],
      projectOrder: [],
      activeProjectId: null,
      loading: false,
      error: null,

      loadProjects: async () => {
        set((s) => {
          s.loading = true;
          s.error = null;
        });
        try {
          // The saved sidebar order takes precedence over backend activity order.
          const projects = sortByProjectOrder(await projectList());
          set((s) => {
            s.projects = projects;
            s.projectOrder = projects.map((p) => p.id);
          });
        } catch (err) {
          set((s) => {
            s.error = errorMessage(err);
          });
        } finally {
          set((s) => {
            s.loading = false;
          });
        }
      },

      openProject: async (path: string) => {
        set((s) => {
          s.loading = true;
          s.error = null;
        });
        try {
          const project = await projectOpen(path);
          set((s) => {
            // project_open upserts by path, so the project may already be listed
            s.projects = sortByProjectOrder([
              project,
              ...s.projects.filter((p) => p.id !== project.id),
            ]);
            s.projectOrder = s.projects.map((p) => p.id);
            s.activeProjectId = project.id;
          });
        } catch (err) {
          set((s) => {
            s.error = errorMessage(err);
          });
        } finally {
          set((s) => {
            s.loading = false;
          });
        }
      },

      switchProject: (id: string) => {
        const now = Date.now();
        set((s) => {
          s.activeProjectId = id;
          // Update recency metadata without moving the project in the sidebar.
          s.projects = bumpLastOpened(s.projects, id, now);
        });
        void projectTouch(id)
          .then((lastOpened) => {
            set((s) => {
              s.projects = bumpLastOpened(s.projects, id, lastOpened);
            });
          })
          .catch(() => {
            /* switch still succeeded; list order stays optimistic */
          });
      },

      removeProject: async (id: string) => {
        // 当前打开的项目不可删除（UI 也不显示入口；此处防御）。
        const active = useProjectStore.getState().activeProjectId;
        if (active === id) {
          throw new Error("当前打开的项目不能移除");
        }
        await projectRemove(id);
        set((s) => {
          s.projects = s.projects.filter((p) => p.id !== id);
          // 不触碰 activeProjectId：删除的只可能是非当前项目。
        });
      },
    })),
    {
      name: "nex-project",
      // Keep sidebar order across restarts; project metadata still comes from the backend.
      partialize: (s) => ({
        activeProjectId: s.activeProjectId,
        projectOrder: s.projectOrder,
      }),
    },
  ),
);
