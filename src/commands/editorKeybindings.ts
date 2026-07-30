// src/commands/editorKeybindings.ts
import type { EditorView } from "@uiw/react-codemirror";
import { searchPanelOpen } from "@codemirror/search";

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
