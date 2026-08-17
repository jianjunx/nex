import { useState } from "react";
import { CheckCircle2, ChevronRight, Circle, ListTodo, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { PlanEntry } from "./types";

export function PlanBar({ entries }: { entries: PlanEntry[] }) {
  const [open, setOpen] = useState(false);
  if (entries.length === 0) return null;

  const completed = entries.filter((e) => e.status === "completed").length;
  const inProgress = entries.some((e) => e.status === "in_progress");

  return (
    <div className="mx-4 mb-1.5 rounded-[calc(var(--radius-md)+2px)] border border-[color:var(--hairline-soft)] bg-[var(--material-floating)] px-2.5 py-1.5 shadow-[inset_0_1px_0_0_var(--edge-highlight-soft)]">
      <button
        type="button"
        className="flex w-full items-center gap-2 text-xs text-[var(--text-secondary)] nex-interactive-chrome hover:text-[var(--text-primary)]"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <ListTodo size={14} className="shrink-0" />
        <span className="font-medium">Plan</span>
        <span className="text-[var(--text-tertiary)]">
          {completed}/{entries.length}
        </span>
        {inProgress && !open && (
          <Loader2 size={12} className="animate-spin text-[var(--accent)] shrink-0" />
        )}
        <ChevronRight
          size={12}
          className={cn("ml-auto shrink-0 transition-transform", open && "rotate-90")}
        />
      </button>
      {open && (
        <ul className="space-y-1 mt-1.5">
          {entries.map((e, i) => (
            <li key={i} className="flex items-start gap-2 text-xs text-[var(--text-primary)]">
              <PlanStatusIcon status={e.status} />
              <span className={e.status === "completed" ? "line-through opacity-60" : ""}>
                {e.content}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function PlanStatusIcon({ status }: { status: string }) {
  if (status === "completed") return <CheckCircle2 size={12} className="mt-0.5 text-emerald-500 shrink-0" />;
  if (status === "in_progress") return <Loader2 size={12} className="mt-0.5 animate-spin text-[var(--accent)] shrink-0" />;
  return <Circle size={12} className="mt-0.5 text-[var(--text-tertiary)] shrink-0" />;
}
