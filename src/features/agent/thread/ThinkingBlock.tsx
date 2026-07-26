import { useState } from "react";
import ReactMarkdown from "react-markdown";
import { Brain } from "lucide-react";

export function ThinkingBlock({ text, defaultOpen = true }: { text: string; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="rounded-[var(--radius-md)] border border-[color:var(--border-subtle)] bg-[var(--glass-2-surface)] overflow-hidden">
      <button
        type="button"
        className="w-full flex items-center gap-2 px-3 py-2 text-xs text-[var(--text-secondary)] hover:bg-[var(--glass-3-surface)]"
        onClick={() => setOpen((v) => !v)}
      >
        <Brain size={14} />
        <span className="font-medium">Thinking</span>
        <span className="ml-auto opacity-60">{open ? "Hide" : "Show"}</span>
      </button>
      {open && (
        <div className="px-3 pb-3 text-sm text-[var(--text-tertiary)] [&_pre]:overflow-x-auto [&_p]:my-1">
          <ReactMarkdown>{text}</ReactMarkdown>
        </div>
      )}
    </div>
  );
}
