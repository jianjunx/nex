import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { persist } from "zustand/middleware";
import { projectOpen, projectList, projectRemove, projectTouch, type Project } from "../bridge/tauri";

interface ProjectStore {
  projects: Project[];
  activeProjectId: string | null;
  loading: boolean;
  error: string | null;

  loadProjects: () => Promise<void>;
  openProject: (path: string) => Promise<void>;
  switchProject: (id: string) => void;
  removeProject: (id: string) => Promise<void>;
}

// Backend errors arrive as { type, message }; fall back to String(err).
function errorMessage(err: unknown): string {
  if (err && typeof err === "object" && "message" in err && typeof (err as { message: unknown }).message === "string") {
    return (err as { message: string }).message;
  }
  return String(err);
}

function sortByLastOpened(projects: Project[]): Project[] {
  return [...projects].sort((a, b) => b.last_opened - a.last_opened);
}

function bumpLastOpened(projects: Project[], id: string, lastOpened: number): Project[] {
  return sortByLastOpened(
    projects.map((p) => (p.id === id ? { ...p, last_opened: lastOpened } : p)),
  );
}

export const useProjectStore = create<ProjectStore>()(
  persist(
    immer((set) => ({
      projects: [],
      activeProjectId: null,
      loading: false,
      error: null,

      loadProjects: async () => {
        set((s) => { s.loading = true; s.error = null; });
        try {
          // Backend already ORDER BY last_opened DESC; keep client sort defensive.
          const projects = sortByLastOpened(await projectList());
          set((s) => { s.projects = projects; });
        } catch (err) {
          set((s) => { s.error = errorMessage(err); });
        } finally {
          set((s) => { s.loading = false; });
        }
      },

      openProject: async (path: string) => {
        set((s) => { s.loading = true; s.error = null; });
        try {
          const project = await projectOpen(path);
          set((s) => {
            // project_open upserts by path, so the project may already be listed
            s.projects = sortByLastOpened([
              project,
              ...s.projects.filter((p) => p.id !== project.id),
            ]);
            s.activeProjectId = project.id;
          });
        } catch (err) {
          set((s) => { s.error = errorMessage(err); });
        } finally {
          set((s) => { s.loading = false; });
        }
      },

      switchProject: (id: string) => {
        const now = Date.now();
        set((s) => {
          s.activeProjectId = id;
          // Optimistic reorder so the dropdown reflects activity immediately.
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
        await projectRemove(id);
        set((s) => {
          s.projects = s.projects.filter((p) => p.id !== id);
          if (s.activeProjectId === id) s.activeProjectId = null;
        });
      },
    })),
    {
      name: "nex-project",
      // Only the last active project id is worth saving; the project list is
      // always re-fetched from the backend on startup.
      partialize: (s) => ({ activeProjectId: s.activeProjectId }),
    }
  )
);
