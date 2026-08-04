import { useCallback, type ReactNode, type RefObject } from "react";
import { ClipboardPaste, Copy, Scissors, TextSelect } from "lucide-react";
import type { EditorView } from "@codemirror/view";
import {
  PositionedDropdown,
  PositionedMenuItem,
  PositionedMenuSeparator,
  PositionedMenuShortcut,
  usePositionedContextMenu,
} from "@/components/ui/TextEditContextMenu";
import { detectPlatform } from "@/commands/types";

interface EditorContextMenuProps {
  children: ReactNode;
  viewRef: RefObject<EditorView | null>;
  /** Diff / read-only editors hide cut & paste. */
  readOnly?: boolean;
}

const primaryLabel = detectPlatform() === "mac" ? "⌘" : "Ctrl";

export function EditorContextMenu({ children, viewRef, readOnly = false }: EditorContextMenuProps) {
  const { open, setOpen, pos, onContextMenu } = usePositionedContextMenu();

  const handleCopy = useCallback(() => {
    const view = viewRef.current;
    if (!view) return;
    const { from, to } = view.state.selection.main;
    const text = from === to ? view.state.doc.toString() : view.state.sliceDoc(from, to);
    void navigator.clipboard.writeText(text);
    setOpen(false);
  }, [viewRef, setOpen]);

  const handleCut = useCallback(() => {
    const view = viewRef.current;
    if (!view || readOnly) return;
    const { from, to } = view.state.selection.main;
    if (from === to) return;
    const text = view.state.sliceDoc(from, to);
    void navigator.clipboard.writeText(text);
    view.dispatch({ changes: { from, to, insert: "" } });
    setOpen(false);
  }, [viewRef, readOnly, setOpen]);

  const handlePaste = useCallback(async () => {
    const view = viewRef.current;
    if (!view || readOnly) return;
    let text = "";
    try {
      text = await navigator.clipboard.readText();
    } catch {
      return;
    }
    const { from, to } = view.state.selection.main;
    view.dispatch({
      changes: { from, to, insert: text },
      selection: { anchor: from + text.length },
    });
    setOpen(false);
  }, [viewRef, readOnly, setOpen]);

  const handleSelectAll = useCallback(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } });
    view.focus();
    setOpen(false);
  }, [viewRef, setOpen]);

  return (
    <>
      <div className="h-full min-h-0" onContextMenu={onContextMenu}>
        {children}
      </div>
      <PositionedDropdown open={open} setOpen={setOpen} pos={pos} testId="editor-context-menu">
        {!readOnly && (
          <PositionedMenuItem onClick={() => void handleCut()}>
            <Scissors size={14} />
            剪切
            <PositionedMenuShortcut>{primaryLabel}+X</PositionedMenuShortcut>
          </PositionedMenuItem>
        )}
        <PositionedMenuItem onClick={() => void handleCopy()}>
          <Copy size={14} />
          复制
          <PositionedMenuShortcut>{primaryLabel}+C</PositionedMenuShortcut>
        </PositionedMenuItem>
        {!readOnly && (
          <PositionedMenuItem onClick={() => void handlePaste()}>
            <ClipboardPaste size={14} />
            粘贴
            <PositionedMenuShortcut>{primaryLabel}+V</PositionedMenuShortcut>
          </PositionedMenuItem>
        )}
        <PositionedMenuSeparator />
        <PositionedMenuItem onClick={handleSelectAll}>
          <TextSelect size={14} />
          全选
          <PositionedMenuShortcut>{primaryLabel}+A</PositionedMenuShortcut>
        </PositionedMenuItem>
      </PositionedDropdown>
    </>
  );
}
