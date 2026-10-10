import { useLayoutEffect, useRef, useState } from "react";

const MOTION_PROPS = new Set([
  "grid-template-rows",
  "width",
  "height",
  "min-height",
  "max-height",
]);

function prefersReducedMotion(): boolean {
  if (typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Computed transition length. `0` when motion is off or styles are not applied (tests). */
export function motionMs(el: HTMLElement | null): number {
  if (!el || prefersReducedMotion()) return 0;
  const first = (getComputedStyle(el).transitionDuration || "").split(",")[0]?.trim() ?? "";
  const value = Number.parseFloat(first);
  if (!first || !Number.isFinite(value) || value <= 0) return 0;
  return first.endsWith("ms") ? value : value * 1000;
}

/**
 * Keep a node mounted long enough for its CSS size transition to finish.
 * When the computed duration is 0 the closed tree unmounts in the same frame,
 * so tests that assert absence still pass.
 */
export function usePresence<T extends HTMLElement = HTMLDivElement>(open: boolean) {
  const ref = useRef<T>(null);
  const openRef = useRef(open);
  openRef.current = open;
  const [mounted, setMounted] = useState(open);
  const [shown, setShown] = useState(open);
  // Mount in the same render that opens, so parents can measure the new node
  // in useLayoutEffect. Closing stays in the effect so the size transition can play.
  if (open && !mounted) setMounted(true);

  useLayoutEffect(() => {
    if (open) {
      setMounted(true);
      return;
    }
    setShown(false);
    const el = ref.current;
    const ms = motionMs(el);
    if (ms === 0 || !el) {
      setMounted(false);
      return;
    }
    let finished = false;
    const finish = () => {
      if (finished || openRef.current) return;
      finished = true;
      setMounted(false);
    };
    const onEnd = (event: TransitionEvent) => {
      if (event.target !== el || !MOTION_PROPS.has(event.propertyName)) return;
      finish();
    };
    el.addEventListener("transitionend", onEnd);
    const timer = window.setTimeout(finish, ms);
    return () => {
      finished = true;
      window.clearTimeout(timer);
      el.removeEventListener("transitionend", onEnd);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open || !mounted) return;
    if (shown || motionMs(ref.current) === 0) {
      if (!shown) setShown(true);
      return;
    }
    const frame = requestAnimationFrame(() => {
      if (openRef.current) setShown(true);
    });
    return () => cancelAnimationFrame(frame);
  }, [open, mounted, shown]);

  return { ref, mounted, shown };
}
