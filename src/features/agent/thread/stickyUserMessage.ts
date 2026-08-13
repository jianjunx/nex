export const USER_MESSAGE_COLLAPSE_HEIGHT = 230;

export type UserStickyCandidate = {
  index: number;
  id: string;
  start: number;
  height: number;
};

export type StickyUserMessage = {
  id: string;
  index: number;
  translateY: number;
};

/**
 * Pick the single user message that should pin to the top of the thread.
 * The last candidate whose start has scrolled past the viewport top wins;
 * the next candidate pushes it up so only one stays stuck.
 *
 * At scrollTop 0 nothing sticks — the in-list bubble is already at the top.
 */
export function pickStickyUserMessage(
  candidates: UserStickyCandidate[],
  scrollTop: number,
): StickyUserMessage | null {
  if (candidates.length === 0 || scrollTop <= 0) return null;

  let current: UserStickyCandidate | null = null;
  let next: UserStickyCandidate | null = null;
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    if (c.start <= scrollTop) {
      current = c;
      next = candidates[i + 1] ?? null;
    } else {
      break;
    }
  }
  if (!current) return null;

  let translateY = 0;
  if (next) {
    const gap = next.start - scrollTop;
    if (gap < current.height) {
      translateY = gap - current.height;
    }
  }
  return { id: current.id, index: current.index, translateY };
}
