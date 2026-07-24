import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { projectOpen, projectList, type Project } from "../bridge/tauri";

interface ProjectStore {
  projects: Project[];
  activeProjectId: string | null;
  loading: boolean;

  loadProjects: () => Promise<void>;
  openProject: (path: string) => Promise<void>;
  switchProject: (id: string) => void;
}

export const useProjectStore = create<ProjectStore>()(
  immer((set) => ({
    projects: [],
    activeProjectId: null,
    loading: false,

    loadProjects: async () => {
      set((s) => { s.loading = true; });
      const projects = await projectList();
      set((s) => { s.projects = projects; s.loading = false; });
    },

    openProject: async (path: string) => {
      const project = await projectOpen(path);
      set((s) => {
        s.projects.unshift(project);
        s.activeProjectId = project.id;
      });
    },

    switchProject: (id: string) => {
      set((s) => { s.activeProjectId = id; });
    },
  }))
);
