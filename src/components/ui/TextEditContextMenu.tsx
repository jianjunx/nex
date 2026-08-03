import { useCallback, type ReactNode } from "react";
import { ClipboardPaste, Copy, Scissors, TextSelect } from "lucide-react";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
} from "@/components/ui/context-menu";
import { detectPlatform } from "@/commands/types";

interface TextEditContextMenuProps {
  children: ReactNode;
  /** Optional target for select-all / read selection; defaults to active element. */
  getTarget?: () => HTMLInputElement | HTMLTextAreaElement | null;
  /** When false, cut/paste are hidden (read-only surfaces). */
  editable?: boolean;
}

const primaryLabel = detectPlatform() === "mac" ? "⌘" : "Ctrl";

/**
 * Shared cut/copy/paste/select-all context menu for text inputs and similar.
 * Relies on the global native-menu suppress in main.tsx.
 */
export function TextEditContextMenu({
  children,
  getTarget,
  editable = true,
}: TextEditContextMenuProps) {
  const resolveTarget = useCallback((): HTMLInputElement | HTMLTextAreaElement | null => {
    if (getTarget) return getTarget();
    const el = document.activeElement;
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return el;
    return null;
  }, [getTarget]);

  const handleCopy = useCallback(() => {
    const el = resolveTarget();
    if (!el) return;
    const start = el.selectionStart ?? 0;
    const end = el.selectionEnd ?? 0;
    const selected = start !== end ? el.value.slice(start, end) : el.value;
    void navigator.clipboard.writeText(selected);
  }, [resolveTarget]);

  const handleCut = useCallback(() => {
    const el = resolveTarget();
    if (!el || el.readOnly || el.disabled) return;
    const start = el.selectionStart ?? 0;
    const end = el.selectionEnd ?? 0;
    if (start === end) return;
    const selected = el.value.slice(start, end);
    void navigator.clipboard.writeText(selected);
    const next = el.value.slice(0, start) + el.value.slice(end);
    const proto = Object.getOwnPropertyDescriptor(
      el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
      "value",
    );
    proto?.set?.call(el, next);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.setSelectionRange(start, start);
  }, [resolveTarget]);

  const handlePaste = useCallback(async () => {
    const el = resolveTarget();
    if (!el || el.readOnly || el.disabled) return;
    let text = "";
    try {
      text = await navigator.clipboard.readText();
    } catch {
      return;
    }
    const start = el.selectionStart ?? 0;
    const end = el.selectionEnd ?? 0;
    const next = el.value.slice(0, start) + text + el.value.slice(end);
    const proto = Object.getOwnPropertyDescriptor(
      el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
      "value",
    );
    proto?.set?.call(el, next);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    const caret = start + text.length;
    el.setSelectionRange(caret, caret);
  }, [resolveTarget]);

  const handleSelectAll = useCallback(() => {
    const el = resolveTarget();
    if (!el) return;
    el.focus();
    el.setSelectionRange(0, el.value.length);
  }, [resolveTarget]);

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-48" data-testid="text-edit-context-menu">
        {editable && (
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
        {editable && (
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
