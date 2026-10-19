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
  /** Pointer position normalized to CSS px. */
  x: number;
  y: number;
}

/**
 * Subscribe to OS file drag/drop events on the current window.
 * Wry reports logical points on macOS/GTK, but physical pixels on Windows.
 * Only Windows positions need the cached window scale factor applied.
 */
export function useOsDragDrop(onEvent: (e: OsDragDropEvent) => void): void {
  const handlerRef = useRef(onEvent);
  handlerRef.current = onEvent;

  useEffect(() => {
    let disposed = false;
    let unlistenDrop: (() => void) | undefined;
    let unlistenScale: (() => void) | undefined;
    const physicalCoordinates = /^Win/.test(navigator.platform) || /Windows/.test(navigator.userAgent);
    let factor = physicalCoordinates ? window.devicePixelRatio || 1 : 1;

    if (physicalCoordinates) {
      void getCurrentWindow()
        .scaleFactor()
        .then((f) => {
          if (!disposed) factor = f;
        })
        .catch(() => { /* Keep the devicePixelRatio fallback. */ });

      void listen<{ scaleFactor: number }>("tauri://scale-factor-changed", (e) => {
        factor = e.payload.scaleFactor;
      }).then((u) => {
        if (disposed) u();
        else unlistenScale = u;
      });
    }

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
