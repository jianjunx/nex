/** Pure hit-testing helpers shared by OS drag-drop routing and pointer drags. */

export interface Point {
  x: number;
  y: number;
}

export function pointInRect(p: Point, r: DOMRect): boolean {
  return p.x >= r.left && p.x <= r.right && p.y >= r.top && p.y <= r.bottom;
}

/** Parent directory of a path; handles both `/` and `\` separators. */
export function parentDirOf(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i > 0 ? path.slice(0, i) : path;
}

/**
 * Resolve the directory an OS/internal drop over the file tree targets:
 *   1. point outside the tree container → null (not the tree's business)
 *   2. over a `[data-dir-path]` row (directory or root) → that directory
 *   3. over a `[data-file-path]` row → its parent directory
 *   4. empty area → fallbackRoot (project root)
 */
export function resolveDirDropTarget(
  p: Point,
  container: HTMLElement | null,
  fallbackRoot: string,
): string | null {
  if (!container || !pointInRect(p, container.getBoundingClientRect())) return null;
  const el = document.elementFromPoint(p.x, p.y);
  const dirRow = el?.closest?.("[data-dir-path]") as HTMLElement | null;
  if (dirRow?.dataset.dirPath) return dirRow.dataset.dirPath;
  const fileRow = el?.closest?.("[data-file-path]") as HTMLElement | null;
  if (fileRow?.dataset.filePath) return parentDirOf(fileRow.dataset.filePath);
  return fallbackRoot;
}

/** Whether the point lands inside the composer drop zone (`[data-composer-dropzone]`). */
export function isOverComposer(p: Point): boolean {
  const zone = document.querySelector("[data-composer-dropzone]");
  return !!zone && pointInRect(p, zone.getBoundingClientRect());
}
