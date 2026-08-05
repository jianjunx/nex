/**
 * Path tokens in agent output (e.g. `src/foo.ts`, `./a/b.ts:12`,
 * `D:\proj\src\a.ts`) can be clicked to open the file in the editor panel.
 * Relative tokens resolve against the active project root; an optional
 * `:line` suffix jumps to line.
 */

import { useFsStore } from "../../../stores/fs.store";
import { useProjectStore } from "../../../stores/project.store";

/** Strip an optional trailing `:line` suffix (e.g. `src/a.ts:12`). */
function splitLineSuffix(token: string): { path: string; line?: number } {
  // Don't treat Windows drive `D:` as a line suffix.
  const m = /^(.*?):(\d{1,6})$/.exec(token);
  if (m && m[1] && !/^[a-zA-Z]:$/.test(m[1]) && !m[1].endsWith(":")) {
    return { path: m[1], line: Number(m[2]) };
  }
  return { path: token };
}

/** Conservative heuristic for file-path-like tokens inside markdown. */
export function looksLikeFilePath(token: string): boolean {
  const t = token.trim();
  if (t.length < 3 || t.length > 260 || /\s/.test(t)) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return false; // URL with scheme
  // Allow drive letters (`D:`) and both separators.
  if (!/^[A-Za-z0-9._\-@~/\\:]+$/.test(t)) return false;
  const { path } = splitLineSuffix(t);
  const norm = path.replace(/\\/g, "/");
  const base = norm.split("/").pop() ?? norm;
  const dot = base.lastIndexOf(".");
  const ext = dot > 0 ? base.slice(dot + 1) : "";
  const hasExt =
    ext.length >= 1 &&
    ext.length <= 8 &&
    /^[A-Za-z0-9]+$/.test(ext) &&
    /[A-Za-z]/.test(base);
  return norm.includes("/") || /^[a-zA-Z]:\//.test(norm) || hasExt;
}

function activeProjectRoot(): string | null {
  const { projects, activeProjectId } = useProjectStore.getState();
  return projects.find((p) => p.id === activeProjectId)?.path ?? null;
}

function isWindowsAbs(p: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(p);
}

/**
 * Normalize `.` / `..` and separators to `/`, keeping a Windows drive prefix
 * (`D:/...`) or a Unix leading slash (`/Users/...`).
 */
export function normalizePathForCompare(p: string): string {
  const raw = p.replace(/\\/g, "/");
  const isAbsUnix = raw.startsWith("/");
  const parts = raw.split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      out.pop();
    } else {
      out.push(part);
    }
  }
  if (isAbsUnix) return "/" + out.join("/");
  return out.join("/");
}

function samePathPrefix(path: string, root: string): boolean {
  const p = /^[a-zA-Z]:/.test(path) ? path.toLowerCase() : path;
  const r = /^[a-zA-Z]:/.test(root) ? root.toLowerCase() : root;
  return p === r || p.startsWith(r + "/");
}

/** Resolve a token to an absolute path (+ optional line), or null. */
export function resolveTokenPath(
  token: string,
): { absPath: string; line?: number } | null {
  const { path, line } = splitLineSuffix(token.trim());
  const root = activeProjectRoot();
  if (!root) return null;

  const rootNorm = normalizePathForCompare(root.replace(/\/+$/, "").replace(/\\+$/, ""));
  let candidate: string;
  if (isWindowsAbs(path) || path.startsWith("/")) {
    candidate = path;
  } else {
    candidate = `${rootNorm}/${path.replace(/\\/g, "/")}`;
  }
  const norm = normalizePathForCompare(candidate);
  if (samePathPrefix(norm, rootNorm) === false) return null;
  if (norm.toLowerCase() === rootNorm.toLowerCase() || norm === rootNorm) return null;

  // Prefer the project root's native separator so fs APIs match open tabs.
  const absPath = root.includes("\\") ? norm.replace(/\//g, "\\") : norm;
  return { absPath, line };
}

/** Pull a file path out of common tool rawInput shapes. */
export function pathFromToolRawInput(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  for (const key of ["path", "file_path", "filePath", "target_file", "targetFile", "file"]) {
    const v = o[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

/** Open the token's file in the editor panel. Resolves false when it fails. */
export async function openPathToken(token: string): Promise<boolean> {
  const resolved = resolveTokenPath(token);
  if (!resolved) return false;
  try {
    await useFsStore
      .getState()
      .openFile(
        resolved.absPath,
        resolved.line != null ? { pin: true, line: resolved.line } : { pin: true },
      );
    return true;
  } catch {
    return false;
  }
}
