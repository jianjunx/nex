import { useEffect, useRef, useState, type ReactNode } from "react";
import { TopBar } from "./TopBar";
import { IconBar } from "./IconBar";
import { useUiStore } from "../../stores/ui.store";
import {
  EDITOR_MIN,
  SIDE_PANEL_MIN,
  beginColResize,
  displayedEditorWidth,
  displayedSideWidth,
  editorWidthBudget,
  sideWidthBudget,
} from "./panelResize";

interface MainLayoutProps {
  mainContent: ReactNode;
  editorPanel: ReactNode;
  sidePanel: ReactNode;
}

function useWindowWidth(): number {
  const [w, setW] = useState(() => window.innerWidth);
  useEffect(() => {
    const onResize = () => setW(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return w;
}

export function MainLayout({ mainContent, editorPanel, sidePanel }: MainLayoutProps) {
  const sidePanelVisible = useUiStore((s) => s.sidePanelVisible);
  const sidePanelWidth = useUiStore((s) => s.sidePanelWidth);
  const setSidePanelWidth = useUiStore((s) => s.setSidePanelWidth);
  const editorWidth = useUiStore((s) => s.editorWidth);
  const setEditorWidth = useUiStore((s) => s.setEditorWidth);
  const winW = useWindowWidth();

  const hasEditor = Boolean(editorPanel);
  // Display clamp: editor first (leave at least SIDE_PANEL_MIN), then side
  // takes the leftover. Drag startWidth must use these painted values — the
  // persisted store can be larger than the budget after a window resize.
  const editorEffective = hasEditor
    ? displayedEditorWidth(
        editorWidth,
        winW,
        sidePanelVisible ? SIDE_PANEL_MIN : null,
      )
    : 0;
  const sideEffective = sidePanelVisible
    ? displayedSideWidth(sidePanelWidth, winW, hasEditor ? editorEffective : null)
    : 0;

  const editorRef = useRef<HTMLDivElement>(null);
  const sideRef = useRef<HTMLDivElement>(null);
  const liveEditorRef = useRef<number | null>(null);
  const liveSideRef = useRef<number | null>(null);

  // Drag the handle on the panel's left edge: moving left widens the panel.
  const startSideDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startWidth = liveSideRef.current ?? sideEffective;
    beginColResize({
      pointerId: e.pointerId,
      startX: e.clientX,
      startWidth,
      min: SIDE_PANEL_MIN,
      max: () =>
        sideWidthBudget(
          window.innerWidth,
          hasEditor ? (liveEditorRef.current ?? editorEffective) : null,
        ),
      pane: sideRef.current,
      liveRef: liveSideRef,
      persist: setSidePanelWidth,
    });
  };

  const startEditorDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startWidth = liveEditorRef.current ?? editorEffective;
    beginColResize({
      pointerId: e.pointerId,
      startX: e.clientX,
      startWidth,
      min: EDITOR_MIN,
      max: () =>
        editorWidthBudget(
          window.innerWidth,
          sidePanelVisible ? (liveSideRef.current ?? sideEffective) : null,
        ),
      pane: editorRef.current,
      liveRef: liveEditorRef,
      persist: setEditorWidth,
    });
  };

  return (
    <div className="flex flex-col h-full w-full bg-[var(--material-canvas)]">
      <TopBar />
      <div className="flex flex-1 overflow-hidden">
        {/* Main content area */}
        <div className="flex-1 flex flex-col overflow-hidden min-w-[280px] bg-transparent">
          {mainContent}
        </div>

        {/* Editor panel + resize handle (mounted only while a file is open) */}
        {editorPanel && (
          <>
            <div
              data-testid="editor-resize-handle"
              onPointerDown={startEditorDrag}
              className="nex-handle-col"
            />
            <div
              ref={editorRef}
              data-testid="editor-pane"
              className="nex-layout-pane flex min-h-0 shrink-0 flex-col self-stretch border-l border-[color:var(--hairline-soft)] nex-material-panel overflow-hidden animate-in fade-in"
              style={{ width: liveEditorRef.current ?? editorEffective }}
            >
              <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                {editorPanel}
              </div>
            </div>
          </>
        )}

        {/* Side panel + resize handle */}
        {sidePanelVisible && (
          <>
            <div
              data-testid="side-resize-handle"
              onPointerDown={startSideDrag}
              className="nex-handle-col"
            />
            <div
              ref={sideRef}
              data-testid="side-pane"
              className="nex-layout-pane flex shrink-0 flex-col border-l border-[color:var(--hairline-soft)] nex-material-sidebar overflow-hidden animate-in fade-in"
              style={{ width: liveSideRef.current ?? sideEffective }}
            >
              <div className="flex-1 overflow-hidden">
                {sidePanel}
              </div>
            </div>
          </>
        )}

        {/* Icon bar */}
        <IconBar />
      </div>
    </div>
  );
}
