import { useEffect, useRef, useState } from "react";
import { useUiStore } from "@/stores/ui.store";
import { useProjectStore } from "@/stores/project.store";
import { TerminalPanel } from "./TerminalPanel";
export function ConversationTerminal() {
  const visible = useUiStore((s) => s.terminalVisible);
  const height = useUiStore((s) => s.terminalHeight);
  const projectId = useProjectStore((s) => s.activeProjectId);
  const root = useRef<HTMLDivElement>(null);
  const [live, setLive] = useState<number | null>(null);
  const drag = useRef<{ y: number; height: number; max: number } | null>(null);
  useEffect(() => {
    useUiStore.getState().syncTerminalVisibleForProject(projectId);
  }, [projectId]);
  if (!visible) return null;
  return (
    <section
      ref={root}
      aria-label="对话终端"
      className="shrink-0 overflow-hidden border-t border-[var(--hairline-soft)]"
      style={{ height: live ?? height, maxHeight: "50%", minHeight: 100 }}
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
          drag.current = {
            y: e.clientY,
            height: root.current?.clientHeight ?? height,
            max: Math.max(
              100,
              (root.current?.parentElement?.clientHeight ?? 600) / 2,
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
          setLive(null);
        }}
        onPointerCancel={() => {
          drag.current = null;
          setLive(null);
        }}
      />
      <div className="h-[calc(100%-4px)] min-h-0">
        <TerminalPanel key={projectId ?? "none"} />
      </div>
    </section>
  );
}
