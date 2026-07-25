import { useEffect } from "react";
import { MainLayout } from "./features/layout/MainLayout";
import { SidePanel } from "./features/layout/SidePanel";
import { ChatArea } from "./features/agent/ChatArea";
import { FilePreview } from "./features/files/FilePreview";
import { onFsChanged, onGitStatusChanged, fsWatchStart } from "./bridge/tauri";
import { useAgentStore } from "./stores/agent.store";
import { useProjectStore } from "./stores/project.store";
import { useFsStore } from "./stores/fs.store";
import { useGitStore } from "./stores/git.store";
import { useConversationStore } from "./stores/conversation.store";

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

      const convStore = useConversationStore.getState();
      await convStore.loadConversations(activeProjectId);
      // Watcher failures are non-fatal (e.g. path no longer exists).
      fsWatchStart(activeProject.path).catch(() => {});

      // Filter out tabs whose conversations no longer exist, then reload
      // each surviving tab's messages from the DB.
      const convs = useConversationStore.getState().conversationsByProject[activeProjectId] ?? [];
      const validIds = new Set(convs.map((c) => c.id));
      const { openTabs, activeTabId } = useConversationStore.getState();
      convStore.restoreTabs(openTabs, activeTabId, validIds);

      const restoredTabs = useConversationStore.getState().openTabs;
      await Promise.all(restoredTabs.map((tabId) => convStore.loadMessages(tabId)));
    })();

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
