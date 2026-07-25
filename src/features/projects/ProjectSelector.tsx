import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { GlassButton } from "../../ui";
import { useProjectStore } from "../../stores/project.store";
import { useConversationStore } from "../../stores/conversation.store";
import { fsWatchStart } from "../../bridge/tauri";

export function ProjectSelector() {
  const { projects, activeProjectId, openProject, switchProject } = useProjectStore();
  const loadConversations = useConversationStore((s) => s.loadConversations);
  const [showList, setShowList] = useState(false);
  const activeProject = projects.find((p) => p.id === activeProjectId);

  const handleOpen = async () => {
    const selected = await open({ directory: true, multiple: false });
    if (selected && typeof selected === "string") {
      await openProject(selected);
      // openProject returns void and sets activeProjectId on success; read
      // the resulting project back from the store.
      const { activeProjectId: id, projects: all } = useProjectStore.getState();
      const active = all.find((p) => p.id === id);
      if (active) {
        loadConversations(active.id);
        // Fire-and-forget: watcher failures shouldn't block opening a project.
        fsWatchStart(active.path).catch(() => {});
      }
    }
  };

  return (
    <div className="relative">
      <GlassButton size="sm" variant="ghost" onClick={() => setShowList(!showList)}>
        {activeProject?.name || "Open Project"} ▾
      </GlassButton>

      {showList && (
        <div className="absolute top-full left-0 mt-1 z-40 min-w-[200px] rounded-[var(--radius-md)] backdrop-blur-[12px] bg-[var(--glass-overlay-bg)] border border-[color:var(--border-emphasis)] p-1">
          {projects.map((p) => (
            <button
              key={p.id}
              onClick={() => { switchProject(p.id); loadConversations(p.id); fsWatchStart(p.path).catch(() => {}); setShowList(false); }}
              className={`w-full text-left px-3 py-1.5 text-sm rounded-[var(--radius-sm)] ${p.id === activeProjectId ? "bg-[var(--overlay-active)] text-[var(--text-primary)]" : "text-[var(--text-secondary)] hover:bg-[var(--overlay-hover)]"}`}
            >
              {p.name}
            </button>
          ))}
          <div className="border-t border-[color:var(--border-default)] mt-1 pt-1">
            <button onClick={() => { handleOpen(); setShowList(false); }} className="w-full text-left px-3 py-1.5 text-sm text-[var(--accent)] rounded-[var(--radius-sm)] hover:bg-[var(--overlay-hover)]">
              + Open Folder...
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
