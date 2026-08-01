/** Move an item within an array (immutable). Clamps `to` into range. */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  if (from === to || from < 0 || from >= list.length) return [...list];
  const next = [...list];
  const [item] = next.splice(from, 1);
  const clamped = Math.max(0, Math.min(to, next.length));
  next.splice(clamped, 0, item);
  return next;
}
