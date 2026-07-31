import type { SearchOptions } from "../../bridge/tauri";

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Mirror of the backend compile_pattern (escape → whole-word wrap) using
 * JS-native flags for case handling. Returns null when the pattern does not
 * compile under the JS dialect — highlighting then degrades silently while
 * matching itself stays authoritative on the Rust side.
 */
export function buildHighlightRegExp(query: string, options: SearchOptions): RegExp | null {
  if (!query) return null;
  try {
    let pattern = options.regex ? query : escapeRegExp(query);
    if (options.wholeWord) pattern = `\\b(?:${pattern})\\b`;
    return new RegExp(pattern, options.caseSensitive ? "g" : "gi");
  } catch {
    return null;
  }
}

export type MatchRange = [number, number];

/** Non-overlapping match spans of `re` within `text`; safe on zero-length
 *  matches (advances lastIndex) and capped to avoid pathological loops. */
export function matchRanges(text: string, re: RegExp | null): MatchRange[] {
  if (!re) return [];
  const ranges: MatchRange[] = [];
  re.lastIndex = 0;
  let guard = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null && guard++ < 1000) {
    if (m[0].length === 0) {
      re.lastIndex++;
      continue;
    }
    ranges.push([m.index, m.index + m[0].length]);
  }
  return ranges;
}
