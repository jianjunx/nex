import { useEffect } from "react";
import { MainLayout } from "./features/layout/MainLayout";
import { SidePanel } from "./features/layout/SidePanel";
import { ChatArea } from "./features/agent/ChatArea";
import { FilePreview } from "./features/files/FilePreview";
import { onFsChanged, onGitStatusChanged } from "./bridge/tauri";
import { useAgentStore } from "./stores/agent.store";
import { useProjectStore } from "./stores/project.store";
import { useFsStore } from "./stores/fs.store";
import { useGitStore } from "./stores/git.store";

/** Path of the currently active project, if any. */
function activeProjectPath(): string | undefined {
  const { projects, activeProjectId } = useProjectStore.getState();
  return projects.find((p) => p.id === activeProjectId)?.path;
}

function App() {
  const initListeners = useAgentStore((s) => s.initListeners);
  const loadProjects = useProjectStore((s) => s.loadProjects);

  useEffect(() => {
    const cleanup = initListeners();
    loadProjects();

    // External-change events: the file tree and git panel only render the
    // active project (git `status` is a single global slot), so events for
    // other watched projects are ignored — refreshing with their data would
    // clobber the active project's view.
    const unlistenFs = onFsChanged((payload) => {
      if (payload.projectPath !== activeProjectPath()) return;
      useFsStore.getState().loadRoot(payload.projectPath);
    });
    const unlistenGit = onGitStatusChanged((payload) => {
      if (payload.projectPath !== activeProjectPath()) return;
      useGitStore.getState().refresh(payload.projectPath);
    });

    return () => {
      cleanup();
      unlistenFs.then((fn) => fn());
      unlistenGit.then((fn) => fn());
    };
  }, []);

  return (
    <>
      <MainLayout
        mainContent={<ChatArea />}
        sidePanel={<SidePanel />}
      />
      <FilePreview />
    </>
  );
}

export default App;
