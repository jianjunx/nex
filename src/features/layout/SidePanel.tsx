import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useUiStore } from "../../stores/ui.store";
import { useProjectStore } from "../../stores/project.store";
import { FileTree } from "../files/FileTree";
import { GitPanel } from "../git/GitPanel";
import { SearchPanel } from "../search/SearchPanel";
import { TerminalPanel } from "../terminal/TerminalPanel";

// Terminal height clamp (px); persisted via ui.store.
const TERMINAL_MIN = 100;
/** Keep at least this much room for the upper tab content while dragging. */
const UPPER_MIN = 80;

function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n));
}

export function SidePanel() {
  const { sidePanelTab, terminalVisible, terminalHeight, setTerminalHeight, syncTerminalVisibleForProject } = useUiStore();
  const activeProjectId = useProjectStore((s) => s.activeProjectId);
  const panelRef = useRef<HTMLDivElement>(null);

  // Terminal show/hide is per-project (like PTY tabs). Sync before TerminalPanel
  // mounts/unmounts so a hidden project does not keep another project's tray open.
  useEffect(() => {
    syncTerminalVisibleForProject(activeProjectId);
  }, [activeProjectId, syncTerminalVisibleForProject]);

  // Live height during drag — keep pointer moves off the persisted store so
  // localStorage writes don't stutter the resize.
  const [liveHeight, setLiveHeight] = useState<number | null>(null);

  // Drag the handle on the terminal's top edge: moving up grows the terminal.
  const startTerminalDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const startY = e.clientY;
    const startHeight = useUiStore.getState().terminalHeight;
    const panelH = panelRef.current?.clientHeight ?? 0;
    const maxH = Math.max(TERMINAL_MIN, panelH - UPPER_MIN);
    const prevUserSelect = document.body.style.userSelect;
    document.body.style.userSelect = "none";

    const onMove = (ev: PointerEvent) => {
      setLiveHeight(clamp(startHeight + (startY - ev.clientY), TERMINAL_MIN, maxH));
    };
    const onUp = (ev: PointerEvent) => {
      const next = clamp(startHeight + (startY - ev.clientY), TERMINAL_MIN, maxH);
      setTerminalHeight(next);
      setLiveHeight(null);
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
    <div ref={panelRef} className="flex flex-col h-full">
      {/* Upper: active tab content */}
      <div className="flex-1 overflow-hidden min-h-0">
        {sidePanelTab === "files" && <FileTree />}
        {sidePanelTab === "git" && <GitPanel />}
        {sidePanelTab === "search" && <SearchPanel />}
      </div>

      {/* Lower: terminal + resize handle */}
      {terminalVisible && (
        <>
          <div
            onPointerDown={startTerminalDrag}
            className="nex-handle-row"
          />
          <div
            className="border-t border-[color:var(--border-subtle)] bg-[var(--surface-sidebar)] shrink-0 overflow-hidden"
            style={{ height: liveHeight ?? terminalHeight }}
          >
            <TerminalPanel key={activeProjectId ?? "none"} />
          </div>
        </>
      )}
    </div>
  );
}
