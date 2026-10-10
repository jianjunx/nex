import { useEffect, useRef, useState } from "react";
import { usePresence } from "@/components/ui/usePresence";
import { useUiStore } from "@/stores/ui.store";
import { useProjectStore } from "@/stores/project.store";
import { TerminalPanel } from "./TerminalPanel";
export function ConversationTerminal() {
  const visible = useUiStore((s) => s.terminalVisible);
  // Don't render the tray until App's startup restore settled the final
  // visibility: the persisted flag would paint it on the first frame, only
  // for the startup sync chain (project validation, per-project map) to flip
  // visibility back — a visible flash. After settling the value is final and
  // the normal presence transition takes over.
  const startupSettled = useUiStore((s) => s.terminalStartupSettled);
  const height = useUiStore((s) => s.terminalHeight);
  const projectId = useProjectStore((s) => s.activeProjectId);
  const presence = usePresence<HTMLElement>(visible);
  const [live, setLive] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ y: number; height: number; max: number } | null>(null);
  useEffect(() => {
    useUiStore.getState().syncTerminalVisibleForProject(projectId);
  }, [projectId]);
  if (!startupSettled || !presence.mounted) return null;
  const shown = presence.shown;
  return (
    <section
      ref={presence.ref}
      aria-label="对话终端"
      data-dragging={dragging ? "true" : undefined}
      className="nex-terminal-pane shrink-0 overflow-hidden border-t border-[var(--hairline-soft)]"
      style={{
        height: shown ? (live ?? height) : 0,
        maxHeight: "50%",
        minHeight: shown ? 100 : 0,
      }}
    >
      <div
        role="separator"
        aria-label="调整终端高度"
        aria-orientation="horizontal"
        tabIndex={0}
        className="nex-handle-row"
        onKeyDown={(e) => {
          if (e.key === "ArrowUp" || e.key === "ArrowDown") {
            e.preventDefault();
            useUiStore
              .getState()
              .setTerminalHeight(
                Math.max(
                  100,
                  Math.min(500, height + (e.key === "ArrowUp" ? 20 : -20)),
                ),
              );
          }
        }}
        onPointerDown={(e) => {
          e.preventDefault();
          e.currentTarget.setPointerCapture(e.pointerId);
          presence.ref.current?.setAttribute("data-dragging", "true");
          setDragging(true);
          drag.current = {
            y: e.clientY,
            height: presence.ref.current?.clientHeight ?? height,
            max: Math.max(
              100,
              (presence.ref.current?.parentElement?.clientHeight ?? 600) / 2,
            ),
          };
        }}
        onPointerMove={(e) => {
          if (drag.current)
            setLive(
              Math.max(
                100,
                Math.min(
                  drag.current.max,
                  drag.current.height + drag.current.y - e.clientY,
                ),
              ),
            );
        }}
        onPointerUp={() => {
          if (live !== null) useUiStore.getState().setTerminalHeight(live);
          drag.current = null;
          presence.ref.current?.removeAttribute("data-dragging");
          setDragging(false);
          setLive(null);
        }}
        onPointerCancel={() => {
          drag.current = null;
          presence.ref.current?.removeAttribute("data-dragging");
          setDragging(false);
          setLive(null);
        }}
      />
      <div className="h-[calc(100%-4px)] min-h-0">
        <TerminalPanel key={projectId ?? "none"} />
      </div>
    </section>
  );
}
