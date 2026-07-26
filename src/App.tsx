import { useEffect } from "react";
import { MainLayout } from "./features/layout/MainLayout";
import { SidePanel } from "./features/layout/SidePanel";
import { ChatArea } from "./features/agent/ChatArea";
import { EditorPanel } from "./features/editor/EditorPanel";
import { onFsChanged, onGitStatusChanged, fsWatchStart } from "./bridge/tauri";
import { useAgentStore } from "./stores/agent.store";
import { useProjectStore } from "./stores/project.store";
import { useFsStore } from "./stores/fs.store";
import { useGitStore } from "./stores/git.store";
import { restoreProjectConversationTabs } from "./features/projects/restoreProjectConversationTabs";
import { useTerminalStore } from "./stores/terminal.store";

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
    const cleanupTerminal = useTerminalStore.getState().initListeners();
    // Restore the last session: re-open the previously active project, its
    // file watcher, the conversation tabs that were open, and each tab's
    // message history. Persisted ids come back synchronously from the
    // zustand persist middleware (localStorage); we validate them against
    // the freshly-loaded backend data before using them.
    void (async () => {
      await loadProjects();
      const { activeProjectId, projects } = useProjectStore.getState();
      if (!activeProjectId) return;

      const activeProject = projects.find((p) => p.id === activeProjectId);
      // The persisted project was deleted from the DB meanwhile — clear it
      // so we don't keep restoring a dead id on every launch.
      if (!activeProject) {
        useProjectStore.setState({ activeProjectId: null });
        return;
      }

      // Watcher failures are non-fatal (e.g. path no longer exists).
      fsWatchStart(activeProject.path).catch(() => {});

      // Validate persisted tabs (incl. one-shot legacy migration) against
      // backend conversations, then reload each surviving tab's messages.
      await restoreProjectConversationTabs(activeProjectId);

      // Restore the editor panel for the active project (open files + active
      // tab), mirroring how conversation tabs are restored on cold start.
      await useFsStore.getState().loadEditorState(activeProjectId);
    })();

    // External-change events: the file tree and git panel only render the
    // active project (git `status` is a single global slot), so events for
    // other watched projects are ignored — refreshing with their data would
    // clobber the active project's view.
    const unlistenFs = onFsChanged((payload) => {
      if (payload.projectPath !== activeProjectPath()) return;
      useFsStore.getState().loadRoot(payload.projectPath);
      void useFsStore.getState().syncExternalChange(payload.paths);
    });
    const unlistenGit = onGitStatusChanged((payload) => {
      if (payload.projectPath !== activeProjectPath()) return;
      useGitStore.getState().refresh(payload.projectPath);
    });

    // Persist the active project's editor layout before the window closes so
    // the next launch restores exactly which files were open.
    const handleBeforeUnload = () => {
      const { activeProjectId } = useProjectStore.getState();
      if (activeProjectId) {
        useFsStore.getState().persistEditorLayout(activeProjectId);
      }
    };
    window.addEventListener("beforeunload", handleBeforeUnload);

    return () => {
      cleanup();
      cleanupTerminal();
      unlistenFs.then((fn) => fn());
      unlistenGit.then((fn) => fn());
      window.removeEventListener("beforeunload", handleBeforeUnload);
    };
  }, []);

  const hasOpenEditors = useFsStore((s) => s.openFiles.length > 0);

  return (
    <MainLayout
      mainContent={<ChatArea />}
      editorPanel={hasOpenEditors ? <EditorPanel /> : null}
      sidePanel={<SidePanel />}
    />
  );
}

export default App;
