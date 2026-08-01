import { useEffect, useState } from "react";
import { Plus, PanelRight } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useUiStore } from "../../stores/ui.store";
import { useProjectStore } from "../../stores/project.store";
import {
  selectProjectActiveTabId,
  selectProjectOpenTabs,
  useConversationStore,
} from "../../stores/conversation.store";
import { useAgentStore } from "../../stores/agent.store";
import { CloseTabConfirmDialog } from "../agent/CloseTabConfirmDialog";
import { ProjectSelector } from "../projects/ProjectSelector";
import { NewConversationModal } from "../projects/NewConversationModal";
import { WindowControls } from "./WindowControls";

const platform = typeof navigator !== "undefined" ? navigator.platform : "";
const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
const isWindows = platform.startsWith("Win") || ua.includes("Windows");
const isMac = platform.startsWith("Mac") || /Macintosh/.test(ua);

// Left padding (px) that clears the macOS traffic-light cluster when the native
// title bar is overlaid onto this bar (titleBarStyle: "Overlay"). The lights sit
// at ~x20..72, so content starts at 78. In fullscreen the lights float on hover
// over the top-left instead of occupying the bar, so the padding is dropped and
// the bar reclaims the full width — matching native apps.
const MAC_TRAFFIC_LIGHT_PAD = "pl-[78px]";

// Interactive targets must keep their own clicks; the bar's drag/zoom handlers
// ignore them. Portaled Radix overlays live outside this subtree, so they're
// naturally unaffected — which is why we drive dragging from JS mousedown rather
// than a full-bar [data-tauri-drag-region] (the native attribute swallows clicks
// for overlays that sit near the title bar).
const INTERACTIVE =
  "button, input, select, textarea, a, [role='button'], [role='menuitem'], [data-radix-popper-content-wrapper]";

function isInteractiveTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement ? !!target.closest(INTERACTIVE) : false;
}

export function TopBar() {
  const { toggleSidePanel, sidePanelVisible } = useUiStore();
  const activeProjectId = useProjectStore((s) => s.activeProjectId);
  const openTabs = useConversationStore((s) => selectProjectOpenTabs(s, activeProjectId));
  const activeTabId = useConversationStore((s) => selectProjectActiveTabId(s, activeProjectId));
  const conversationsByProject = useConversationStore((s) => s.conversationsByProject);
  const switchTab = useConversationStore((s) => s.switchTab);
  const closeTab = useConversationStore((s) => s.closeTab);
  const sessions = useAgentStore((s) => s.sessions);
  const removeSession = useAgentStore((s) => s.removeSession);
  const [showNewConversation, setShowNewConversation] = useState(false);
  const [pendingCloseId, setPendingCloseId] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);
  const [macFullscreen, setMacFullscreen] = useState(false);

  // Overlay mode puts our content under the native title bar, so the OS no
  // longer provides a drag strip or double-click-to-zoom. We re-add both here,
  // on every platform (Windows is frameless for the same reason). On macOS the
  // traffic lights are native controls above the webview, so their clicks never
  // reach these handlers — no special exclusion needed.
  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0 || isInteractiveTarget(e.target)) return;
    void getCurrentWindow().startDragging();
  };
  const handleDoubleClick = (e: React.MouseEvent) => {
    if (isInteractiveTarget(e.target)) return;
    void getCurrentWindow().toggleMaximize();
  };

  // Track macOS fullscreen to toggle the traffic-light padding (see above).
  // No dedicated fullscreen event exists; a resize fires across the transition,
  // so we re-query isFullscreen then.
  useEffect(() => {
    if (!isMac) return;
    let active = true;
    const win = getCurrentWindow();
    const refresh = () => {
      win.isFullscreen().then((v) => active && setMacFullscreen(v)).catch(() => {});
    };
    refresh();
    const unlisten = win.onResized(refresh);
    return () => {
      active = false;
      unlisten.then((fn) => fn()).catch(() => {});
    };
  }, []);

  const projectConversations = activeProjectId
    ? (conversationsByProject[activeProjectId] ?? [])
    : [];

  // macOS: compact fused bar (40px) so the overlay traffic lights line up with
  // the tabs. Windows keeps its taller frameless bar with custom window controls.
  const sizing = isMac ? "h-10 gap-2" : "h-12 gap-3";
  const pad =
    isMac && !macFullscreen ? MAC_TRAFFIC_LIGHT_PAD + " pr-3" : isMac ? "px-3" : "px-4";
  const iconSize = isMac ? "icon-sm" : "icon";

  return (
    <div
      onMouseDown={handleMouseDown}
      onDoubleClick={handleDoubleClick}
      className={`flex items-center border-b border-[color:var(--border-subtle)] bg-[var(--glass-1-surface)] backdrop-blur-xl ${sizing} ${pad}`}
    >
      {/* Project selector */}
      <ProjectSelector />

      {/* New conversation */}
      <Button size={iconSize} variant="ghost" onClick={() => setShowNewConversation(true)}>
        <Plus size={14} />
      </Button>

      {/* Conversation tabs */}
      <div className="relative flex-1 min-w-0">
        <div className="flex items-center gap-1.5 overflow-x-auto scrollbar-none">
        {openTabs.length === 0 ? (
          <span className="text-xs text-[var(--text-tertiary)] px-2">暂无会话</span>
        ) : (
          <Tabs value={activeTabId ?? ""} onValueChange={switchTab} className="min-w-0">
            <TabsList variant="line" className={`h-8 gap-1 ${isMac ? "h-8" : "h-8"}`}>
              {openTabs.map((tabId) => {
                const status = sessions[tabId]?.status ?? null;
                return (
                  <TabsTrigger
                    key={tabId}
                    value={tabId}
                    className={`${isMac ? "h-7 text-xs " : ""}flex-none gap-2 rounded-[var(--radius-md)] border border-transparent px-2.5 font-normal text-[var(--text-secondary)] transition-all duration-150 hover:-translate-y-px hover:border-[color:var(--border-subtle)] group-data-[variant=line]/tabs-list:hover:bg-[var(--overlay-hover)] hover:text-[var(--text-primary)] data-[state=active]:hover:translate-y-0 group-data-[variant=line]/tabs-list:data-[state=active]:bg-[var(--glass-2-surface)] group-data-[variant=line]/tabs-list:data-[state=active]:border-[color:var(--border-default)] dark:group-data-[variant=line]/tabs-list:data-[state=active]:bg-[var(--glass-2-surface)] dark:group-data-[variant=line]/tabs-list:data-[state=active]:border-[color:var(--border-default)] group-data-[variant=line]/tabs-list:data-[state=active]:text-[var(--text-primary)] group-data-[variant=line]/tabs-list:data-[state=active]:shadow-[inset_0_1px_0_0_rgba(255,255,255,0.06)] before:absolute before:left-0 before:top-1/4 before:bottom-1/4 before:w-0 before:rounded before:bg-[var(--accent)] before:opacity-0 before:transition-all before:duration-150 group-data-[variant=line]/tabs-list:data-[state=active]:before:w-0.5 group-data-[variant=line]/tabs-list:data-[state=active]:before:opacity-100 group-data-[variant=line]/tabs-list:data-[state=active]:after:opacity-0`}
                  >
                    {status && status !== "idle" && (
                      <span
                        className={`w-2 h-2 rounded-full ${status === "running" ? "animate-pulse" : ""}`}
                        style={{ backgroundColor: status === "running" ? "var(--accent)" : "var(--warning)" }}
                      />
                    )}
                    <span className="max-w-[120px] truncate">
                      {projectConversations.find((c) => c.id === tabId)?.title ?? tabId}
                    </span>
                    {/*
                      TabsTrigger renders a <button>, so the close × cannot be
                      a nested <button> (invalid HTML). It's a span[role="button"]
                      whose mousedown calls preventDefault (blocks the focus
                      move that would auto-activate the tab under Radix's
                      automatic activation) plus stopPropagation, so clicking ×
                      on an inactive tab closes it without switching to it.
                    */}
                    <span
                      role="button"
                      className="ml-1 cursor-pointer text-xs opacity-50 hover:opacity-100"
                      onMouseDown={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                      }}
                      onClick={(e) => {
                        e.stopPropagation();
                        setPendingCloseId(tabId);
                      }}
                    >
                      ×
                    </span>
                  </TabsTrigger>
                );
              })}
            </TabsList>
          </Tabs>
        )}
        </div>
        {/* 溢出渐隐遮罩：常驻（v1 不做滚动位置感知，YAGNI）。起始色＝TopBar 玻璃底。 */}
        <div className="pointer-events-none absolute inset-y-0 left-0 w-6 bg-gradient-to-r from-[var(--glass-1-surface)] to-transparent" />
        <div className="pointer-events-none absolute inset-y-0 right-0 w-6 bg-gradient-to-l from-[var(--glass-1-surface)] to-transparent" />
      </div>

      {/* Panel toggle */}
      <Button size={iconSize} variant="ghost" onClick={toggleSidePanel}>
        <PanelRight size={14} className={sidePanelVisible ? "text-[var(--accent)]" : ""} />
      </Button>

      {/* Custom window controls (Windows only — macOS uses the native, overlaid
          traffic lights at the left of this same bar). */}
      {isWindows && (
        <div className="flex items-center">
          <WindowControls />
        </div>
      )}

      <NewConversationModal open={showNewConversation} onClose={() => setShowNewConversation(false)} />
      <CloseTabConfirmDialog
        open={pendingCloseId !== null}
        busy={closing}
        status={pendingCloseId ? (sessions[pendingCloseId]?.status ?? null) : null}
        onCancel={() => { if (!closing) setPendingCloseId(null); }}
        onConfirm={() => {
          if (!pendingCloseId || closing) return;
          const id = pendingCloseId;
          setClosing(true);
          void (async () => {
            try {
              await removeSession(id);
              closeTab(id);
            } finally {
              setClosing(false);
              setPendingCloseId(null);
            }
          })();
        }}
      />
    </div>
  );
}
