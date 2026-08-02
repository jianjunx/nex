import { useCallback, useRef, type ReactNode } from "react";
import { Copy, TextSelect } from "lucide-react";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
} from "@/components/ui/context-menu";

interface MessageContextMenuProps {
  /** The full text content of the message (for "copy all" when nothing is selected) */
  textContent: string;
  children: ReactNode;
}

/**
 * Wraps message content with a custom right-click context menu.
 * - "复制": copies the current text selection, or the full message if nothing is selected.
 * - "全选": selects all text within the message.
 */
export function MessageContextMenu({ textContent, children }: MessageContextMenuProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  const handleCopy = useCallback(() => {
    const selection = window.getSelection();
    const selectedText = selection?.toString().trim();

    if (selectedText) {
      navigator.clipboard.writeText(selectedText);
    } else {
      navigator.clipboard.writeText(textContent);
    }
  }, [textContent]);

  const handleSelectAll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;

    const range = document.createRange();
    range.selectNodeContents(el);

    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }, []);

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div ref={containerRef}>{children}</div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-48">
        <ContextMenuItem onClick={handleCopy}>
          <Copy size={14} />
          复制
          <ContextMenuShortcut>Ctrl+C</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={handleSelectAll}>
          <TextSelect size={14} />
          全选
          <ContextMenuShortcut>Ctrl+A</ContextMenuShortcut>
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
