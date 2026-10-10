import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

const platform = typeof navigator !== "undefined" ? navigator.platform : "";
const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
export const isWindows = platform.startsWith("Win") || ua.includes("Windows");
export const isMac = platform.startsWith("Mac") || /Macintosh/.test(ua);

/**
 * Left padding (px) that clears the macOS traffic-light cluster when the native
 * title bar is overlaid onto our content (titleBarStyle: "Overlay"). The lights
 * sit at ~x20..72, so content starts at 78. In fullscreen the lights float on
 * hover instead of occupying the bar, so the padding is dropped.
 */
export const MAC_TRAFFIC_LIGHT_PAD_PX = 78;

/** Title-bar row height. macOS traffic lights are centred on it via tauri.conf trafficLightPosition. */
export const TITLE_BAR_HEIGHT_CLASS = "h-11";

// Interactive targets must keep their own clicks; the drag/zoom handlers ignore
// them. Portaled Radix overlays live outside this subtree, so they're naturally
// unaffected — which is why dragging is driven from JS mousedown rather than a
// [data-tauri-drag-region] attribute (it swallows clicks for overlays near the
// title bar).
const INTERACTIVE =
  "button, input, select, textarea, a, [role='button'], [role='menuitem'], [data-radix-popper-content-wrapper]";

// 空白区双击最大化/恢复的检测窗口（OS 双击判定的近似值）。
const DOUBLE_CLICK_MS = 500;
const DOUBLE_CLICK_SLOP_PX = 8;

function isInteractiveTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement ? !!target.closest(INTERACTIVE) : false;
}

/** Tracks macOS fullscreen; always false elsewhere. */
export function useMacFullscreen(): boolean {
  const [fullscreen, setFullscreen] = useState(false);
  // No dedicated fullscreen event exists; a resize fires across the transition,
  // so we re-query isFullscreen then.
  useEffect(() => {
    if (!isMac) return;
    let active = true;
    const win = getCurrentWindow();
    const refresh = () => {
      win
        .isFullscreen()
        .then((v) => active && setFullscreen(v))
        .catch(() => {});
    };
    refresh();
    const unlisten = win.onResized(refresh);
    return () => {
      active = false;
      unlisten.then((fn) => fn()).catch(() => {});
    };
  }, []);
  return fullscreen;
}

/**
 * Overlay mode puts our content under the native title bar, so the OS no longer
 * provides a drag strip or double-click-to-zoom. Re-add both on every platform
 * (Windows is frameless for the same reason). On macOS the traffic lights are
 * native controls above the webview, so their clicks never reach this handler.
 *
 * 双击空白区域最大化/恢复：必须靠 mousedown 计时自己检测。第一次 mousedown 的
 * startDragging() 会进入 OS 拖拽循环，吞掉后续 mouseup / dblclick——等
 * onDoubleClick 事件永远等不到（Windows 上实测如此）。所以记录空白区 mousedown
 * 的时间与屏幕坐标，500ms 内第二次按下且位置基本没动即视为双击：toggleMaximize
 * 并跳过 startDragging。
 */
export function useTitleBarDrag(): (e: React.MouseEvent) => void {
  const lastBlankDown = useRef<{ t: number; x: number; y: number } | null>(null);
  return (e) => {
    if (e.button !== 0 || isInteractiveTarget(e.target)) return;
    const last = lastBlankDown.current;
    const now = Date.now();
    const isDouble =
      last !== null &&
      now - last.t < DOUBLE_CLICK_MS &&
      Math.abs(e.screenX - last.x) <= DOUBLE_CLICK_SLOP_PX &&
      Math.abs(e.screenY - last.y) <= DOUBLE_CLICK_SLOP_PX;
    if (isDouble) {
      lastBlankDown.current = null;
      void getCurrentWindow().toggleMaximize();
      return;
    }
    lastBlankDown.current = { t: now, x: e.screenX, y: e.screenY };
    void getCurrentWindow().startDragging();
  };
}
