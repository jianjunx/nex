// Composer input built on CodeMirror 6. The document is plain text where each
// referenced file is written as `@[path]`; chips are pure presentation
// (replace decorations), so sent text == bubble text == document text.
// Chosen over a <textarea> because inline tags must flow with the caret.
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
} from "react";
import { ClipboardPaste, Copy, Scissors, TextSelect } from "lucide-react";
import {
  PositionedDropdown,
  PositionedMenuItem,
  PositionedMenuSeparator,
  PositionedMenuShortcut,
  usePositionedContextMenu,
} from "@/components/ui/TextEditContextMenu";
import { detectPlatform } from "@/commands/types";
import { Compartment, EditorState, RangeSetBuilder } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  keymap,
  placeholder,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { fileBasename } from "../editor/pathUtils";
import { fileIconUrl } from "../files/FileIcon";
import { findTokenDeletionRange, findTokenRanges } from "./composerTokens";

export interface ComposerEditorHandle {
  focus: () => void;
  getText: () => string;
  setText: (text: string) => void;
  insertAtCursor: (text: string) => void;
  /** Replace a trailing typed `@query` (or append) with a file token. */
  replaceAtTrigger: (tokenText: string) => void;
  coordsAtCursor: () => { top: number; left: number; lineHeight: number } | null;
  selectEnd: () => void;
}

interface ComposerEditorProps {
  initialText: string;
  placeholder: string;
  disabled: boolean;
  /** Called on every doc change with the full text. */
  onChange: (text: string) => void;
  /**
   * Raw keydown, runs before CM6 keymaps. Return true when handled
   * (prevents default + stops CM6); false to let the editor handle it.
   */
  onKeyDown: (e: globalThis.KeyboardEvent) => boolean;
  /** Paste — used to extract images. Call e.preventDefault() when consumed. */
  onPaste: (e: globalThis.ClipboardEvent) => void;
  onCompositionStart?: () => void;
  onCompositionEnd?: () => void;
  /** Selection moved without a doc change (caret repositioning). */
  onSelectionChange?: () => void;
}

/** Inline chip for one `@[path]` token: icon + basename + remove button. */
class TokenWidget extends WidgetType {
  readonly path: string;
  readonly from: number;
  readonly to: number;
  readonly view: EditorView;
  constructor(path: string, from: number, to: number, view: EditorView) {
    super();
    this.path = path;
    this.from = from;
    this.to = to;
    this.view = view;
  }
  eq(other: TokenWidget): boolean {
    return other.path === this.path && other.from === this.from && other.to === this.to;
  }
  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "composer-token";
    span.setAttribute("data-token-path", this.path);
    span.title = this.path;

    const img = document.createElement("img");
    img.src = fileIconUrl(fileBasename(this.path));
    img.alt = "";
    img.draggable = false;
    img.className = "composer-token-icon";

    const name = document.createElement("span");
    name.className = "composer-token-name";
    name.textContent = fileBasename(this.path);

    const x = document.createElement("span");
    x.className = "composer-token-x";
    x.setAttribute("role", "button");
    x.setAttribute("aria-label", "移除文件引用");
    x.textContent = "×";
    // Keep editor focus; delete the whole token range on click.
    x.addEventListener("mousedown", (e) => e.preventDefault());
    x.addEventListener("click", (e) => {
      e.stopPropagation();
      const { from, to } = this;
      this.view.dispatch({ changes: { from, to } });
      this.view.focus();
    });

    span.append(img, name, x);
    return span;
  }
  ignoreEvent(): boolean {
    return false;
  }
}

/** Build replace decorations for every `@[...]` token in the doc. */
function buildTokenDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const text = view.state.doc.toString();
  for (const { from, to, path } of findTokenRanges(text)) {
    builder.add(
      from,
      to,
      Decoration.replace({ widget: new TokenWidget(path, from, to, view) }),
    );
  }
  return builder.finish();
}

const tokenPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildTokenDecorations(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged) this.decorations = buildTokenDecorations(u.view);
    }
  },
  { decorations: (v) => v.decorations },
);

const primaryLabel = detectPlatform() === "mac" ? "⌘" : "Ctrl";

const composerTheme = EditorView.theme({
  "&": {
    backgroundColor: "transparent",
    fontSize: "14px",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-content": {
    padding: "4px",
    minHeight: "28px",
    caretColor: "var(--text-primary)",
    fontFamily: "inherit",
    lineHeight: "21px",
  },
  // Soft-wrap pasted prose and long unbroken strings; the editor keeps its
  // existing vertical height cap, but never exposes a horizontal scrollbar.
  ".cm-scroller": { overflowX: "hidden", overflowY: "auto" },
  ".cm-line": { padding: "0" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--text-primary)" },
  "&.cm-editor .cm-placeholder": { color: "var(--text-tertiary)" },
});

export const ComposerEditor = forwardRef<ComposerEditorHandle, ComposerEditorProps>(
  function ComposerEditor(props, ref) {
    const hostRef = useRef<HTMLDivElement>(null);
    const viewRef = useRef<EditorView | null>(null);
    const propsRef = useRef(props);
    propsRef.current = props;

    const placeholderComp = useRef(new Compartment());
    const editableComp = useRef(new Compartment());
    const menu = usePositionedContextMenu();

    useEffect(() => {
      const host = hostRef.current;
      if (!host) return;

      const onChangeExt = EditorView.updateListener.of((u) => {
        if (u.docChanged) propsRef.current.onChange(u.state.doc.toString());
        else if (u.selectionSet) propsRef.current.onSelectionChange?.();
      });

      const domEvents = EditorView.domEventHandlers({
        keydown: (e) => propsRef.current.onKeyDown(e),
        paste: (e) => {
          propsRef.current.onPaste(e);
          return e.defaultPrevented;
        },
        compositionstart: () => {
          propsRef.current.onCompositionStart?.();
          return false;
        },
        compositionend: () => {
          propsRef.current.onCompositionEnd?.();
          return false;
        },
      });

      const baseKeymap = keymap.of([
        {
          key: "Backspace",
          run: (v) => {
            const sel = v.state.selection.main;
            if (!sel.empty) return false;
            const range = findTokenDeletionRange(
              v.state.doc.toString(),
              sel.head,
              "backward",
            );
            if (!range) return false;
            v.dispatch({ changes: range, selection: { anchor: range.from } });
            return true;
          },
        },
        {
          key: "Delete",
          run: (v) => {
            const sel = v.state.selection.main;
            if (!sel.empty) return false;
            const range = findTokenDeletionRange(
              v.state.doc.toString(),
              sel.head,
              "forward",
            );
            if (!range) return false;
            v.dispatch({ changes: range, selection: { anchor: range.from } });
            return true;
          },
        },
        // Shift+Enter always inserts a newline (Enter-to-send is handled by
        // the keydown handler above; this is the explicit "not send" path).
        {
          key: "Shift-Enter",
          run: (v) => {
            v.dispatch(v.state.replaceSelection("\n"));
            return true;
          },
        },
        ...historyKeymap,
        ...defaultKeymap,
      ]);

      const view = new EditorView({
        state: EditorState.create({
          doc: propsRef.current.initialText,
          extensions: [
            history(),
            editableComp.current.of(EditorView.editable.of(!propsRef.current.disabled)),
            placeholderComp.current.of(placeholder(propsRef.current.placeholder)),
            EditorView.contentAttributes.of({ "data-composer-input": "" }),
            composerTheme,
            EditorView.lineWrapping,
            tokenPlugin,
            domEvents,
            onChangeExt,
            baseKeymap,
          ],
        }),
        parent: host,
      });
      viewRef.current = view;
      return () => {
        view.destroy();
        viewRef.current = null;
      };
      // Create the editor exactly once; prop changes flow through propsRef.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Keep dynamic placeholder / disabled in sync without re-creating the view.
    useEffect(() => {
      const view = viewRef.current;
      if (!view) return;
      view.dispatch({
        effects: placeholderComp.current.reconfigure(placeholder(props.placeholder)),
      });
    }, [props.placeholder]);

    useEffect(() => {
      const view = viewRef.current;
      if (!view) return;
      view.dispatch({
        effects: editableComp.current.reconfigure(EditorView.editable.of(!props.disabled)),
      });
    }, [props.disabled]);

    useImperativeHandle(
      ref,
      (): ComposerEditorHandle => ({
        focus: () => viewRef.current?.focus(),
        getText: () => viewRef.current?.state.doc.toString() ?? "",
        setText: (text) => {
          const view = viewRef.current;
          if (!view) return;
          view.dispatch({
            changes: { from: 0, to: view.state.doc.length, insert: text },
            selection: { anchor: text.length },
          });
        },
        insertAtCursor: (text) => {
          const view = viewRef.current;
          if (!view) return;
          view.dispatch(view.state.replaceSelection(text));
          view.focus();
        },
        replaceAtTrigger: (tokenText) => {
          const view = viewRef.current;
          if (!view) return;
          const text = view.state.doc.toString();
          const m = text.match(/(?:^|\s)@[^\s@]*$/);
          if (m) {
            const lead = /^\s/.test(m[0]) ? m[0][0] : "";
            const start = text.length - m[0].length;
            view.dispatch({
              changes: { from: start, to: text.length, insert: lead + tokenText },
              selection: { anchor: start + lead.length + tokenText.length },
            });
          } else {
            const needsSpace = text.length > 0 && !/\s$/.test(text);
            const insert = (needsSpace ? " " : "") + tokenText;
            view.dispatch({
              changes: { from: text.length, insert },
              selection: { anchor: text.length + insert.length },
            });
          }
          view.focus();
        },
        coordsAtCursor: () => {
          const view = viewRef.current;
          if (!view) return null;
          const head = view.state.selection.main.head;
          const coords = view.coordsAtPos(head);
          if (!coords) return null;
          return { top: coords.top, left: coords.left, lineHeight: coords.bottom - coords.top };
        },
        selectEnd: () => {
          const view = viewRef.current;
          if (!view) return;
          const end = view.state.doc.length;
          view.dispatch({ selection: { anchor: end } });
        },
      }),
      [],
    );

    // --- Context menu (global handler suppresses the native one) ---
    const copySelection = () => {
      const v = viewRef.current;
      if (!v) return;
      const { from, to } = v.state.selection.main;
      const text = from === to ? v.state.doc.toString() : v.state.sliceDoc(from, to);
      void navigator.clipboard.writeText(text);
      menu.setOpen(false);
    };
    const cutSelection = () => {
      const v = viewRef.current;
      if (!v || propsRef.current.disabled) return;
      const { from, to } = v.state.selection.main;
      if (from === to) return;
      void navigator.clipboard.writeText(v.state.sliceDoc(from, to));
      v.dispatch({ changes: { from, to }, selection: { anchor: from } });
      menu.setOpen(false);
    };
    const pasteText = async () => {
      const v = viewRef.current;
      if (!v || propsRef.current.disabled) return;
      let text = "";
      try {
        text = await navigator.clipboard.readText();
      } catch {
        return;
      }
      if (text) {
        v.dispatch(v.state.replaceSelection(text));
        v.focus();
      }
      menu.setOpen(false);
    };
    const selectAll = () => {
      const v = viewRef.current;
      if (!v) return;
      v.focus();
      v.dispatch({ selection: { anchor: 0, head: v.state.doc.length } });
      menu.setOpen(false);
    };

    return (
      <>
        <div
          ref={hostRef}
          onContextMenu={menu.onContextMenu}
          className="composer-editor-host min-w-0"
        />
        <PositionedDropdown
          open={menu.open}
          setOpen={menu.setOpen}
          pos={menu.pos}
          alignY="center"
          testId="composer-edit-menu"
        >
          {!props.disabled && (
            <PositionedMenuItem onClick={cutSelection}>
              <Scissors size={14} />
              剪切
              <PositionedMenuShortcut>{primaryLabel}+X</PositionedMenuShortcut>
            </PositionedMenuItem>
          )}
          <PositionedMenuItem onClick={copySelection}>
            <Copy size={14} />
            复制
            <PositionedMenuShortcut>{primaryLabel}+C</PositionedMenuShortcut>
          </PositionedMenuItem>
          {!props.disabled && (
            <PositionedMenuItem onClick={() => void pasteText()}>
              <ClipboardPaste size={14} />
              粘贴
              <PositionedMenuShortcut>{primaryLabel}+V</PositionedMenuShortcut>
            </PositionedMenuItem>
          )}
          <PositionedMenuSeparator />
          <PositionedMenuItem onClick={selectAll}>
            <TextSelect size={14} />
            全选
            <PositionedMenuShortcut>{primaryLabel}+A</PositionedMenuShortcut>
          </PositionedMenuItem>
        </PositionedDropdown>
      </>
    );
  },
);
