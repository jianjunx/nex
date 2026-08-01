/** Prefer ACP allow kinds, then id/label heuristics. */
export function pickAllowOptionId(
  options: { optionId: string; label: string; kind?: string | null }[],
): string | null {
  if (options.length === 0) return null;

  const byKind = (kind: string) =>
    options.find((o) => (o.kind ?? "").toLowerCase() === kind)?.optionId ?? null;

  const always = byKind("allow_always");
  if (always) return always;
  const once = byKind("allow_once");
  if (once) return once;

  const scored = options
    .map((o) => {
      const hay = `${o.optionId} ${o.label}`.toLowerCase();
      if (/reject|deny|cancel|block/.test(hay)) return { id: o.optionId, score: -1 };
      if (/allow.?always|always.?allow/.test(hay)) return { id: o.optionId, score: 3 };
      if (/allow/.test(hay)) return { id: o.optionId, score: 2 };
      return { id: o.optionId, score: 0 };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);

  return scored[0]?.id ?? null;
}
