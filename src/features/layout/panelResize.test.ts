/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  EDITOR_MIN,
  HANDLE_W,
  ICON_BAR_W,
  MAIN_MIN_W,
  SIDE_PANEL_MIN,
  beginColResize,
  clamp,
  displayedSideWidth,
  editorWidthBudget,
  sideWidthBudget,
} from "./panelResize";

afterEach(() => {
  delete document.documentElement.dataset.nexResizing;
  document.body.style.userSelect = "";
});

describe("panel resize budgets", () => {
  it("clamps to inclusive min/max", () => {
    expect(clamp(10, 20, 40)).toBe(20);
    expect(clamp(50, 20, 40)).toBe(40);
    expect(clamp(30, 20, 40)).toBe(30);
  });

  it("leaves room for icon bar, main min, and handles", () => {
    const winW = 1200;
    const side = 320;
    const editor = 480;
    const sideMax = sideWidthBudget(winW, editor);
    const leftover =
      winW - ICON_BAR_W - MAIN_MIN_W - HANDLE_W - (HANDLE_W + editor);
    expect(sideMax).toBe(clamp(leftover, SIDE_PANEL_MIN, 640));
    expect(winW - ICON_BAR_W - MAIN_MIN_W - HANDLE_W - HANDLE_W - editor - sideMax).toBeGreaterThanOrEqual(0);

    const editorMax = editorWidthBudget(winW, side);
    expect(editorMax).toBeGreaterThanOrEqual(EDITOR_MIN);
  });

  it("paints the budget, not a stale stored width larger than the window", () => {
    const winW = 700;
    const stored = 500;
    const painted = displayedSideWidth(stored, winW, null);
    expect(painted).toBe(sideWidthBudget(winW, null));
    expect(painted).toBeLessThan(stored);
  });
});

describe("beginColResize", () => {
  function dispatch(type: string, clientX: number, pointerId = 1) {
    window.dispatchEvent(
      new PointerEvent(type, { clientX, pointerId, bubbles: true }),
    );
  }

  it("moves width 1:1 from the painted start, and persists only on pointerup", () => {
    const pane = document.createElement("div");
    document.body.appendChild(pane);
    const liveRef = { current: null as number | null };
    let persisted: number | null = null;

    beginColResize({
      pointerId: 1,
      startX: 400,
      startWidth: 372,
      min: SIDE_PANEL_MIN,
      max: 640,
      pane,
      liveRef,
      persist: (w) => {
        persisted = w;
      },
    });

    dispatch("pointermove", 390);
    expect(pane.style.width).toBe("382px");
    expect(liveRef.current).toBe(382);
    expect(persisted).toBeNull();

    dispatch("pointerup", 380);
    expect(pane.style.width).toBe("392px");
    expect(persisted).toBe(392);
    expect(liveRef.current).toBeNull();
    expect(document.documentElement.dataset.nexResizing).toBeUndefined();
    pane.remove();
  });

  it("does not sit in a dead zone when stored width exceeds the painted width", () => {
    const pane = document.createElement("div");
    document.body.appendChild(pane);
    const liveRef = { current: null as number | null };
    const painted = 372;
    const stored = 500;

    beginColResize({
      pointerId: 1,
      startX: 400,
      startWidth: painted,
      min: SIDE_PANEL_MIN,
      max: 640,
      pane,
      liveRef,
      persist: () => {},
    });

    // Using `stored` as startWidth would still paint 372 after a 10px narrow
    // (500 - 10 still clamps to 372). Painted start follows immediately.
    dispatch("pointermove", 410);
    expect(pane.style.width).toBe("362px");
    expect(stored - painted).toBeGreaterThan(10);
    dispatch("pointerup", 410);
    pane.remove();
  });
});
