import { useEffect, useRef, useState, type ReactNode } from "react";
import { usePresence } from "@/components/ui/usePresence";
import { TopBar } from "./TopBar";
import { WorkspaceSidebar } from "./WorkspaceSidebar";
import { useUiStore } from "@/stores/ui.store";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { SIDE_PANEL_MIN, beginColResize } from "./panelResize";
import {
  RAIL_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_WIDTH,
  SIDEBAR_WIDTH_VAR,
} from "./sidebarMetrics";

interface MainLayoutProps {
  mainContent: ReactNode;
  editorPanel: ReactNode;
  sidePanel: ReactNode;
}

export function MainLayout({
  mainContent,
  editorPanel,
  sidePanel,
}: MainLayoutProps) {
  const visible = useUiStore((s) => s.sidePanelVisible);
  const side = usePresence(visible);
  const width = useUiStore((s) => s.sidePanelWidth);
  const collapsed = useUiStore((s) => s.sidebarCollapsed);
  const storedSidebarWidth = useUiStore((s) => s.sidebarWidth);
  const [windowWidth, setWindowWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const resize = () => setWindowWidth(window.innerWidth);
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  const sideRef = useRef<HTMLDivElement>(null);
  const liveRef = useRef<number | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const sidebarLiveRef = useRef<number | null>(null);
  // Leave room for the main column and the narrowest side panel.
  const sidebarBudget = (winW: number) =>
    Math.max(
      SIDEBAR_WIDTH,
      Math.min(SIDEBAR_MAX_WIDTH, winW - 280 - (visible ? SIDE_PANEL_MIN : 0)),
    );
  const expandedWidth = Math.min(
    Math.max(storedSidebarWidth, SIDEBAR_WIDTH),
    sidebarBudget(windowWidth),
  );
  const sidebarWidth = collapsed ? RAIL_WIDTH : expandedWidth;
  const budget = () => Math.max(SIDE_PANEL_MIN, window.innerWidth - sidebarWidth - 280);
  const paintedWidth = Math.min(
    width,
    Math.max(SIDE_PANEL_MIN, windowWidth - sidebarWidth - 280),
  );
  return (
    <div
      ref={rootRef}
      className="flex h-full w-full flex-col bg-[var(--material-sidebar)]"
      style={{ [SIDEBAR_WIDTH_VAR]: `${expandedWidth}px` } as React.CSSProperties}
    >
      <TopBar />
      <div className="flex min-h-0 flex-1">
        <div className="relative flex shrink-0">
          <WorkspaceSidebar />
          {!collapsed && (
            <div
              data-testid="sidebar-resize-handle"
              role="separator"
              aria-orientation="vertical"
              aria-label="调整侧栏宽度"
              className="nex-handle-col !absolute inset-y-0 -right-0.5"
              onPointerDown={(e) => {
                e.preventDefault();
                beginColResize({
                  pointerId: e.pointerId,
                  startX: e.clientX,
                  startWidth: sidebarLiveRef.current ?? expandedWidth,
                  min: SIDEBAR_WIDTH,
                  max: () => sidebarBudget(window.innerWidth),
                  pane: null,
                  liveRef: sidebarLiveRef,
                  invert: true,
                  onLive: (w) =>
                    rootRef.current?.style.setProperty(SIDEBAR_WIDTH_VAR, `${w}px`),
                  persist: useUiStore.getState().setSidebarWidth,
                });
              }}
            />
          )}
        </div>
        <div className="nex-workbench-body relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
          <main className="nex-workbench-main flex min-w-0 flex-1 flex-col overflow-hidden">
            {mainContent}
          </main>
          {side.mounted && (
            <>
              <div
                data-testid="side-resize-handle"
                className="nex-handle-col"
                style={side.shown ? undefined : { width: 0, overflow: "hidden" }}
                onPointerDown={(e) => {
                  e.preventDefault();
                  beginColResize({
                    pointerId: e.pointerId,
                    startX: e.clientX,
                    startWidth: liveRef.current ?? paintedWidth,
                    min: SIDE_PANEL_MIN,
                    max: budget,
                    pane: sideRef.current,
                    liveRef,
                    persist: useUiStore.getState().setSidePanelWidth,
                  });
                }}
              />
              <div
                id="workspace-side-panel"
                data-testid="side-pane"
                ref={(node) => {
                  sideRef.current = node;
                  side.ref.current = node;
                }}
                className="nex-layout-pane nex-material-sidebar flex min-h-0 shrink-0 flex-col overflow-hidden border-l border-[var(--hairline-soft)]"
                style={{ width: side.shown ? paintedWidth : 0 }}
              >
                {sidePanel}
              </div>
            </>
          )}
        </div>
      </div>
      {/* 编辑器是浮在工作台上方的常驻面板。modal={false} + data-workbench-surface
          两件事是为了快捷键：前者不锁焦点，后者让 KeybindingHost 不把这块
          portal 到 body 的 Dialog 当成模态对话框，⌘S / Esc / ⌘W 才照常生效。
          尺寸保持 92vw 居中（盖住右侧面板是可接受的——双击才打开，浏览文件树
          时它是关着的）。 */}
      <Dialog
        open={Boolean(editorPanel)}
        modal={false}
        onOpenChange={(open) => {
          if (!open) useUiStore.getState().setEditorVisible(false);
        }}
      >
        <DialogContent
          aria-describedby={undefined}
          showCloseButton={false}
          data-workbench-surface=""
          className="flex h-[85vh] w-[92vw] max-w-[1200px] flex-col gap-0 overflow-hidden p-0 sm:max-w-[1200px]"
          onInteractOutside={(e) => e.preventDefault()}
        >
          <DialogTitle className="sr-only">文件预览与编辑</DialogTitle>
          <div
            data-testid="editor-dialog"
            className="flex min-h-0 flex-1 flex-col overflow-hidden"
          >
            {editorPanel}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
