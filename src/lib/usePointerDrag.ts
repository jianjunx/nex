import { useCallback, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";

const DRAG_THRESHOLD_PX = 5;
const GHOST_OFFSET_PX = 8;

export interface PointerDragCallbacks<P> {
  /** Fired once, when the pointer crosses the move threshold. */
  onBegin?: (payload: P) => void;
  /** rAF-throttled; x/y are viewport CSS px. */
  onMove?: (payload: P, x: number, y: number) => void;
  /** Pointer released after a real drag. */
  onDrop?: (payload: P, x: number, y: number) => void;
  /** pointercancel — drag aborted by the OS. */
  onCancel?: (payload: P) => void;
  /** Always fired after onDrop/onCancel. */
  onEnd?: (payload: P) => void;
  /** Called on every processed move — use for edge autoscroll. */
  autoscroll?: (x: number, y: number) => void;
}

/**
 * Pointer-event based drag (HTML5 DnD is unreliable in Tauri WebView — with
 * `dragDropEnabled` it is dead code on Windows; precedent: useTabReorder).
 *
 * - 5px threshold keeps plain clicks untouched.
 * - Pointer capture (try/catch guarded) keeps events flowing when the pointer
 *   leaves the window; the compat `click` fired on release is suppressed in
 *   capture phase so dropping never accidentally opens/expands the source row.
 * - The ghost element (rendered by the caller via `ghostRef`, always mounted,
 *   `pointer-events:none`) is moved by mutating `transform` — zero React
 *   state per frame; moves are coalesced to one `requestAnimationFrame`.
 * - `start` is referentially stable, so memoized rows can take it as a prop.
 */
export function usePointerDrag<P>(callbacks: PointerDragCallbacks<P>): {
  /** Non-null while a drag is active (use for ghost content / dimming). */
  payload: P | null;
  /** Bind as `onPointerDown={start(payload)}` on the drag source. */
  start: (payload: P) => (e: ReactPointerEvent) => void;
  /** Attach to the (always mounted, initially hidden) ghost element. */
  ghostRef: RefObject<HTMLDivElement | null>;
} {
  const [payload, setPayload] = useState<P | null>(null);
  const cbRef = useRef(callbacks);
  cbRef.current = callbacks;
  const ghostRef = useRef<HTMLDivElement | null>(null);
  const rafRef = useRef(0);

  const start = useCallback((p: P) => (e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    const startX = e.clientX;
    const startY = e.clientY;
    const source = e.currentTarget as HTMLElement;
    const pointerId = e.pointerId;
    // Without capture, releasing outside the window would strand the drag;
    // not fatal where unsupported.
    try { source.setPointerCapture?.(pointerId); } catch { /* unsupported */ }

    let moved = false;
    let pendingX = 0;
    let pendingY = 0;
    const prevUserSelect = document.body.style.userSelect;

    const moveGhost = (x: number, y: number) => {
      const g = ghostRef.current;
      if (g) g.style.transform = `translate(${x + GHOST_OFFSET_PX}px, ${y + GHOST_OFFSET_PX}px)`;
    };

    const finish = (dropped: boolean, x: number, y: number) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = 0;
      }
      document.body.style.userSelect = prevUserSelect;
      try { source.releasePointerCapture?.(pointerId); } catch { /* already released */ }
      const g = ghostRef.current;
      if (g) g.style.display = "none";
      if (!moved) return;
      // Pointer capture retargets the compat click to the source row;
      // swallow it so a drop never opens/expands the dragged node.
      const suppress = (ev: MouseEvent) => {
        ev.stopPropagation();
        ev.preventDefault();
      };
      window.addEventListener("click", suppress, true);
      setTimeout(() => window.removeEventListener("click", suppress, true), 100);
      setPayload(null);
      if (dropped) cbRef.current.onDrop?.(p, x, y);
      else cbRef.current.onCancel?.(p);
      cbRef.current.onEnd?.(p);
    };

    const process = () => {
      rafRef.current = 0;
      moveGhost(pendingX, pendingY);
      cbRef.current.autoscroll?.(pendingX, pendingY);
      cbRef.current.onMove?.(p, pendingX, pendingY);
    };

    const onMove = (ev: PointerEvent) => {
      if (!moved) {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < DRAG_THRESHOLD_PX) return;
        moved = true;
        document.body.style.userSelect = "none";
        moveGhost(ev.clientX, ev.clientY);
        const g = ghostRef.current;
        if (g) g.style.display = "flex";
        setPayload(p);
        cbRef.current.onBegin?.(p);
      }
      pendingX = ev.clientX;
      pendingY = ev.clientY;
      if (!rafRef.current) rafRef.current = requestAnimationFrame(process);
    };

    const onUp = (ev: PointerEvent) => finish(true, ev.clientX, ev.clientY);
    const onCancel = () => finish(false, -1, -1);

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
  }, []);

  return { payload, start, ghostRef };
}
