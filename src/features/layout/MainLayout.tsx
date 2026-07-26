import type { ReactNode } from "react";
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

export function MainLayout({ mainContent, editorPanel, sidePanel }: MainLayoutProps) {
  const { sidePanelVisible, sidePanelWidth, setSidePanelWidth, editorWidth, setEditorWidth } = useUiStore();

  // Drag the handle on the panel's left edge: moving left widens the panel.
  const startDrag = (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = useUiStore.getState().sidePanelWidth;
    const prevUserSelect = document.body.style.userSelect;
    document.body.style.userSelect = "none";

    const onMove = (ev: PointerEvent) => {
      const next = startWidth + (startX - ev.clientX);
      setSidePanelWidth(Math.min(SIDE_PANEL_MAX, Math.max(SIDE_PANEL_MIN, next)));
    };
    const onUp = () => {
      document.body.style.userSelect = prevUserSelect;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  // Drag the handle on the panel's left edge: moving left widens the panel.
  const startEditorDrag = (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = useUiStore.getState().editorWidth;
    const prevUserSelect = document.body.style.userSelect;
    document.body.style.userSelect = "none";

    const onMove = (ev: PointerEvent) => {
      const next = startWidth + (startX - ev.clientX);
      setEditorWidth(Math.min(EDITOR_MAX, Math.max(EDITOR_MIN, next)));
    };
    const onUp = () => {
      document.body.style.userSelect = prevUserSelect;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
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
              className="w-1 flex-none cursor-col-resize hover:bg-[var(--accent)]/40 active:bg-[var(--accent)]/60 transition-colors"
            />
            <div
              className="flex flex-col h-full border-l border-[color:var(--border-subtle)] overflow-hidden rounded-l-[var(--radius-md)]"
              style={{ width: editorWidth }}
            >
              <div className="flex-1 min-h-0 overflow-hidden">
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
              className="w-1 flex-none cursor-col-resize hover:bg-[var(--accent)]/40 active:bg-[var(--accent)]/60 transition-colors"
            />
            <div
              className="flex flex-col border-l border-[color:var(--border-subtle)] overflow-hidden rounded-l-[var(--radius-md)]"
              style={{ width: sidePanelWidth }}
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
