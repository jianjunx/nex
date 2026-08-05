/**
 * Path tokens in agent output (e.g. `src/foo.ts`, `./a/b.ts:12`) can be
 * clicked to open the file in the editor panel. Relative tokens resolve
 * against the active project root; an optional `:line` suffix jumps to line.
 */

import { useFsStore } from "../../../stores/fs.store";
import { useProjectStore } from "../../../stores/project.store";

/** Strip an optional trailing `:line` suffix (e.g. `src/a.ts:12`). */
function splitLineSuffix(token: string): { path: string; line?: number } {
  const m = /^(.*?):(\d{1,6})$/.exec(token);
  if (m && m[1] && !m[1].endsWith(":")) return { path: m[1], line: Number(m[2]) };
  return { path: token };
}

/** Conservative heuristic for file-path-like tokens inside markdown. */
export function looksLikeFilePath(token: string): boolean {
  const t = token.trim();
  if (t.length < 3 || t.length > 200 || /\s/.test(t)) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return false; // URL with scheme
  if (!/^[\w.\-@~/\\]+$/.test(t)) return false;
  const { path } = splitLineSuffix(t);
  const base = path.split("/").pop() ?? path;
  const dot = base.lastIndexOf(".");
  const ext = dot > 0 ? base.slice(dot + 1) : "";
  const hasExt =
    ext.length >= 1 &&
    ext.length <= 8 &&
    /^[A-Za-z0-9]+$/.test(ext) &&
    /[A-Za-z]/.test(base);
  return path.includes("/") || hasExt;
}

function activeProjectRoot(): string | null {
  const { projects, activeProjectId } = useProjectStore.getState();
  return projects.find((p) => p.id === activeProjectId)?.path ?? null;
}

/** Resolve a token to an absolute path (+ optional line), or null. */
export function resolveTokenPath(
  token: string,
): { absPath: string; line?: number } | null {
  const { path, line } = splitLineSuffix(token.trim());
  const root = activeProjectRoot();
  if (!root) return null;
  // 绝对路径也必须位于当前项目根内，防止 Agent 输出诱导点击项目外文件。
  const joined = path.startsWith("/") ? path : `${root.replace(/\/+$/, "")}/${path}`;
  const norm = normalizeSegments(joined);
  const rootNorm = normalizeSegments(root);
  if (norm === rootNorm) return null; // 根目录本身不是文件
  if (!norm.startsWith(rootNorm + "/")) return null; // 逃出项目根（含 .. 段）
  return { absPath: norm, line };
}

/** 规范化路径段：去除重复斜杠与 .，解析 ..（纯字符串，不做文件系统 IO）。 */
function normalizeSegments(p: string): string {
  const parts = p.replace(/\\/g, "/").split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      out.pop();
    } else {
      out.push(part);
    }
  }
  return "/" + out.join("/");
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
