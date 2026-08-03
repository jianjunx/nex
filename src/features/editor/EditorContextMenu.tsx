import { useCallback, type ReactNode, type RefObject } from "react";
import { ClipboardPaste, Copy, Scissors, TextSelect } from "lucide-react";
import type { EditorView } from "@codemirror/view";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
} from "@/components/ui/context-menu";
import { detectPlatform } from "@/commands/types";

interface EditorContextMenuProps {
  children: ReactNode;
  viewRef: RefObject<EditorView | null>;
  /** Diff / read-only editors hide cut & paste. */
  readOnly?: boolean;
}

const primaryLabel = detectPlatform() === "mac" ? "⌘" : "Ctrl";

export function EditorContextMenu({ children, viewRef, readOnly = false }: EditorContextMenuProps) {
  const handleCopy = useCallback(() => {
    const view = viewRef.current;
    if (!view) return;
    const { from, to } = view.state.selection.main;
    const text = from === to ? view.state.doc.toString() : view.state.sliceDoc(from, to);
    void navigator.clipboard.writeText(text);
  }, [viewRef]);

  const handleCut = useCallback(() => {
    const view = viewRef.current;
    if (!view || readOnly) return;
    const { from, to } = view.state.selection.main;
    if (from === to) return;
    const text = view.state.sliceDoc(from, to);
    void navigator.clipboard.writeText(text);
    view.dispatch({ changes: { from, to, insert: "" } });
  }, [viewRef, readOnly]);

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
  }, [viewRef, readOnly]);

  const handleSelectAll = useCallback(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } });
    view.focus();
  }, [viewRef]);

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div className="h-full min-h-0">{children}</div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-48" data-testid="editor-context-menu">
        {!readOnly && (
          <ContextMenuItem onClick={() => void handleCut()}>
            <Scissors size={14} />
            剪切
            <ContextMenuShortcut>{primaryLabel}+X</ContextMenuShortcut>
          </ContextMenuItem>
        )}
        <ContextMenuItem onClick={() => void handleCopy()}>
          <Copy size={14} />
          复制
          <ContextMenuShortcut>{primaryLabel}+C</ContextMenuShortcut>
        </ContextMenuItem>
        {!readOnly && (
          <ContextMenuItem onClick={() => void handlePaste()}>
            <ClipboardPaste size={14} />
            粘贴
            <ContextMenuShortcut>{primaryLabel}+V</ContextMenuShortcut>
          </ContextMenuItem>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem onClick={handleSelectAll}>
          <TextSelect size={14} />
          全选
          <ContextMenuShortcut>{primaryLabel}+A</ContextMenuShortcut>
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
