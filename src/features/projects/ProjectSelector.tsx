import { open } from "@tauri-apps/plugin-dialog";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@glinui/ui";
import { useProjectStore } from "../../stores/project.store";
import { useConversationStore } from "../../stores/conversation.store";
import { fsWatchStart } from "../../bridge/tauri";

// Radix highlights items on hover/keyboard via data-[highlighted]; map it to
// the old --overlay-hover token. dark: counterparts are required: Tailwind v4
// dark: is prefers-color-scheme-based here and the item base carries
// dark:data-[highlighted]:bg-black/50 that twMerge can't merge across.
const ITEM_HIGHLIGHT =
  "data-[highlighted]:bg-[var(--overlay-hover)] dark:data-[highlighted]:bg-[var(--overlay-hover)]";

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

  return (
    <DropdownMenu>
      {/*
        asChild merges the trigger's classes onto Button with a plain string
        join (Radix Slot, no twMerge), so pass variant/size explicitly to
        neutralize the trigger's defaultVariants, and squash rounded-md/text-sm
        via className to match Button's rounded-xl/text-xs.
      */}
      <DropdownMenuTrigger asChild variant="ghost" size="sm" className="rounded-xl text-xs">
        <Button variant="ghost" size="sm">
          {activeProject?.name || "Open Project"} ▾
        </Button>
      </DropdownMenuTrigger>

      {/* DropdownMenuContent self-wraps its own Portal; base already has z-50. */}
      <DropdownMenuContent
        align="start"
        variant="glass"
        className="min-w-[200px] rounded-[var(--radius-md)] p-1.5"
      >
        {projects.map((p) => (
          <DropdownMenuItem
            key={p.id}
            onSelect={() => {
              switchProject(p.id);
              loadConversations(p.id);
              fsWatchStart(p.path).catch(() => {});
            }}
            className={`px-3 ${ITEM_HIGHLIGHT} ${
              p.id === activeProjectId
                ? "bg-[var(--overlay-active)] text-[var(--text-primary)]"
                : "text-[var(--text-secondary)]"
            }`}
          >
            {p.name}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator className="my-1.5" />
        <DropdownMenuItem
          onSelect={() => {
            // setTimeout guards against Radix focus-restore racing the native
            // folder dialog (removable once confirmed in manual QA).
            setTimeout(() => void handleOpen(), 0);
          }}
          className={`px-3 text-[var(--accent)] ${ITEM_HIGHLIGHT}`}
        >
          + Open Folder...
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
