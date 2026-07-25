import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { persist } from "zustand/middleware";
import { projectOpen, projectList, type Project } from "../bridge/tauri";

interface ProjectStore {
  projects: Project[];
  activeProjectId: string | null;
  loading: boolean;
  error: string | null;

  loadProjects: () => Promise<void>;
  openProject: (path: string) => Promise<void>;
  switchProject: (id: string) => void;
}

// Backend errors arrive as { type, message }; fall back to String(err).
function errorMessage(err: unknown): string {
  if (err && typeof err === "object" && "message" in err && typeof (err as { message: unknown }).message === "string") {
    return (err as { message: string }).message;
  }
  return String(err);
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
          const projects = await projectList();
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
            s.projects = s.projects.filter((p) => p.id !== project.id);
            s.projects.unshift(project);
            s.activeProjectId = project.id;
          });
        } catch (err) {
          set((s) => { s.error = errorMessage(err); });
        } finally {
          set((s) => { s.loading = false; });
        }
      },

      switchProject: (id: string) => {
        set((s) => { s.activeProjectId = id; });
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
