import { useState } from "react";
import { Clock, ChevronRight, Send, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { PendingMessage, pendingMessagePreview } from "../../../stores/agent.store";

export function PendingMessagesBar({
  messages,
  onSendNow,
  onRemove,
  previewFn,
}: {
  messages: PendingMessage[];
  onSendNow: (id: string) => void;
  onRemove: (id: string) => void;
  previewFn: typeof pendingMessagePreview;
}) {
  const [open, setOpen] = useState(true);
  if (messages.length === 0) return null;

  return (
    <div className="mx-4 mb-1.5 rounded-[calc(var(--radius-md)+2px)] border border-[color:var(--hairline-soft)] bg-[var(--material-floating)] px-2.5 py-1.5 shadow-[inset_0_1px_0_0_var(--edge-highlight-soft)]">
      <button
        type="button"
        className="flex w-full items-center gap-2 text-xs text-[var(--text-secondary)] nex-interactive-chrome hover:text-[var(--text-primary)]"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <Clock size={14} className="shrink-0" />
        <span className="font-medium">等待发送</span>
        <span className="text-[var(--text-tertiary)]">{messages.length}</span>
        <ChevronRight
          size={12}
          className={cn("ml-auto shrink-0 transition-transform", open && "rotate-90")}
        />
      </button>
      {open && (
        <ul className="space-y-1 mt-1.5">
          {messages.map((m) => (
            <li key={m.id} className="flex items-center gap-2 text-xs text-[var(--text-primary)] group">
              <span className="flex-1 truncate text-[var(--text-tertiary)]">
                {previewFn(m.blocks)}
              </span>
              <button
                type="button"
                className="nex-interactive-chrome shrink-0 rounded-[var(--radius-sm)] p-0.5 text-[var(--text-tertiary)] hover:bg-[var(--overlay-hover)] hover:text-[var(--accent)]"
                onClick={(e) => {
                  e.stopPropagation();
                  onSendNow(m.id);
                }}
                title="立即发送"
              >
                <Send size={11} />
              </button>
              <button
                type="button"
                className="nex-interactive-chrome shrink-0 rounded-[var(--radius-sm)] p-0.5 text-[var(--text-tertiary)] hover:bg-[var(--overlay-hover)] hover:text-[var(--text-primary)]"
                onClick={(e) => {
                  e.stopPropagation();
                  onRemove(m.id);
                }}
                title="移除"
              >
                <X size={11} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
