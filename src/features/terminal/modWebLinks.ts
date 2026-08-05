/**
 * xterm link provider: URLs are only clickable while Ctrl (Cmd on macOS) is held.
 * Avoids eating normal clicks on URL-looking text.
 */

import type { ILink, ILinkProvider, Terminal } from "@xterm/xterm";
import { openExternal } from "../../bridge/tauri";

const URL_RE =
  /https?:\/\/[^\s"'!*(){}|\\^<>`]*[^\s"':,.!?{}|\\^~[\]`()<>]/gi;

function isMacPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Mac|iPhone|iPod|iPad/.test(navigator.platform) || /Mac OS/.test(navigator.userAgent);
}

function modHeld(e: { metaKey: boolean; ctrlKey: boolean }): boolean {
  return isMacPlatform() ? e.metaKey : e.ctrlKey;
}

/**
 * Register Ctrl/Cmd-gated web links. Returns a disposer.
 * Tracks modifier via window key/mouse events so provideLinks sees current state.
 */
export function registerModWebLinks(term: Terminal): () => void {
  let held = false;

  const setHeld = (next: boolean) => {
    if (held === next) return;
    held = next;
    // Force linkifier to re-query decorations for the viewport.
    try {
      term.refresh(0, Math.max(0, term.rows - 1));
    } catch {
      /* disposed */
    }
  };

  const onKeyDown = (e: KeyboardEvent) => setHeld(modHeld(e));
  const onKeyUp = (e: KeyboardEvent) => setHeld(modHeld(e));
  const onBlur = () => setHeld(false);
  const onMouse = (e: MouseEvent) => setHeld(modHeld(e));

  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("keyup", onKeyUp, true);
  window.addEventListener("blur", onBlur);
  // Mouse move keeps state accurate when Cmd is held before entering the term.
  term.element?.addEventListener("mousemove", onMouse);

  const provider: ILinkProvider = {
    provideLinks(y, callback) {
      if (!held) {
        callback(undefined);
        return;
      }
      const line = term.buffer.active.getLine(y - 1);
      if (!line) {
        callback(undefined);
        return;
      }
      const text = line.translateToString(true);
      const links: ILink[] = [];
      URL_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = URL_RE.exec(text)) !== null) {
        const uri = m[0];
        // Trim trailing punctuation commonly glued to URLs in logs.
        const cleaned = uri.replace(/[),.;]+$/g, "");
        const startX = m.index + 1;
        const endX = m.index + cleaned.length;
        links.push({
          range: {
            start: { x: startX, y },
            end: { x: endX, y },
          },
          text: cleaned,
          activate: (_ev, text) => {
            void openExternal(text).catch(() => {
              /* ignore — allowlist / OS failures */
            });
          },
        });
      }
      callback(links.length > 0 ? links : undefined);
    },
  };

  const disposable = term.registerLinkProvider(provider);
  return () => {
    window.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("keyup", onKeyUp, true);
    window.removeEventListener("blur", onBlur);
    term.element?.removeEventListener("mousemove", onMouse);
    disposable.dispose();
  };
}
