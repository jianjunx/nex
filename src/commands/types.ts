export type Platform = "mac" | "other";

/** Cross-platform logical combo. `primary` = Ctrl on win/linux, Cmd on mac. `ctrl` = physical Control on all platforms. `key` null = unbound. */
export interface KeyCombo {
  primary?: boolean;
  ctrl?: boolean;
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

const ORDER: (keyof Pick<KeyCombo, "primary" | "ctrl" | "alt" | "shift">)[] = [
  "primary",
  "ctrl",
  "alt",
  "shift",
];

export function comboToCanonical(c: KeyCombo | null): string | null {
  if (!c || c.key == null) return null;
  const parts: string[] = [];
  for (const m of ORDER) if (c[m]) parts.push(m);
  parts.push(c.key.toLowerCase());
  return parts.join("+");
}

export function canonicalToCombo(s: string | null): KeyCombo | null {
  if (s == null) return { key: null };
  const tokens = s.split("+").filter(Boolean);
  const c: KeyCombo = { key: null };
  for (const t of tokens) {
    if (t === "primary") c.primary = true;
    else if (t === "ctrl") c.ctrl = true;
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
  const token = normalizeKeyToken(e.code, e.key);
  if (!token) return null;
  const c: KeyCombo = { key: token };
  if (p === "mac") {
    if (e.metaKey) c.primary = true;
    // Physical Control is distinct from Cmd on mac (e.g. Ctrl+`).
    if (e.ctrlKey) c.ctrl = true;
  } else {
    // On win/linux, Ctrl IS primary — do not also set `ctrl` or recordings
    // become primary+ctrl+key and clash with defaults.
    if (e.ctrlKey) c.primary = true;
  }
  if (e.altKey) c.alt = true;
  if (e.shiftKey) c.shift = true;
  return c;
}

/**
 * Match a command combo against an event combo.
 * Physical-`ctrl` bindings (no `primary`) match Ctrl on every platform:
 * - mac: event must have `ctrl` and must not be Cmd (`primary`)
 * - win/linux: Ctrl is `primary`, so accept primary-only events
 */
export function combosMatch(cmd: KeyCombo | null, ev: KeyCombo | null, p: Platform): boolean {
  if (!cmd || !ev || cmd.key == null || ev.key == null) return false;
  if (cmd.key.toLowerCase() !== ev.key.toLowerCase()) return false;
  const cmdCtrlOnly = !!cmd.ctrl && !cmd.primary;
  if (cmdCtrlOnly) {
    if (p === "mac") {
      if (!ev.ctrl || ev.primary) return false;
      return !!cmd.alt === !!ev.alt && !!cmd.shift === !!ev.shift;
    }
    // win/linux: physical Ctrl arrives as primary
    if (!ev.primary) return false;
    return !!cmd.alt === !!ev.alt && !!cmd.shift === !!ev.shift;
  }
  return comboToCanonical(cmd) === comboToCanonical(ev);
}

function labelKey(token: string): string {
  if (/^key[a-z]$/.test(token)) return token.slice(3).toUpperCase();
  if (/^digit[0-9]$/.test(token)) return token.slice(5);
  if (token === "enter") return "↵";
  if (token === "escape") return "Esc";
  if (token === " ") return "Space";
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
  // Physical Ctrl when distinct from primary (mac Ctrl+` vs ⌘)
  if (c.ctrl && !(c.primary && !mac)) parts.push("Ctrl");
  if (c.alt) parts.push(mac ? "⌥" : "Alt");
  if (c.shift) parts.push(mac ? "⇧" : "Shift");
  parts.push(labelKey(c.key));
  return mac ? parts.join("") : parts.join("+");
}
