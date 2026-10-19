/** Small follows ease; jumps larger than this snap so a new turn still lands immediately. */
const EASE_MAX_PX = 80;

type Slot = {
  easing: boolean;
  target: number;
  last: number;
};

const slots = new WeakMap<HTMLElement, Slot>();

function reducedMotion(): boolean {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function slot(el: HTMLElement): Slot {
  let current = slots.get(el);
  if (current) return current;
  current = { easing: false, target: el.scrollTop, last: el.scrollTop };
  slots.set(el, current);
  const state = current;
  const finish = () => {
    state.easing = false;
    el.style.scrollBehavior = "auto";
  };
  const cancel = () => {
    if (!state.easing) return;
    finish();
    const top = el.scrollTop;
    el.scrollTop = top;
  };
  el.addEventListener("wheel", cancel, { passive: true });
  el.addEventListener("touchstart", cancel, { passive: true });
  el.addEventListener(
    "pointerdown",
    (event) => {
      if (event.target === el) cancel();
    },
  );
  el.addEventListener("scroll", () => {
    if (!state.easing) return;
    const now = el.scrollTop;
    if (now === state.last) return;
    if (Math.abs(now - state.target) < 1) {
      finish();
      state.last = now;
      return;
    }
    const toward = Math.abs(state.target - now) < Math.abs(state.target - state.last) - 0.5;
    state.last = now;
    if (!toward) finish();
  });
  el.addEventListener("scrollend", finish);
  return current;
}

/** Cancel an in-flight smooth follow before a manual disclosure changes layout. */
export function cancelEaseScroll(el: HTMLElement): void {
  const state = slots.get(el);
  if (state) state.easing = false;
  el.style.scrollBehavior = "auto";
  const top = el.scrollTop;
  el.scrollTop = top;
}

/** True while a programmatic smooth follow is still running. */
export function isEaseFollow(el: HTMLElement): boolean {
  return slots.get(el)?.easing ?? false;
}

/**
 * Move scrollTop. Short distances (streaming a line) use smooth scrolling.
 * Long jumps and reduced motion assign immediately so tests and tab switches stay exact.
 */
export function easeScrollTop(el: HTMLElement, top: number): void {
  const delta = top - el.scrollTop;
  if (Math.abs(delta) < 1) return;
  if (reducedMotion() || Math.abs(delta) > EASE_MAX_PX) {
    const current = slots.get(el);
    if (current) current.easing = false;
    el.style.scrollBehavior = "auto";
    el.scrollTop = top;
    return;
  }
  const state = slot(el);
  state.target = top;
  state.last = el.scrollTop;
  state.easing = true;
  el.style.scrollBehavior = "smooth";
  el.scrollTop = top;
  if (Math.abs(el.scrollTop - top) < 1) {
    state.easing = false;
    el.style.scrollBehavior = "auto";
  }
}
