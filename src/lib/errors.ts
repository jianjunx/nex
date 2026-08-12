function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}

function fromKnownFields(value: Record<string, unknown>, seen: Set<unknown>): string | null {
  const directKeys = ["message", "msg", "error", "details", "detail", "cause", "data"];
  for (const key of directKeys) {
    const next = value[key];
    const msg = errorMessage(next, seen);
    if (msg) return msg;
  }
  return null;
}

/**
 * Turn unknown bridge/store/UI errors into readable text.
 *
 * Handles nested Tauri-style payloads such as:
 * - { message: string }
 * - { error: { message: string } }
 * - { data: { details: string } }
 * and falls back to JSON before finally returning String(...).
 */
export function errorMessage(err: unknown, seen: Set<unknown> = new Set()): string {
  if (err == null) return "未知错误";
  if (typeof err === "string") return err;
  if (typeof err === "number" || typeof err === "boolean" || typeof err === "bigint") return String(err);
  if (err instanceof Error) {
    return err.message || err.name || "未知错误";
  }
  if (seen.has(err)) return "未知错误";
  if (Array.isArray(err)) {
    seen.add(err);
    const parts = err.map((item) => errorMessage(item, seen)).filter(Boolean);
    return parts.join("; ") || "未知错误";
  }
  if (isRecord(err)) {
    seen.add(err);
    const known = fromKnownFields(err, seen);
    if (known) return known;
    try {
      return JSON.stringify(err);
    } catch {
      return String(err);
    }
  }
  return String(err);
}
