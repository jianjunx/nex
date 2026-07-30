// src/commands/keybindingHostState.ts
// Double-Esc-to-close-editor timing, lifted out of EditorPanel so the migrated
// editor.close command (and its unit test) can drive it.
const DOUBLE_ESC_MS = 500;
let lastEscAt = 0;

/** Call on each Esc the close command considers. Returns true iff the editor
 *  should close now (a second Esc within the window). Always updates the stamp. */
export function noteCloseEsc(): boolean {
  const now = Date.now();
  const shouldClose = now - lastEscAt < DOUBLE_ESC_MS;
  lastEscAt = shouldClose ? 0 : now;
  return shouldClose;
}

export function _resetCloseEscForTest(): void {
  lastEscAt = 0;
}
