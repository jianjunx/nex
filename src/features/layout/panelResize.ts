/** Right-pane split metrics and pointer-driven width updates. */

export const SIDE_PANEL_MIN = 240;
export const SIDE_PANEL_MAX = 640;
export const EDITOR_MIN = 320;
export const EDITOR_MAX = 960;
/** IconBar is `w-11` (2.75rem @ 16px). */
export const ICON_BAR_W = 44;
export const MAIN_MIN_W = 280;
export const HANDLE_W = 4;

export function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n));
}

/**
 * Max editor width that still leaves room for the main column, icon bar,
 * and the current side panel (`null` when the side panel is hidden).
 */
export function editorWidthBudget(winW: number, sideW: number | null): number {
  const sideSpace = sideW == null ? 0 : HANDLE_W + sideW;
  return clamp(
    winW - ICON_BAR_W - MAIN_MIN_W - HANDLE_W - sideSpace,
    EDITOR_MIN,
    EDITOR_MAX,
  );
}

/**
 * Max side-panel width that still leaves room for the main column, icon bar,
 * and the current editor (`null` when the editor is hidden).
 */
export function sideWidthBudget(winW: number, editorW: number | null): number {
  const editorSpace = editorW == null ? 0 : HANDLE_W + editorW;
  return clamp(
    winW - ICON_BAR_W - MAIN_MIN_W - HANDLE_W - editorSpace,
    SIDE_PANEL_MIN,
    SIDE_PANEL_MAX,
  );
}

/** Width actually painted for the editor (stored value may exceed the budget). */
export function displayedEditorWidth(
  stored: number,
  winW: number,
  sideW: number | null,
): number {
  return clamp(stored, EDITOR_MIN, editorWidthBudget(winW, sideW));
}

/** Width actually painted for the side panel. */
export function displayedSideWidth(
  stored: number,
  winW: number,
  editorW: number | null,
): number {
  return clamp(stored, SIDE_PANEL_MIN, sideWidthBudget(winW, editorW));
}

export type ColResizeLiveRef = { current: number | null };

/**
 * Track a column-resize gesture 1:1 with the pointer.
 *
 * Writes `pane.style.width` directly so Chat / editor / file-tree do not
 * re-render on every pointermove. `startWidth` must be the *painted* width,
 * not the (possibly unclamped) persisted store value.
 */
export function beginColResize(args: {
  pointerId: number;
  startX: number;
  startWidth: number;
  min: number;
  max: number | (() => number);
  pane: HTMLElement | null;
  liveRef: ColResizeLiveRef;
  persist: (width: number) => void;
}): void {
  const { pointerId, startX, startWidth, min, pane, liveRef, persist } = args;
  const prevUserSelect = document.body.style.userSelect;
  document.body.style.userSelect = "none";
  document.documentElement.dataset.nexResizing = "1";
  try {
    document.documentElement.setPointerCapture(pointerId);
  } catch {
    // jsdom / some WebViews only capture on the event target.
  }

  const maxNow = () => (typeof args.max === "function" ? args.max() : args.max);

  const apply = (clientX: number) => {
    const next = clamp(startWidth + (startX - clientX), min, maxNow());
    liveRef.current = next;
    if (pane) pane.style.width = `${next}px`;
    return next;
  };

  const onMove = (ev: PointerEvent) => {
    if (ev.pointerId !== pointerId) return;
    apply(ev.clientX);
  };

  const teardown = () => {
    document.body.style.userSelect = prevUserSelect;
    delete document.documentElement.dataset.nexResizing;
    try {
      document.documentElement.releasePointerCapture(pointerId);
    } catch {
      /* already released */
    }
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onUp);
  };

  const onUp = (ev: PointerEvent) => {
    if (ev.pointerId !== pointerId) return;
    const next = apply(ev.clientX);
    persist(next);
    liveRef.current = null;
    teardown();
  };

  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onUp);
}
