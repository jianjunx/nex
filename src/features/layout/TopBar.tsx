import { PanelLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useUiStore } from "@/stores/ui.store";
import { useProjectStore } from "@/stores/project.store";
import { useConversationStore } from "@/stores/conversation.store";
import { IconBar } from "./IconBar";
import { SIDEBAR_WIDTH, SIDEBAR_WIDTH_VAR } from "./sidebarMetrics";
import { WindowControls } from "./WindowControls";
import {
  MAC_TRAFFIC_LIGHT_PAD_PX,
  TITLE_BAR_HEIGHT_CLASS,
  isMac,
  isWindows,
  useMacFullscreen,
  useTitleBarDrag,
} from "./windowChrome";

/** Title of the conversation currently shown in the main pane. */
function useActiveConversationTitle(): string | null {
  const projectId = useProjectStore((s) => s.activeProjectId);
  return useConversationStore((s) => {
    if (!projectId) return null;
    const id = s.activeTabByProject[projectId];
    if (!id) return null;
    return s.conversationsByProject[projectId]?.find((c) => c.id === id)?.title ?? null;
  });
}

export function TopBar() {
  const macFullscreen = useMacFullscreen();
  const handleMouseDown = useTitleBarDrag();
  const collapsed = useUiStore((s) => s.sidebarCollapsed);
  const title = useActiveConversationTitle();

  const padLeft = isMac && !macFullscreen ? MAC_TRAFFIC_LIGHT_PAD_PX : 12;

  return (
    <div
      onMouseDown={handleMouseDown}
      className={`flex shrink-0 items-center bg-[var(--material-sidebar)] pr-3 ${TITLE_BAR_HEIGHT_CLASS}`}
    >
      {/* Expanded: this zone is exactly as wide as the sidebar, so the divider
          below lands on the sidebar/workbench edge and the toggle sits at its right end.
          Collapsed: it hugs the icon. */}
      <div
        className={`flex shrink-0 items-center ${collapsed ? "" : "justify-end"}`}
        style={{
          paddingLeft: padLeft,
          paddingRight: 8,
          width: collapsed ? undefined : `var(${SIDEBAR_WIDTH_VAR}, ${SIDEBAR_WIDTH}px)`,
        }}
      >
        <Button
          variant="ghost"
          size="icon-sm"
          title={collapsed ? "展开侧栏" : "收起侧栏"}
          aria-label={collapsed ? "展开侧栏" : "收起侧栏"}
          aria-expanded={!collapsed}
          className="shrink-0 text-[var(--text-tertiary)]"
          onClick={() => useUiStore.getState().toggleSidebar()}
        >
          <PanelLeft size={16} />
        </Button>
      </div>
      <span aria-hidden className="h-4 w-px shrink-0 bg-[var(--hairline-strong)]" />
      <div className="min-w-0 flex-1 pl-3 pr-2">
        {title && (
          <h1
            title={title}
            className="truncate text-sm font-medium text-[var(--text-secondary)]"
          >
            {title}
          </h1>
        )}
      </div>
      <IconBar />

      {/* Custom window controls (Windows only — macOS uses the native, overlaid
          traffic lights at the left of this bar). */}
      {isWindows && (
        <div className="flex items-center">
          <WindowControls />
        </div>
      )}
    </div>
  );
}
