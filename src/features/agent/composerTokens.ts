/**
 * Composer file-reference tokens: the document is plain text where each
 * attached file is written as `@[path]`. Chips are pure presentation
 * (CM6 replace decorations); sent text == bubble text == document text,
 * so the history bubble naturally shows `@[文件路径和名称]`.
 */
import { fileBasename, relativeToProject } from "../editor/pathUtils";

export interface FileToken {
  /** Path exactly as written inside `@[...]` (project-relative when possible). */
  path: string;
  /** Display name — basename of the path. */
  name: string;
}

/** One file reference: `@[` + path (no `]` inside) + `]`. */
export const TOKEN_RE = /@\[[^\]\n]+\]/g;

/** Extract all `@[...]` tokens in document order. */
export function parseTokens(text: string): FileToken[] {
  const out: FileToken[] = [];
  for (const m of text.matchAll(TOKEN_RE)) {
    const path = m[0].slice(2, -1);
    if (!path) continue;
    out.push({ path, name: fileBasename(path) });
  }
  return out;
}

/** Token text for a path: project-relative inside the project, absolute outside. */
export function tokenFor(path: string, projectPath: string | undefined): string {
  const rel = relativeToProject(path, projectPath);
  if (rel !== path && !rel.startsWith("..") && rel.length > 0 && rel.length < 200) {
    return `@[${rel.replace(/\\/g, "/")}]`;
  }
  return `@[${path}]`;
}

/**
 * Erase a trailing typed `@query` (the picker trigger), keeping leading
 * whitespace. `@foo bar|` (caret elsewhere / no trigger) is left untouched.
 */
export function stripAtTrigger(text: string): string {
  return text.replace(/(^|\s)@[^\s@[]*$/, "$1");
}

/** Whether the text already carries a token for this exact path. */
export function hasToken(
  text: string,
  path: string,
  projectPath: string | undefined,
): boolean {
  return text.includes(tokenFor(path, projectPath));
}

/** Append `@[path] ` at the end unless the path is already referenced. */
export function appendToken(
  text: string,
  path: string,
  projectPath: string | undefined,
): string {
  if (hasToken(text, path, projectPath)) return text;
  const sep = text.length > 0 && !/\s$/.test(text) ? " " : "";
  return `${text}${sep}${tokenFor(path, projectPath)} `;
}

/**
 * Resolve a token path back to an absolute path for backend reads:
 * tokens store project-relative paths when possible.
 */
export function resolveTokenPath(
  path: string,
  projectPath: string | undefined,
): string {
  // Already absolute: unix root, UNC, or Windows drive.
  if (/^([a-zA-Z]:[\\/]|\/|\\\\)/.test(path)) return path;
  if (!projectPath) return path;
  const sep = projectPath.includes("\\") ? "\\" : "/";
  return projectPath.replace(/[\\/]+$/, "") + sep + path.replace(/\//g, sep);
}
