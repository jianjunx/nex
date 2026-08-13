import { useCallback, useRef, type ReactNode } from "react";
import { Copy, TextSelect } from "lucide-react";
import {
  PositionedDropdown,
  PositionedMenuItem,
  PositionedMenuSeparator,
  PositionedMenuShortcut,
  usePositionedContextMenu,
} from "@/components/ui/TextEditContextMenu";
import { detectPlatform } from "@/commands/types";

interface MessageContextMenuProps {
  /** The full text content of the message (for "copy all" when nothing is selected) */
  textContent: string;
  children: ReactNode;
}

const primaryLabel = detectPlatform() === "mac" ? "⌘" : "Ctrl";

/**
 * Wraps message content with a custom right-click context menu.
 * - "复制": copies the current text selection, or the full message if nothing is selected.
 * - "全选": selects all text within the message.
 */
export function MessageContextMenu({ textContent, children }: MessageContextMenuProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { open, setOpen, pos, onContextMenu } = usePositionedContextMenu();

  const handleCopy = useCallback(() => {
    const selection = window.getSelection();
    const selectedText = selection?.toString().trim();

    if (selectedText) {
      void navigator.clipboard.writeText(selectedText);
    } else {
      void navigator.clipboard.writeText(textContent);
    }
    setOpen(false);
  }, [textContent, setOpen]);

  const handleSelectAll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;

    const range = document.createRange();
    range.selectNodeContents(el);

    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    setOpen(false);
  }, [setOpen]);

  return (
    <>
      <div ref={containerRef} onContextMenu={onContextMenu} className="min-w-0 max-w-full">
        {children}
      </div>
      <PositionedDropdown open={open} setOpen={setOpen} pos={pos}>
        <PositionedMenuItem onClick={handleCopy}>
          <Copy size={14} />
          复制
          <PositionedMenuShortcut>{primaryLabel}+C</PositionedMenuShortcut>
        </PositionedMenuItem>
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
