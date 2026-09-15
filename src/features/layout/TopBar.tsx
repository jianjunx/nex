import { useEffect, useRef, useState } from "react";
import { IconBar } from "./IconBar";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { WindowControls } from "./WindowControls";

const platform = typeof navigator !== "undefined" ? navigator.platform : "";
const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
const isWindows = platform.startsWith("Win") || ua.includes("Windows");
const isMac = platform.startsWith("Mac") || /Macintosh/.test(ua);

// Left padding (px) that clears the macOS traffic-light cluster when the native
// title bar is overlaid onto this bar (titleBarStyle: "Overlay"). The lights sit
// at ~x20..72, so content starts at 78. In fullscreen the lights float on hover
// over the top-left instead of occupying the bar, so the padding is dropped and
// the bar reclaims the full width — matching native apps.
const MAC_TRAFFIC_LIGHT_PAD = "pl-[78px]";

// Interactive targets must keep their own clicks; the bar's drag/zoom handlers
// ignore them. Portaled Radix overlays live outside this subtree, so they're
// naturally unaffected — which is why we drive dragging from JS mousedown rather
// than a full-bar [data-tauri-drag-region] (the native attribute swallows clicks
// for overlays that sit near the title bar).
const INTERACTIVE =
  "button, input, select, textarea, a, [role='button'], [role='menuitem'], [data-radix-popper-content-wrapper]";

// 空白区双击最大化/恢复的检测窗口（OS 双击判定的近似值）。
const DOUBLE_CLICK_MS = 500;
const DOUBLE_CLICK_SLOP_PX = 8;

function isInteractiveTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement ? !!target.closest(INTERACTIVE) : false;
}

export function TopBar() {
  const [macFullscreen, setMacFullscreen] = useState(false);
  // Overlay mode puts our content under the native title bar, so the OS no
  // longer provides a drag strip or double-click-to-zoom. We re-add both here,
  // on every platform (Windows is frameless for the same reason). On macOS the
  // traffic lights are native controls above the webview, so their clicks never
  // reach these handlers — no special exclusion needed.
  // 双击空白区域最大化/恢复：必须靠 mousedown 计时自己检测。第一次
  // mousedown 的 startDragging() 会进入 OS 拖拽循环，吞掉后续 mouseup /
  // dblclick——等 onDoubleClick 事件永远等不到（Windows 上实测如此）。
  // 所以记录空白区 mousedown 的时间与屏幕坐标，500ms 内第二次按下且
  // 位置基本没动即视为双击：toggleMaximize 并跳过 startDragging。
  const lastBlankDown = useRef<{ t: number; x: number; y: number } | null>(
    null,
  );

  const handleMouseDown = (e: React.MouseEvent) => {
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

  // Track macOS fullscreen to toggle the traffic-light padding (see above).
  // No dedicated fullscreen event exists; a resize fires across the transition,
  // so we re-query isFullscreen then.
  useEffect(() => {
    if (!isMac) return;
    let active = true;
    const win = getCurrentWindow();
    const refresh = () => {
      win
        .isFullscreen()
        .then((v) => active && setMacFullscreen(v))
        .catch(() => {});
    };
    refresh();
    const unlisten = win.onResized(refresh);
    return () => {
      active = false;
      unlisten.then((fn) => fn()).catch(() => {});
    };
  }, []);

  // macOS: compact fused bar (40px) so the overlay traffic lights line up with
  // the tabs. Windows keeps its taller frameless bar with custom window controls.
  const sizing = isMac ? "h-9 gap-2" : "h-10 gap-2";
  const pad =
    isMac && !macFullscreen
      ? MAC_TRAFFIC_LIGHT_PAD + " pr-2"
      : isMac
        ? "px-2.5"
        : "px-3";

  return (
    <div
      onMouseDown={handleMouseDown}
      className={`nex-material-toolbar nex-chrome-edge flex items-center border-b border-[color:var(--hairline-soft)] ${sizing} ${pad}`}
    >
      <div className="flex-1 min-w-0" />
      <IconBar />

      {/* Custom window controls (Windows only — macOS uses the native, overlaid
          traffic lights at the left of this same bar). */}
      {isWindows && (
        <div className="flex items-center">
          <WindowControls />
        </div>
      )}
    </div>
  );
}
