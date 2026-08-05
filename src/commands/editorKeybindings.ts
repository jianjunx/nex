import type { EditorView } from "@uiw/react-codemirror";
import { closeSearchPanel, searchPanelOpen } from "@codemirror/search";

// Module-level accessor so command when/run can query the live editor find-bar
// without the static registry holding a React ref. EditorPanel registers on
// mount and clears on unmount.
let getView: (() => EditorView | null) | null = null;

export function registerFindBarAccessor(fn: (() => EditorView | null) | null): void {
  getView = fn;
}

export function viewForFindBar(): EditorView | null {
  return getView ? getView() : null;
}

export function isFindBarOpen(): boolean {
  const v = viewForFindBar();
  return !!v && searchPanelOpen(v.state);
}

/** Imperatively close the find bar (Esc pressed in its HTML input does not
 *  reach CodeMirror's own keymap). Returns false when no bar is open. */
export function closeFindBar(): boolean {
  const v = viewForFindBar();
  if (!v || !searchPanelOpen(v.state)) return false;
  closeSearchPanel(v);
  v.focus();
  return true;
}
