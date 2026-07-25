import { useEffect } from "react";
import { MainLayout } from "./features/layout/MainLayout";
import { SidePanel } from "./features/layout/SidePanel";
import { ChatArea } from "./features/agent/ChatArea";
import { FilePreview } from "./features/files/FilePreview";
import { useAgentStore } from "./stores/agent.store";
import { useProjectStore } from "./stores/project.store";

function App() {
  const initListeners = useAgentStore((s) => s.initListeners);
  const loadProjects = useProjectStore((s) => s.loadProjects);

  useEffect(() => {
    const cleanup = initListeners();
    loadProjects();
    return cleanup;
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
