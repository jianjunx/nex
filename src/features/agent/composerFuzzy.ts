/**
 * Lightweight fuzzy score for composer slash/@ menus.
 * Returns null when `target` does not contain `query` as a subsequence;
 * higher is better. No deps — kept outside React for cheap re-filter.
 */

export function fuzzyScore(query: string, target: string): number | null {
  const q = query.trim().toLowerCase();
  const t = target.toLowerCase();
  if (!q) return 0;
  if (t === q) return 10_000;
  if (t.startsWith(q)) return 5_000 - (t.length - q.length);
  if (t.includes(q)) return 1_000 - t.indexOf(q);

  // Subsequence: "lcd" → "lark-contact-doc"
  let ti = 0;
  let score = 0;
  let prev = -2;
  for (let qi = 0; qi < q.length; qi++) {
    const ch = q[qi]!;
    const found = t.indexOf(ch, ti);
    if (found < 0) return null;
    score += 10;
    if (found === prev + 1) score += 5; // consecutive bonus
    if (found === 0 || /[-_/.]/.test(t[found - 1]!)) score += 8; // boundary bonus
    prev = found;
    ti = found + 1;
  }
  score -= t.length; // prefer shorter
  return score;
}

export function fuzzyFilter<T>(
  items: T[],
  query: string,
  getText: (item: T) => string,
  limit = 50,
): T[] {
  const q = query.trim();
  if (!q) return items.slice(0, limit);
  const scored: { item: T; score: number }[] = [];
  for (const item of items) {
    const s = fuzzyScore(q, getText(item));
    if (s == null) continue;
    scored.push({ item, score: s });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((x) => x.item);
}
