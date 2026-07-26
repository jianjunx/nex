import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
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
// the old --overlay-hover token. dark: is bound to [data-theme="dark"] via
// @custom-variant in globals.css (app pins light, so these are inert until
// dark theme support lands), but the dark: counterparts are still required:
// the item base carries dark:data-[highlighted]:bg-black/50 and tailwind-merge
// doesn't merge across modifier groups.
const ITEM_HIGHLIGHT =
  "data-[highlighted]:bg-[var(--overlay-hover)] dark:data-[highlighted]:bg-[var(--overlay-hover)]";

export function ProjectSelector() {
  const { projects, activeProjectId, openProject, switchProject } = useProjectStore();
  const loadConversations = useConversationStore((s) => s.loadConversations);
  const activeProject = projects.find((p) => p.id === activeProjectId);

  const handleOpen = async () => {
    try {
      // Windows foreground-lock mitigation: the folder dialog is spawned right
      // after Radix restores focus to the trigger, and an OS dialog opened by a
      // non-foreground process can appear behind the app window — reading as
      // "the click did nothing". Bring our window to the foreground first so
      // the (owned) dialog opens on top of it. Focus is best-effort: a focus
      // hiccup must never abort the open (that would re-create the exact
      // "nothing happens" symptom, now invisibly in release builds).
      await getCurrentWindow().setFocus().catch(() => {});
      const selected = await open({ directory: true, multiple: false, title: "Open Folder" });
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
    } catch (err) {
      // Don't die silently: a rejected dialog invoke (permission, IPC) must be
      // diagnosable instead of reading as "the click did nothing".
      console.error("[ProjectSelector] open folder failed:", err);
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
          className={`px-3 text-[var(--accent)] ${ITEM_HIGHLIGHT} data-[highlighted]:text-[var(--accent)] dark:data-[highlighted]:text-[var(--accent)]`}
        >
          + Open Folder...
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
