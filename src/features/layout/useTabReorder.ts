import { useCallback, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

const DRAG_THRESHOLD_PX = 5;

type BindTab = {
  "data-tab-index": number;
  onPointerDown: (e: ReactPointerEvent) => void;
  className?: string;
};

/**
 * Pointer-based tab reorder (HTML5 DnD is unreliable on <button> / Tauri WebView).
 * Past a small move threshold, hovering another `[data-tab-index]` live-reorders.
 */
export function useTabReorder(onReorder: (from: number, to: number) => void): {
  draggingIndex: number | null;
  bindTab: (index: number) => BindTab;
} {
  const [draggingIndex, setDraggingIndex] = useState<number | null>(null);
  const onReorderRef = useRef(onReorder);
  onReorderRef.current = onReorder;

  const bindTab = useCallback((index: number): BindTab => ({
    "data-tab-index": index,
    onPointerDown: (e: ReactPointerEvent) => {
      if (e.button !== 0) return;
      if ((e.target as HTMLElement).closest("[data-tab-close]")) return;

      const startX = e.clientX;
      const startY = e.clientY;
      let moved = false;
      let currentFrom = index;
      const prevUserSelect = document.body.style.userSelect;

      const onMove = (ev: PointerEvent) => {
        if (!moved) {
          if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < DRAG_THRESHOLD_PX) return;
          moved = true;
          document.body.style.userSelect = "none";
          setDraggingIndex(currentFrom);
        }
        const hit = document.elementFromPoint?.(ev.clientX, ev.clientY)?.closest("[data-tab-index]");
        if (!(hit instanceof HTMLElement)) return;
        const to = Number(hit.dataset.tabIndex);
        if (!Number.isFinite(to) || to === currentFrom) return;
        onReorderRef.current(currentFrom, to);
        currentFrom = to;
        setDraggingIndex(to);
      };

      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
        document.body.style.userSelect = prevUserSelect;
        setDraggingIndex(null);
      };

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    },
  }), []);

  return { draggingIndex, bindTab };
}
