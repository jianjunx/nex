import { useEffect, useRef, useState, type ReactNode } from "react";
import { TopBar } from "./TopBar";
import { WorkspaceSidebar } from "./WorkspaceSidebar";
import { useUiStore } from "@/stores/ui.store";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { SIDE_PANEL_MIN, beginColResize } from "./panelResize";

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
  const width = useUiStore((s) => s.sidePanelWidth);
  const [windowWidth, setWindowWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const resize = () => setWindowWidth(window.innerWidth);
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  const sideRef = useRef<HTMLDivElement>(null);
  const liveRef = useRef<number | null>(null);
  const budget = () => Math.max(SIDE_PANEL_MIN, window.innerWidth - 208 - 280);
  const paintedWidth = Math.min(
    width,
    Math.max(SIDE_PANEL_MIN, windowWidth - 208 - 280),
  );
  return (
    <div className="flex h-full w-full flex-col bg-[var(--material-canvas)]">
      <TopBar />
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <WorkspaceSidebar />
        <div className="nex-workbench-body relative flex min-w-0 flex-1 overflow-hidden">
          <main className="nex-workbench-main flex min-w-0 flex-1 flex-col overflow-hidden">
            {mainContent}
          </main>
          {visible && (
            <>
              <div
                data-testid="side-resize-handle"
                className="nex-handle-col"
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
                ref={sideRef}
                className="nex-layout-pane nex-material-sidebar flex min-h-0 shrink-0 flex-col overflow-hidden border-l border-[var(--hairline-soft)]"
                style={{ width: paintedWidth }}
              >
                {sidePanel}
              </div>
            </>
          )}
        </div>
      </div>
      <Dialog
        open={Boolean(editorPanel)}
        onOpenChange={(open) => {
          if (!open) useUiStore.getState().setEditorVisible(false);
        }}
      >
        <DialogContent
          aria-describedby={undefined}
          className="flex h-[85vh] w-[92vw] max-w-[1200px] flex-col gap-2 overflow-hidden p-3 sm:max-w-[1200px]"
          onInteractOutside={(e) => e.preventDefault()}
        >
          <DialogTitle className="pr-10 text-sm">文件预览与编辑</DialogTitle>
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
