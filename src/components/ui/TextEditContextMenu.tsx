import {
  useCallback,
  useState,
  type ReactNode,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { ClipboardPaste, Copy, Scissors, TextSelect } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
} from "@/components/ui/dropdown-menu";
import { detectPlatform } from "@/commands/types";
import { cn } from "@/lib/utils";

export interface PositionedMenuState {
  open: boolean;
  setOpen: (open: boolean) => void;
  pos: { x: number; y: number };
}

/**
 * Shared hook: capture right-click → open a positioned menu.
 * Works with the global capture-phase contextmenu.preventDefault in main.tsx.
 * Same pattern as FileTree (controlled DropdownMenu, not Radix ContextMenu).
 */
export function usePositionedContextMenu() {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const onContextMenu = useCallback((e: ReactMouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setPos({ x: e.clientX, y: e.clientY });
    setOpen(true);
  }, []);
  return { open, setOpen, pos, onContextMenu };
}

/**
 * Body-portaled menu at fixed coords — mirrors TreeContextMenu.
 * `modal={false}` is required: Radix modal mode aria-hides the rest of the
 * app; without a real Trigger that can leave the whole UI looking blank.
 *
 * `alignY="center"` vertically centers on the click; X stays at click (menu
 * opens to the right), matching Composer preference.
 */
export function PositionedDropdown({
  open,
  setOpen,
  pos,
  children,
  className = "w-48",
  testId,
  alignY = "start",
}: PositionedMenuState & {
  children: ReactNode;
  className?: string;
  testId?: string;
  alignY?: "start" | "center";
}) {
  if (!open) return null;

  // Estimate before paint — avoid measure→setState loops that blanked the UI.
  const menuW = 192;
  const menuH = 132;
  const pad = 8;
  let left = pos.x;
  let top = alignY === "center" ? pos.y - menuH / 2 : pos.y;
  left = Math.min(Math.max(pad, left), Math.max(pad, window.innerWidth - menuW - pad));
  top = Math.min(Math.max(pad, top), Math.max(pad, window.innerHeight - menuH - pad));

  return (
    <DropdownMenu
      open={open}
      onOpenChange={(next) => {
        if (!next) setOpen(false);
      }}
      modal={false}
    >
      <DropdownMenuContent
        data-testid={testId}
        className={cn("p-0.5", className)}
        style={{ position: "fixed", left, top }}
        onCloseAutoFocus={(e) => e.preventDefault()}
      >
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function PositionedMenuItem({
  children,
  onClick,
  disabled,
  destructive,
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  destructive?: boolean;
}) {
  return (
    <DropdownMenuItem
      disabled={disabled}
      variant={destructive ? "destructive" : "default"}
      className="gap-1.5 px-2 py-1 text-[13px] leading-none [&_svg:not([class*='size-'])]:size-3.5"
      onClick={onClick}
    >
      {children}
    </DropdownMenuItem>
  );
}

export function PositionedMenuSeparator() {
  return <DropdownMenuSeparator className="my-0.5" />;
}

export function PositionedMenuShortcut({ children }: { children: ReactNode }) {
  return <DropdownMenuShortcut>{children}</DropdownMenuShortcut>;
}

interface TextEditContextMenuProps {
  children: ReactNode;
  /** Optional target for select-all / read selection; defaults to active element. */
  getTarget?: () => HTMLInputElement | HTMLTextAreaElement | null;
  /** When false, cut/paste are hidden (read-only surfaces). */
  editable?: boolean;
}

const primaryLabel = detectPlatform() === "mac" ? "⌘" : "Ctrl";

/**
 * Cut/copy/paste/select-all menu for text inputs.
 * Host is a plain block wrapper (not flex-1) so Composer height stays on the
 * textarea; avoids `display:contents` WebKit event quirks.
 */
export function TextEditContextMenu({
  children,
  getTarget,
  editable = true,
}: TextEditContextMenuProps) {
  const { open, setOpen, pos, onContextMenu } = usePositionedContextMenu();

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
    setOpen(false);
  }, [resolveTarget, setOpen]);

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
    setOpen(false);
  }, [resolveTarget, setOpen]);

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
    setOpen(false);
  }, [resolveTarget, setOpen]);

  const handleSelectAll = useCallback(() => {
    const el = resolveTarget();
    if (!el) return;
    el.focus();
    el.setSelectionRange(0, el.value.length);
    setOpen(false);
  }, [resolveTarget, setOpen]);

  return (
    <>
      <div className="min-w-0" onContextMenu={onContextMenu}>
        {children}
      </div>
      <PositionedDropdown
        open={open}
        setOpen={setOpen}
        pos={pos}
        alignY="center"
        testId="text-edit-context-menu"
      >
        {editable && (
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
        {editable && (
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
