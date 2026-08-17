import { useEffect, useRef, useState, useCallback } from "react";
import { PanelRight, X } from "lucide-react";
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
import { AgentIcon } from "../agent/AgentIcon";
import { CloseTabConfirmDialog } from "../agent/CloseTabConfirmDialog";
import { NewConversationDropdown } from "../projects/NewConversationDropdown";
import { ProjectSelector } from "../projects/ProjectSelector";
import { WindowControls } from "./WindowControls";
import { useTabReorder } from "./useTabReorder";

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

// 空白区双击最大化/恢复的检测窗口（OS 双击判定的近似值）。
const DOUBLE_CLICK_MS = 500;
const DOUBLE_CLICK_SLOP_PX = 8;

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
  const removeConversation = useConversationStore((s) => s.removeConversation);
  const reorderTabs = useConversationStore((s) => s.reorderTabs);
  const sessions = useAgentStore((s) => s.sessions);
  const removeSession = useAgentStore((s) => s.removeSession);
  const [pendingCloseId, setPendingCloseId] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);
  const [macFullscreen, setMacFullscreen] = useState(false);
  const { draggingIndex, bindTab } = useTabReorder(reorderTabs);

  const handleTabsWheel = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    if (el.scrollWidth <= el.clientWidth) return;
    if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
    e.preventDefault();
    el.scrollLeft += e.deltaY;
  }, []);

  // Overlay mode puts our content under the native title bar, so the OS no
  // longer provides a drag strip or double-click-to-zoom. We re-add both here,
  // on every platform (Windows is frameless for the same reason). On macOS the
  // traffic lights are native controls above the webview, so their clicks never
  // reach these handlers — no special exclusion needed.
  // 双击空白区域最大化/恢复：必须靠 mousedown 计时自己检测。第一次
  // mousedown 的 startDragging() 会进入 OS 拖拽循环，吞掉后续 mouseup /
  // dblclick——等 onDoubleClick 事件永远等不到（Windows 上实测如此）。
  // 所以记录空白区 mousedown 的时间与屏幕坐标，500ms 内第二次按下且
  // 位置基本没动即视为双击：toggleMaximize 并跳过 startDragging。
  const lastBlankDown = useRef<{ t: number; x: number; y: number } | null>(null);

  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0 || isInteractiveTarget(e.target)) return;
    const last = lastBlankDown.current;
    const now = Date.now();
    const isDouble =
      last !== null &&
      now - last.t < DOUBLE_CLICK_MS &&
      Math.abs(e.screenX - last.x) <= DOUBLE_CLICK_SLOP_PX &&
      Math.abs(e.screenY - last.y) <= DOUBLE_CLICK_SLOP_PX;
    if (isDouble) {
      lastBlankDown.current = null;
      void getCurrentWindow().toggleMaximize();
      return;
    }
    lastBlankDown.current = { t: now, x: e.screenX, y: e.screenY };
    void getCurrentWindow().startDragging();
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
  const sizing = isMac ? "h-9 gap-2" : "h-10 gap-2";
  const pad =
    isMac && !macFullscreen ? MAC_TRAFFIC_LIGHT_PAD + " pr-2" : isMac ? "px-2.5" : "px-3";
  const iconSize = isMac ? "icon-sm" : "icon-sm";

  return (
    <div
      onMouseDown={handleMouseDown}
      className={`nex-material-toolbar nex-chrome-edge flex items-center border-b border-[color:var(--hairline-soft)] ${sizing} ${pad}`}
    >
      {/* Project selector */}
      <ProjectSelector />

      {/* New conversation: controlled dropdown, also opened by workbench.newConversation */}
      <NewConversationDropdown triggerSize={iconSize} />

      {/* Conversation tabs */}
      <div className="relative flex-1 min-w-0">
        <div
          data-conversation-tabs-scroller
          onWheel={handleTabsWheel}
          className="flex items-center gap-1.5 overflow-x-auto scrollbar-none"
        >
        {openTabs.length === 0 ? (
          <span className="text-xs text-[var(--text-tertiary)] px-2">暂无会话</span>
        ) : (
          <Tabs value={activeTabId ?? ""} onValueChange={switchTab} className="min-w-0">
            <TabsList variant="line" className="h-7 gap-1 px-1">
              {openTabs.map((tabId, index) => {
                const status = sessions[tabId]?.status ?? null;
                const conv = projectConversations.find((c) => c.id === tabId);
                const agentType = conv?.agent_type ?? "";
                const drag = bindTab(index);
                return (
                  <TabsTrigger
                    key={tabId}
                    value={tabId}
                    data-tab-index={drag["data-tab-index"]}
                    onPointerDown={drag.onPointerDown}
                    className={`nex-interactive-chrome nex-pressable group/tab h-[26px] text-[12px] flex-none gap-1.5 rounded-[calc(var(--radius-sm)+2px)] border border-transparent px-2.5 font-medium tracking-[-0.012em] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[color:color-mix(in_srgb,var(--material-floating)_68%,transparent)] hover:border-[color:var(--hairline-soft)] group-data-[variant=line]/tabs-list:data-[state=active]:bg-[color:color-mix(in_srgb,var(--material-elevated)_84%,transparent)] group-data-[variant=line]/tabs-list:data-[state=active]:border-[color:var(--hairline-strong)] group-data-[variant=line]/tabs-list:data-[state=active]:text-[var(--text-primary)] group-data-[variant=line]/tabs-list:data-[state=active]:shadow-[inset_0_1px_0_0_var(--edge-highlight-bright),0_8px_20px_-18px_rgba(53,61,93,0.34)] dark:group-data-[variant=line]/tabs-list:data-[state=active]:bg-[color:color-mix(in_srgb,var(--material-elevated)_88%,transparent)] dark:group-data-[variant=line]/tabs-list:data-[state=active]:border-[color:var(--hairline-strong)] dark:group-data-[variant=line]/tabs-list:data-[state=active]:shadow-[inset_0_1px_0_0_var(--edge-highlight-bright),0_10px_24px_-18px_rgba(0,0,0,0.8)] group-data-[variant=line]/tabs-list:data-[state=active]:after:opacity-0 select-none ${draggingIndex === index ? "opacity-50" : ""}`}
                  >
                    {agentType && (
                      <AgentIcon agentType={agentType} status={status} size={12} />
                    )}
                    <span className="max-w-[120px] truncate">
                      {conv?.title ?? tabId}
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
                      data-tab-close
                      title="关闭会话"
                      className="nex-interactive-chrome ml-0.5 translate-x-[4px] flex size-4 shrink-0 items-center justify-center rounded-sm opacity-0 group-hover/tab:opacity-70 hover:!opacity-100 hover:bg-[var(--overlay-hover)]"
                      onMouseDown={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                      }}
                      onClick={(e) => {
                        e.stopPropagation();
                        setPendingCloseId(tabId);
                      }}
                    >
                      <X size={13} strokeWidth={2.25} />
                    </span>
                  </TabsTrigger>
                );
              })}
            </TabsList>
          </Tabs>
        )}
        </div>
        {/* 溢出渐隐遮罩：常驻（v1 不做滚动位置感知，YAGNI）。起始色＝TopBar 底色。 */}
        <div className="pointer-events-none absolute inset-y-0 left-0 w-6 nex-scroll-edge-mask-left" />
        <div className="pointer-events-none absolute inset-y-0 right-0 w-6 nex-scroll-edge-mask-right" />
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
              await removeConversation(id);
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
