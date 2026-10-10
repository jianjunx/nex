"use client";

import {
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent,
  type HTMLAttributes,
  type MouseEvent,
} from "react";

export type GlideMenuProps = HTMLAttributes<HTMLDivElement> & {
  rowSelector?: string;
  highlightClassName?: string;
  /** Size the pill to the row box. Leave off when CSS pins left/right. */
  fitRow?: boolean;
  /** Keep the pill on this row when the pointer is elsewhere (keyboard selection). */
  activeSelector?: string;
};

type Box = { top: number; left: number; width: number; height: number };

function reducedMotion(): boolean {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function sameBox(a: Box | null, b: Box): boolean {
  return (
    a !== null &&
    a.top === b.top &&
    a.left === b.left &&
    a.width === b.width &&
    a.height === b.height
  );
}

/**
 * One highlight slides between rows. Beautiful UI uses this for sessions
 * and menu options instead of each row fading its own background.
 */
export default function GlideMenu({
  rowSelector = "[data-menu-row]",
  highlightClassName = "inset-x-0 rounded-[8px] bg-hover",
  fitRow = false,
  activeSelector,
  className = "",
  children,
  ...props
}: GlideMenuProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const pointerRef = useRef<HTMLElement | null>(null);
  const [highlight, setHighlight] = useState<Box | null>(null);
  const [visible, setVisible] = useState(false);
  const [glide, setGlide] = useState(false);

  const moveTo = (row: HTMLElement) => {
    const root = rootRef.current;
    if (!root) return;
    const rootBounds = root.getBoundingClientRect();
    const rowBounds = row.getBoundingClientRect();
    const next: Box = {
      top: Math.round(rowBounds.top - rootBounds.top + root.scrollTop),
      left: Math.round(rowBounds.left - rootBounds.left + root.scrollLeft),
      width: Math.round(rowBounds.width),
      height: Math.round(rowBounds.height),
    };
    setHighlight((prev) => (sameBox(prev, next) ? prev : next));
    setVisible(true);
  };

  const rowFrom = (target: EventTarget | null) => {
    const root = rootRef.current;
    if (!(target instanceof Element) || !root) return null;
    const row = target.closest(rowSelector);
    if (!(row instanceof HTMLElement) || !root.contains(row)) return null;
    return row;
  };

  const showActive = () => {
    const root = rootRef.current;
    if (!activeSelector || !root) return false;
    const row = root.querySelector(activeSelector);
    if (!(row instanceof HTMLElement)) return false;
    moveTo(row);
    return true;
  };

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const pointer = pointerRef.current;
    if (pointer && root.contains(pointer)) {
      moveTo(pointer);
      return;
    }
    if (!activeSelector) return;
    if (!showActive()) setVisible(false);
    // Reposition when the row list or keyboard target changes. Pointer moves
    // are handled by the mouse/focus events, so this must not depend on highlight.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSelector, children]);

  useLayoutEffect(() => {
    if (!visible || glide) return;
    const frame = requestAnimationFrame(() => setGlide(true));
    return () => cancelAnimationFrame(frame);
  }, [visible, glide]);

  const settle = () => {
    pointerRef.current = null;
    if (!showActive()) setVisible(false);
  };

  const handleMouseOver = (event: MouseEvent<HTMLDivElement>) => {
    const row = rowFrom(event.target);
    if (!row) return;
    pointerRef.current = row;
    moveTo(row);
  };
  const handleFocus = (event: FocusEvent<HTMLDivElement>) => {
    const row = rowFrom(event.target);
    if (!row) return;
    pointerRef.current = row;
    moveTo(row);
  };
  const handleBlur = (event: FocusEvent<HTMLDivElement>) => {
    if (rootRef.current?.contains(event.relatedTarget as Node)) return;
    settle();
  };

  const reduced = reducedMotion();
  const motion =
    reduced || !glide
      ? "opacity var(--duration-fast) ease"
      : "top var(--duration-medium) var(--ease-spring), height var(--duration-medium) var(--ease-spring), left var(--duration-medium) var(--ease-spring), width var(--duration-medium) var(--ease-spring), opacity var(--duration-fast) ease";

  return (
    <div
      ref={rootRef}
      className={`nex-glide group/glide-menu relative ${className}`}
      onMouseOver={handleMouseOver}
      onMouseLeave={settle}
      onFocusCapture={handleFocus}
      onBlurCapture={handleBlur}
      {...props}
    >
      <span
        aria-hidden="true"
        className={`pointer-events-none absolute ${highlightClassName}`}
        style={{
          top: highlight?.top ?? 0,
          height: highlight?.height ?? 0,
          ...(fitRow
            ? { left: highlight?.left ?? 0, width: highlight?.width ?? 0 }
            : null),
          opacity: highlight && visible ? 1 : 0,
          transition: reduced ? "none" : motion,
        }}
      />
      {children}
    </div>
  );
}
