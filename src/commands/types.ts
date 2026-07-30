// src/commands/types.ts
export type Platform = "mac" | "other";

/** Cross-platform logical combo. `primary` = Ctrl on win/linux, Cmd on mac. `key` null = unbound. */
export interface KeyCombo {
  primary?: boolean;
  alt?: boolean;
  shift?: boolean;
  key: string | null;
}

export interface Command {
  id: string;
  title: string;
  category: string;
  defaultKey: KeyCombo | null;
  /** Evaluated at dispatch time; return false to suppress. Omit = always enabled. */
  when?: () => boolean;
  run: () => void;
}

export function detectPlatform(): Platform {
  if (typeof navigator === "undefined") return "other";
  const p = navigator.platform ?? "";
  const ua = navigator.userAgent ?? "";
  return p.startsWith("Mac") || /Macintosh/.test(ua) ? "mac" : "other";
}

const ORDER: (keyof Pick<KeyCombo, "primary" | "alt" | "shift">)[] = ["primary", "alt", "shift"];

export function comboToCanonical(c: KeyCombo | null): string | null {
  if (!c || c.key == null) return null;
  const parts: string[] = [];
  for (const m of ORDER) if (c[m]) parts.push(m);
  parts.push(c.key);
  return parts.join("+");
}

export function canonicalToCombo(s: string | null): KeyCombo | null {
  if (s == null) return { key: null };
  const tokens = s.split("+").filter(Boolean);
  const c: KeyCombo = { key: null };
  for (const t of tokens) {
    if (t === "primary") c.primary = true;
    else if (t === "alt") c.alt = true;
    else if (t === "shift") c.shift = true;
    else c.key = t;
  }
  return c;
}

export function normalizeKeyToken(code: string, key: string): string {
  if (/^Key[A-Z]$/.test(code)) return code.toLowerCase();
  if (/^Digit[0-9]$/.test(code)) return code.toLowerCase();
  return key.toLowerCase();
}

export function isModifierOnly(e: { key: string }): boolean {
  return e.key === "Control" || e.key === "Meta" || e.key === "Shift" || e.key === "Alt";
}

export function eventToLogicalCombo(
  e: { ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean; code: string; key: string },
  p: Platform,
): KeyCombo | null {
  const primary = p === "mac" ? e.metaKey : e.ctrlKey;
  const token = normalizeKeyToken(e.code, e.key);
  if (!token) return null;
  const c: KeyCombo = { key: token };
  if (primary) c.primary = true;
  if (e.altKey) c.alt = true;
  if (e.shiftKey) c.shift = true;
  return c;
}

function labelKey(token: string): string {
  if (/^key[a-z]$/.test(token)) return token.slice(3).toUpperCase();
  if (/^digit[0-9]$/.test(token)) return token.slice(5);
  if (token === "enter") return "↵";
  if (token === "escape") return "Esc";
  if (token === "space") return "Space";
  if (token === "arrowup") return "↑";
  if (token === "arrowdown") return "↓";
  if (token === "arrowleft") return "←";
  if (token === "arrowright") return "→";
  return token.charAt(0).toUpperCase() + token.slice(1);
}

export function comboToLabel(c: KeyCombo | null, p: Platform): string {
  if (!c || c.key == null) return "—";
  const mac = p === "mac";
  const parts: string[] = [];
  if (c.primary) parts.push(mac ? "⌘" : "Ctrl");
  if (c.alt) parts.push(mac ? "⌥" : "Alt");
  if (c.shift) parts.push(mac ? "⇧" : "Shift");
  parts.push(labelKey(c.key));
  return mac ? parts.join("") : parts.join("+");
}
