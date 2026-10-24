import { projectHasActiveConversation } from "../features/projects/projectHasActiveConversation";
import { useConversationStore } from "./conversation.store";
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
  pinnedProjectIds: string[];
  toggleProjectPin: (id: string) => void;
  activeProjectId: string | null;
  loading: boolean;
  error: string | null;

  loadProjects: () => Promise<void>;
  openProject: (path: string, opts?: { stillCurrent?: () => boolean }) => Promise<void>;
  switchProject: (id: string) => void;
  removeProject: (id: string) => Promise<void>;
}

// Backend errors arrive as { type, message }; fall back to String(err).
function sortByProjectOrder(projects: Project[]): Project[] {
  const { projectOrder: order, pinnedProjectIds } = useProjectStore.getState();
  return [...projects].sort((a, b) => {
    const ai = order.indexOf(a.id),
      bi = order.indexOf(b.id);
    return (
      Number(pinnedProjectIds.includes(b.id)) - Number(pinnedProjectIds.includes(a.id)) ||
      (ai < 0 ? Number.MAX_SAFE_INTEGER : ai) -
        (bi < 0 ? Number.MAX_SAFE_INTEGER : bi) ||
      a.created_at - b.created_at ||
      a.id.localeCompare(b.id)
    );
  });
}

/**
 * 最近活跃的排前面（`last_opened` 降序）。时间相同按创建时间、再按 id，
 * 保证同一次启动里顺序稳定，不会因为 sort 不稳定而抖动。
 */
function sortByRecency(projects: Project[]): Project[] {
  return [...projects].sort(
    (a, b) =>
      b.last_opened - a.last_opened || a.created_at - b.created_at || a.id.localeCompare(b.id),
  );
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
      pinnedProjectIds: [],
      toggleProjectPin: (id) => {
        set((s) => {
          if (!s.projects.some((p) => p.id === id)) return;
          s.pinnedProjectIds = s.pinnedProjectIds.includes(id)
            ? s.pinnedProjectIds.filter((p) => p !== id)
            : [id, ...s.pinnedProjectIds];
        });
        set((s) => { s.projects = sortByProjectOrder(s.projects); });
      },
      activeProjectId: null,
      loading: false,
      error: null,

      loadProjects: async () => {
        set((s) => {
          s.loading = true;
          s.error = null;
        });
        try {
          // 每次启动都按活跃时间重排：最近用过的项目排前面。持久化的
          // projectOrder 只是会话内的侧栏顺序，启动时以后台活跃度为准重新
          // 播种——否则上次退出前的顺序会一直压过后端的 last_opened DESC，
          // 很久没碰的项目反而赖在最前面。
          const projects = sortByRecency(await projectList());
          const pinned = useProjectStore.getState().pinnedProjectIds;
          projects.sort((a, b) => Number(pinned.includes(b.id)) - Number(pinned.includes(a.id)));
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

      openProject: async (path: string, opts: { stillCurrent?: () => boolean } = {}) => {
        set((s) => {
          s.loading = true;
          s.error = null;
        });
        try {
          const project = await projectOpen(path);
          // project_open 是一次 IPC，这期间用户可能已经点了别的项目。那时只把
          // 新文件夹加进列表，不要抢 activeProjectId——否则侧栏高亮、文件树、
          // 编辑器、watcher 会全指向不同项目，而且不会自愈。
          const superseded = opts.stillCurrent ? !opts.stillCurrent() : false;
          set((s) => {
            // project_open upserts by path, so the project may already be listed
            const rest = s.projects.filter((p) => p.id !== project.id);
            s.projects = [project, ...rest];
            s.projects.sort((a, b) => Number(s.pinnedProjectIds.includes(b.id)) - Number(s.pinnedProjectIds.includes(a.id)));
            // 新打开的项目排到最前。必须同时改 projectOrder：它是侧栏顺序的
            // 唯一来源，只重排数组的话 sortByProjectOrder 会按旧 order 把新
            // 项目（旧 order 里没有 → MAX_SAFE_INTEGER）甩到末尾。
            s.projectOrder = [project.id, ...rest.map((p) => p.id)];
            if (!superseded) s.activeProjectId = project.id;
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
        if (projectHasActiveConversation(id)) {
          throw new Error("项目下有进行中的会话，暂时不能移除");
        }
        await projectRemove(id);
        useConversationStore.getState().removeProjectData(id);
        set((s) => {
          s.projects = s.projects.filter((p) => p.id !== id);
          s.projectOrder = s.projectOrder.filter((p) => p !== id);
          s.pinnedProjectIds = s.pinnedProjectIds.filter((p) => p !== id);
          if (s.activeProjectId === id) s.activeProjectId = null;
        });
      },
    })),
    {
      name: "nex-project",
      // Keep sidebar order across restarts; project metadata still comes from the backend.
      partialize: (s) => ({
        activeProjectId: s.activeProjectId,
        projectOrder: s.projectOrder,
        pinnedProjectIds: s.pinnedProjectIds,
      }),
    },
  ),
);
