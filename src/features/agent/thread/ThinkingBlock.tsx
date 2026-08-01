import { useLayoutEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { Brain } from "lucide-react";

export function ThinkingBlock({ text, defaultOpen = true }: { text: string; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const bodyRef = useRef<HTMLDivElement>(null);

  // 流式追加时始终贴底，方便跟最新思考内容。
  useLayoutEffect(() => {
    if (!open) return;
    const el = bodyRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [text, open]);

  return (
    <div className="rounded-[var(--radius-md)] border border-[color:var(--border-subtle)] bg-[var(--glass-2-surface)] overflow-hidden">
      <button
        type="button"
        className="w-full flex items-center gap-2 px-2.5 py-1.5 text-xs text-[var(--text-secondary)] hover:bg-[var(--glass-3-surface)]"
        onClick={() => setOpen((v) => !v)}
      >
        <Brain size={14} />
        <span className="font-medium">Thinking</span>
        <span className="ml-auto opacity-60">{open ? "Hide" : "Show"}</span>
      </button>
      {open && (
        <div
          ref={bodyRef}
          className="max-h-[300px] overflow-y-auto px-2.5 pb-2 text-sm text-[var(--text-tertiary)] [&_pre]:overflow-x-auto [&_p]:my-1"
        >
          <ReactMarkdown>{text}</ReactMarkdown>
        </div>
      )}
    </div>
  );
}
