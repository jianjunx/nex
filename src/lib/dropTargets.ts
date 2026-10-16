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
  const row = el?.closest?.("[data-dir-path], [data-file-path]") as HTMLElement | null;
  if (row && container.contains(row)) {
    if (row.dataset.dirPath) return row.dataset.dirPath;
    if (row.dataset.filePath) return parentDirOf(row.dataset.filePath);
  }
  // Native OS drags can leave WebView hit testing without a DOM target.
  // Row bounds remain reliable, including on scaled displays.
  for (const row of container.querySelectorAll<HTMLElement>("[data-dir-path], [data-file-path]")) {
    if (row.closest('.nex-collapse[data-open="false"]')) continue;
    const bounds = row.getBoundingClientRect();
    if (bounds.height > 0 && pointInRect(p, bounds)) {
      return row.dataset.dirPath ?? parentDirOf(row.dataset.filePath!);
    }
  }
  return fallbackRoot;
}

/** Whether the point lands inside the composer drop zone (`[data-composer-dropzone]`). */
export function isOverComposer(p: Point): boolean {
  const zone = document.querySelector("[data-composer-dropzone]");
  return !!zone && pointInRect(p, zone.getBoundingClientRect());
}
