export type SessionStatusLike = "starting" | "idle" | "running" | "waiting";

export function projectSessionIndicators(
  conversationIds: string[],
  sessions: Record<string, { status: SessionStatusLike } | undefined>,
): { hasRunning: boolean; hasWaiting: boolean } {
  let hasRunning = false;
  let hasWaiting = false;
  for (const id of conversationIds) {
    const status = sessions[id]?.status;
    if (status === "running") hasRunning = true;
    if (status === "waiting") hasWaiting = true;
    if (hasRunning && hasWaiting) break;
  }
  return { hasRunning, hasWaiting };
}
