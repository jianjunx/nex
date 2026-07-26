import { CheckCircle2, Circle, ListTodo, Loader2 } from "lucide-react";
import type { PlanEntry } from "./types";

export function PlanBar({ entries }: { entries: PlanEntry[] }) {
  if (entries.length === 0) return null;
  return (
    <div className="mx-6 mb-2 rounded-[var(--radius-md)] border border-[color:var(--border-subtle)] bg-[var(--glass-2-surface)] px-3 py-2">
      <div className="flex items-center gap-2 text-xs text-[var(--text-secondary)] mb-1.5">
        <ListTodo size={14} />
        <span className="font-medium">Plan</span>
      </div>
      <ul className="space-y-1">
        {entries.map((e, i) => (
          <li key={i} className="flex items-start gap-2 text-xs text-[var(--text-primary)]">
            <PlanStatusIcon status={e.status} />
            <span className={e.status === "completed" ? "line-through opacity-60" : ""}>{e.content}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function PlanStatusIcon({ status }: { status: string }) {
  if (status === "completed") return <CheckCircle2 size={12} className="mt-0.5 text-emerald-500 shrink-0" />;
  if (status === "in_progress") return <Loader2 size={12} className="mt-0.5 animate-spin text-[var(--accent)] shrink-0" />;
  return <Circle size={12} className="mt-0.5 text-[var(--text-tertiary)] shrink-0" />;
}
