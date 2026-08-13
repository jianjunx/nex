/**
 * Bridge between drag sources (file tree) and the composer's local attachment
 * state. The composer registers its attach callback on mount; drag handlers
 * call `attachToComposer` without needing a reference to the component.
 */
type AttachFn = (paths: string[]) => void;

let attachFn: AttachFn | null = null;

export function registerComposerAttach(fn: AttachFn | null): void {
  attachFn = fn;
}

/** Attach files to the composer as mentions. No-op when no composer is mounted. */
export function attachToComposer(paths: string[]): void {
  if (paths.length > 0) attachFn?.(paths);
}
