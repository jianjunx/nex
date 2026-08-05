/** Last path segment; supports `/` and `\`. */
export function fileBasename(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const i = normalized.lastIndexOf("/");
  return i >= 0 ? normalized.slice(i + 1) : normalized;
}

/**
 * True when `path` is `ancestor`, or a file/dir under it.
 * Component-aware via trailing separator (avoids `/foo` matching `/foo-bar`).
 */
export function isSameOrDescendant(path: string, ancestor: string): boolean {
  const p = path.replace(/\\/g, "/");
  let a = ancestor.replace(/\\/g, "/");
  if (a.endsWith("/")) a = a.slice(0, -1);
  const pCmp = /^[a-zA-Z]:/.test(p) ? p.toLowerCase() : p;
  const aCmp = /^[a-zA-Z]:/.test(a) ? a.toLowerCase() : a;
  return pCmp === aCmp || pCmp.startsWith(aCmp + "/");
}

/**
 * Path relative to project root for tooltips.
 * Normalizes separators to `/` in the relative result.
 * Falls back to the original `filePath` when root is missing or file is outside root.
 */
export function relativeToProject(
  filePath: string,
  projectRoot: string | undefined | null,
): string {
  if (!projectRoot) return filePath;
  const file = filePath.replace(/\\/g, "/");
  let root = projectRoot.replace(/\\/g, "/");
  if (root.endsWith("/")) root = root.slice(0, -1);
  // Case-insensitive compare on Windows-style roots (drive letter).
  const fileCmp = /^[a-zA-Z]:/.test(file) ? file.toLowerCase() : file;
  const rootCmp = /^[a-zA-Z]:/.test(root) ? root.toLowerCase() : root;
  if (fileCmp === rootCmp) return ".";
  if (fileCmp.startsWith(rootCmp + "/")) {
    return file.slice(root.length + 1); // keep original casing from `file`
  }
  return filePath;
}
