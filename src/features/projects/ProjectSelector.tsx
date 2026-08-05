import { useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useProjectStore } from "../../stores/project.store";
import { useConversationStore } from "../../stores/conversation.store";
import { useAgentStore } from "../../stores/agent.store";
import { useFsStore } from "../../stores/fs.store";
import { fsWatchStart } from "../../bridge/tauri";
import { projectSessionIndicators } from "../agent/projectSessionIndicators";
import { restoreProjectConversationTabs } from "./restoreProjectConversationTabs";
import { useClipboardStore } from "../../stores/clipboard.store";
import { AgentIcon } from "../agent/AgentIcon";

const platform = typeof navigator !== "undefined" ? navigator.platform : "";
const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
// Match TopBar's compact fused bar on macOS (see TopBar for the rationale).
const isMac = platform.startsWith("Mac") || /Macintosh/.test(ua);

/** Drop tree selection + file clipboard so Cmd+V after a switch cannot
 *  paste into a stale path (e.g. previous project's `src` into itself). */
function resetFsSelectionForProjectSwitch(projectPath: string) {
  useFsStore.getState().clearTreeExcept(projectPath);
  useClipboardStore.getState().clear();
}

function onProjectActivated(projectId: string) {
  useFsStore.getState().switchSearchProject(projectId);
}

// Radix highlights items on hover/keyboard via focus + data-[highlighted];
// override shadcn's solid accent focus with the app's subtle overlay token.
const ITEM_HIGHLIGHT =
  "focus:bg-[var(--overlay-hover)] focus:text-[var(--text-primary)] data-[highlighted]:bg-[var(--overlay-hover)]";

function errorMessage(err: unknown): string {
  if (err && typeof err === "object" && "message" in err) {
    return String((err as { message: unknown }).message);
  }
  return String(err);
}

function StatusDots({ projectId }: { projectId: string }) {
  const sessions = useAgentStore((s) => s.sessions);
  const conversationsByProject = useConversationStore((s) => s.conversationsByProject);
  const ids = (conversationsByProject[projectId] ?? []).map((c) => c.id);
  const { hasRunning, hasWaiting } = projectSessionIndicators(ids, sessions);
  if (!hasRunning && !hasWaiting) return null;
  return (
    <span className="inline-flex items-center gap-1 ml-2">
      {hasRunning && (
        <span
          className="w-2 h-2 rounded-full animate-pulse"
          style={{ backgroundColor: "var(--accent)", boxShadow: "0 0 6px 1px color-mix(in srgb, var(--accent) 70%, transparent)" }}
          title="Agent running"
        />
      )}
      {hasWaiting && (
        <span
          className="w-2 h-2 rounded-full"
          style={{ backgroundColor: "var(--warning)", boxShadow: "0 0 6px 1px color-mix(in srgb, var(--warning) 70%, transparent)" }}
          title="Agent waiting"
        />
      )}
    </span>
  );
}

/** 运行中会话数量角标（0 时隐藏）。 */
function RunningCountBadge({ projectId }: { projectId: string }) {
  const sessions = useAgentStore((s) => s.sessions);
  const conversationsByProject = useConversationStore((s) => s.conversationsByProject);
  const ids = (conversationsByProject[projectId] ?? []).map((c) => c.id);
  const running = ids.filter((id) => sessions[id]?.status === "running").length;
  if (running === 0) return null;
  return (
    <span className="mr-1.5 inline-flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-[var(--accent)] px-1 text-[9px] font-semibold leading-none text-white">
      {running}
    </span>
  );
}

/** 项目下最近活跃的一条会话（按 updated_at 降序取首）。 */
function LatestConversationRow({ projectId }: { projectId: string }) {
  const conversations = useConversationStore((s) => s.conversationsByProject[projectId]);
  const sessions = useAgentStore((s) => s.sessions);
  if (!conversations || conversations.length === 0) return null;
  const latest = [...conversations].sort((a, b) => b.updated_at - a.updated_at)[0];
  const status = sessions[latest.id]?.status ?? null;
  return (
    <span className="mt-1 flex items-center gap-1.5 border-t border-[color:var(--border-subtle)] pt-1 pl-3 text-[11px] text-[var(--text-tertiary)]">
      {latest.agent_type && (
        <AgentIcon agentType={latest.agent_type} status={status} size={11} />
      )}
      <span className="max-w-[160px] truncate">{latest.title}</span>
      {status === "running" && (
        <span className="h-1.5 w-1.5 shrink-0 rounded-full animate-pulse" style={{ backgroundColor: "var(--accent)" }} />
      )}
      {status === "waiting" && (
        <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: "var(--warning)" }} />
      )}
    </span>
  );
}

export function ProjectSelector() {
  const { projects, activeProjectId, openProject, switchProject } = useProjectStore();
  const activeProject = projects.find((p) => p.id === activeProjectId);
  const [openError, setOpenError] = useState<string | null>(null);
  const openErrorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  // Defer the native folder dialog until after the menu has fully closed.
  // Opening it from onSelect races Radix focus-restore and, on Windows, the
  // OS dialog can land behind the app (reads as "click did nothing").
  const pendingOpenFolder = useRef(false);

  const showOpenError = (msg: string) => {
    setOpenError(msg);
    if (openErrorTimer.current) clearTimeout(openErrorTimer.current);
    openErrorTimer.current = setTimeout(() => setOpenError(null), 6000);
  };

  const handleOpen = async () => {
    try {
      // Best-effort foreground: a focus hiccup must never abort the open.
      await getCurrentWindow().setFocus().catch(() => {});
      const selected = await open({ directory: true, multiple: false, title: "Open Folder" });
      if (selected && typeof selected === "string") {
        const oldId = useProjectStore.getState().activeProjectId;
        if (oldId) {
          await useFsStore.getState().saveCurrentEditorState(oldId);
        }
        await openProject(selected);
        const { activeProjectId: id, projects: all } = useProjectStore.getState();
        const active = all.find((p) => p.id === id);
        if (active) {
          resetFsSelectionForProjectSwitch(active.path);
          onProjectActivated(active.id);
          await Promise.all([
            useFsStore.getState().loadEditorState(active.id),
            restoreProjectConversationTabs(active.id),
            fsWatchStart(active.path).catch(() => {}),
          ]);
        }
      }
    } catch (err) {
      console.error("[ProjectSelector] open folder failed:", err);
      showOpenError(errorMessage(err));
    }
  };
  const handleOpenRef = useRef(handleOpen);
  handleOpenRef.current = handleOpen;

  useEffect(() => {
    if (dropdownOpen || !pendingOpenFolder.current) return;
    pendingOpenFolder.current = false;
    // Short delay lets the menu unmount / focus settle before the OS dialog.
    const t = setTimeout(() => void handleOpenRef.current(), 50);
    return () => clearTimeout(t);
  }, [dropdownOpen]);

  useEffect(() => {
    return () => {
      if (openErrorTimer.current) clearTimeout(openErrorTimer.current);
    };
  }, []);

  return (
    <div className="relative" data-tauri-drag-region="false">
      <DropdownMenu
        open={dropdownOpen}
        onOpenChange={(open) => {
          setDropdownOpen(open);
          // 展开时预拉未加载项目的会话列表，供「最近活跃会话」子项展示。
          if (open) {
            const st = useConversationStore.getState();
            for (const p of projects) {
              if (!st.conversationsByProject[p.id]) void st.loadConversations(p.id);
            }
          }
        }}
      >
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" className={`rounded-xl text-xs ${isMac ? "h-8" : ""}`}>
            <span className="inline-flex items-center">
              {activeProjectId && <RunningCountBadge projectId={activeProjectId} />}
              <span className="font-semibold">{activeProject?.name || "Open Project"}</span>
              {activeProjectId && <StatusDots projectId={activeProjectId} />}
              <ChevronDown size={12} className="ml-1 opacity-60" />
            </span>
          </Button>
        </DropdownMenuTrigger>

        {/* DropdownMenuContent self-wraps its own Portal; base already has z-50. */}
        <DropdownMenuContent
          align="start"
          data-tauri-drag-region="false"
          className="min-w-[200px] rounded-[var(--radius-md)] p-1.5"
          onCloseAutoFocus={(e) => {
            // Keep focus from jumping back to the trigger before the folder
            // dialog opens — that restore is what loses the Windows foreground.
            if (pendingOpenFolder.current) e.preventDefault();
          }}
        >
          {projects.map((p) => (
            <DropdownMenuItem
              key={p.id}
              onSelect={() => {
                const oldId = useProjectStore.getState().activeProjectId;
                void (async () => {
                  if (oldId && oldId !== p.id) {
                    await useFsStore.getState().saveCurrentEditorState(oldId);
                  }
                  switchProject(p.id);
                  resetFsSelectionForProjectSwitch(p.path);
                  onProjectActivated(p.id);
                  // Keep only this project's tab ids hydrated; others re-fetch on visit.
                  const keep = new Set(useConversationStore.getState().tabsByProject[p.id] ?? []);
                  useAgentStore.getState().pruneEntriesExcept(keep);
                  await Promise.all([
                    useFsStore.getState().loadEditorState(p.id),
                    restoreProjectConversationTabs(p.id),
                    fsWatchStart(p.path).catch(() => {}),
                  ]);
                  // 项目切换后激活其最近活跃会话（若在已开页签内）。
                  const convs = useConversationStore.getState().conversationsByProject[p.id] ?? [];
                  const latestId = [...convs].sort((a, b) => b.updated_at - a.updated_at)[0]?.id;
                  if (
                    latestId &&
                    (useConversationStore.getState().tabsByProject[p.id] ?? []).includes(latestId)
                  ) {
                    useConversationStore.getState().switchTab(latestId);
                  }
                })();
              }}
              className={`px-3 transition-colors duration-100 ${ITEM_HIGHLIGHT} ${
                p.id === activeProjectId
                  ? "bg-[var(--overlay-active)] text-[var(--text-primary)]"
                  : "text-[var(--text-secondary)]"
              }`}
            >
              <span className="flex w-full flex-col">
                <span className="flex items-center justify-between w-full gap-2">
                  <span className="truncate">{p.name}</span>
                  <StatusDots projectId={p.id} />
                </span>
                <LatestConversationRow projectId={p.id} />
              </span>
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator className="my-1.5" />
          <DropdownMenuItem
            onSelect={() => {
              pendingOpenFolder.current = true;
            }}
            className={`px-3 text-[var(--accent)] transition-colors duration-100 ${ITEM_HIGHLIGHT} focus:text-[var(--accent)] data-[highlighted]:text-[var(--accent)]`}
          >
            + Open Folder...
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {openError && (
        <div
          role="alert"
          className="absolute left-0 top-full z-50 mt-1 w-max max-w-[280px] rounded-md border border-[color:var(--border-subtle)] bg-[var(--glass-3-surface)] px-3 py-2 text-xs text-[var(--error)] shadow-md backdrop-blur-xl"
        >
          打开文件夹失败：{openError}
        </div>
      )}
    </div>
  );
}
