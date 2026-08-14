import { useEffect, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";

/**
 * OS-level file drag/drop events, normalized to CSS pixels.
 *
 * Tauri's `dragDropEnabled: true` intercepts OS file drags before the webview
 * sees them (HTML5 drop events never fire for files — and on Windows that
 * setting blocks HTML5 DnD entirely). `onDragDropEvent` is the supported,
 * cross-platform channel: it provides absolute paths and the pointer position.
 */
export interface OsDragDropEvent {
  type: "enter" | "over" | "drop" | "leave";
  /** Absolute file paths; present for `enter` and `drop`. */
  paths?: string[];
  /** Pointer position in CSS px (already divided by the window scale factor). */
  x: number;
  y: number;
}

/**
 * Subscribe to OS file drag/drop events on the current window.
 * Positions arrive as physical pixels and are converted here; the scale
 * factor is cached and refreshed on `tauri://scale-factor-changed`.
 */
export function useOsDragDrop(onEvent: (e: OsDragDropEvent) => void): void {
  const handlerRef = useRef(onEvent);
  handlerRef.current = onEvent;

  useEffect(() => {
    let disposed = false;
    let unlistenDrop: (() => void) | undefined;
    let unlistenScale: (() => void) | undefined;
    // Fallback until the async scaleFactor() resolves.
    let factor = window.devicePixelRatio || 1;

    void getCurrentWindow()
      .scaleFactor()
      .then((f) => {
        if (!disposed) factor = f;
      });

    void listen<{ scaleFactor: number }>("tauri://scale-factor-changed", (e) => {
      factor = e.payload.scaleFactor;
    }).then((u) => {
      if (disposed) u();
      else unlistenScale = u;
    });

    void getCurrentWindow()
      .onDragDropEvent((ev) => {
        const p = ev.payload;
        if (p.type === "leave") {
          handlerRef.current({ type: "leave", x: -1, y: -1 });
          return;
        }
        handlerRef.current({
          type: p.type,
          paths: p.type === "enter" || p.type === "drop" ? p.paths : undefined,
          x: p.position.x / factor,
          y: p.position.y / factor,
        });
      })
      .then((u) => {
        if (disposed) u();
        else unlistenDrop = u;
      });

    return () => {
      disposed = true;
      unlistenDrop?.();
      unlistenScale?.();
    };
  }, []);
}
