import { useState, type ReactNode } from "react";
import { TopBar } from "./TopBar";
import { IconBar } from "./IconBar";
import { useUiStore } from "../../stores/ui.store";

// Side panel width clamp (px); persisted via ui.store.
const SIDE_PANEL_MIN = 240;
const SIDE_PANEL_MAX = 640;

// Editor panel width clamp (px); persisted via ui.store.
const EDITOR_MIN = 320;
const EDITOR_MAX = 960;

interface MainLayoutProps {
  mainContent: ReactNode;
  editorPanel: ReactNode;
  sidePanel: ReactNode;
}

function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n));
}

export function MainLayout({ mainContent, editorPanel, sidePanel }: MainLayoutProps) {
  const { sidePanelVisible, sidePanelWidth, setSidePanelWidth, editorWidth, setEditorWidth } = useUiStore();

  // Live widths during drag — keep pointer moves off the persisted store so
  // localStorage writes don't stutter the resize, and avoid any CSS transition
  // lag by painting the target width immediately.
  const [liveSideWidth, setLiveSideWidth] = useState<number | null>(null);
  const [liveEditorWidth, setLiveEditorWidth] = useState<number | null>(null);

  // Drag the handle on the panel's left edge: moving left widens the panel.
  const startDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startWidth = useUiStore.getState().sidePanelWidth;
    const prevUserSelect = document.body.style.userSelect;
    document.body.style.userSelect = "none";

    const onMove = (ev: PointerEvent) => {
      setLiveSideWidth(clamp(startWidth + (startX - ev.clientX), SIDE_PANEL_MIN, SIDE_PANEL_MAX));
    };
    const onUp = (ev: PointerEvent) => {
      const next = clamp(startWidth + (startX - ev.clientX), SIDE_PANEL_MIN, SIDE_PANEL_MAX);
      setSidePanelWidth(next);
      setLiveSideWidth(null);
      document.body.style.userSelect = prevUserSelect;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  // Drag the handle on the panel's left edge: moving left widens the panel.
  const startEditorDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startWidth = useUiStore.getState().editorWidth;
    const prevUserSelect = document.body.style.userSelect;
    document.body.style.userSelect = "none";

    const onMove = (ev: PointerEvent) => {
      setLiveEditorWidth(clamp(startWidth + (startX - ev.clientX), EDITOR_MIN, EDITOR_MAX));
    };
    const onUp = (ev: PointerEvent) => {
      const next = clamp(startWidth + (startX - ev.clientX), EDITOR_MIN, EDITOR_MAX);
      setEditorWidth(next);
      setLiveEditorWidth(null);
      document.body.style.userSelect = prevUserSelect;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  return (
    <div className="flex flex-col h-full w-full">
      <TopBar />
      <div className="flex flex-1 overflow-hidden">
        {/* Main content area */}
        <div className="flex-1 flex flex-col overflow-hidden min-w-[280px]">
          {mainContent}
        </div>

        {/* Editor panel + resize handle (mounted only while a file is open) */}
        {editorPanel && (
          <>
            <div
              onPointerDown={startEditorDrag}
              className="w-1 flex-none cursor-col-resize hover:bg-[var(--accent)]/40 active:bg-[var(--accent)]/60 transition-colors duration-100"
            />
            <div
              className="flex min-h-0 shrink-0 flex-col self-stretch border-l border-[color:var(--border-subtle)] bg-[var(--background)] overflow-hidden rounded-l-[var(--radius-md)] animate-in fade-in slide-in-from-right-2"
              style={{ width: liveEditorWidth ?? editorWidth }}
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
              onPointerDown={startDrag}
              className="w-1 flex-none cursor-col-resize hover:bg-[var(--accent)]/40 active:bg-[var(--accent)]/60 transition-colors duration-100"
            />
            <div
              className="flex shrink-0 flex-col border-l border-[color:var(--border-subtle)] bg-[var(--surface-sidebar)] overflow-hidden rounded-l-[var(--radius-md)] animate-in fade-in slide-in-from-right-2"
              style={{ width: liveSideWidth ?? sidePanelWidth }}
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
