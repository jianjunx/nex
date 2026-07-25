import { open } from "@tauri-apps/plugin-dialog";
import { Check, ChevronDown } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@glinui/ui";
import { useProjectStore } from "../../stores/project.store";
import { useConversationStore } from "../../stores/conversation.store";
import { fsWatchStart } from "../../bridge/tauri";

export function ProjectSelector() {
  const { projects, activeProjectId, openProject, switchProject } = useProjectStore();
  const loadConversations = useConversationStore((s) => s.loadConversations);
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

  const switchTo = (id: string, path: string) => {
    switchProject(id);
    loadConversations(id);
    fsWatchStart(path).catch(() => {});
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger variant="glass" size="sm" className="gap-1.5">
        <span className="max-w-[160px] truncate">{activeProject?.name || "Open Project"}</span>
        <ChevronDown size={14} className="opacity-70" />
      </DropdownMenuTrigger>
      <DropdownMenuContent variant="glass" align="start" className="min-w-[220px]">
        {projects.map((p) => (
          <DropdownMenuItem key={p.id} onSelect={() => switchTo(p.id, p.path)}>
            <span className="flex-1 truncate">{p.name}</span>
            {p.id === activeProjectId && (
              <Check size={14} className="text-[var(--color-accent)]" />
            )}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem className="text-[var(--color-accent)]" onSelect={() => void handleOpen()}>
          + Open Folder...
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
