import { createRoot, type Root } from "react-dom/client";
import { EditorView, type Panel, type ViewUpdate } from "@codemirror/view";
import { search, setSearchQuery } from "@codemirror/search";
import type { Extension } from "@codemirror/state";
import { EditorFindBar, SEARCH_SYNC_EVENT } from "./EditorFindBar";

function createEditorSearchPanel(view: EditorView): Panel {
  const dom = document.createElement("div");
  dom.className = "nex-editor-search-panel";
  const root: Root = createRoot(dom);
  root.render(<EditorFindBar view={view} />);
  return {
    dom,
    top: true,
    destroy() {
      root.unmount();
    },
  };
}

/** Search extension with a glass-styled top find bar (Ctrl/Cmd+F via basicSetup keymap). */
export function editorSearchExtensions(): Extension[] {
  return [
    search({ top: true, createPanel: createEditorSearchPanel }),
    EditorView.updateListener.of((update: ViewUpdate) => {
      if (
        update.docChanged ||
        update.selectionSet ||
        update.transactions.some((tr) => tr.effects.some((e) => e.is(setSearchQuery)))
      ) {
        update.view.dom.dispatchEvent(new Event(SEARCH_SYNC_EVENT));
      }
    }),
  ];
}
