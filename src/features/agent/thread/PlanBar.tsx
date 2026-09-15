import { useState } from "react";
import { ChevronRight, ListTodo, Loader2 } from "lucide-react";
import TaskRows from "@/components/agent-ui/beautiful-ui/TaskRows";
import { cn } from "@/lib/utils";
import type { PlanEntry } from "./types";

export function PlanBar({ entries }: { entries: PlanEntry[] }) {
  const [open, setOpen] = useState(false);
  if (entries.length === 0) return null;

  const completed = entries.filter((e) => e.status === "completed").length;
  const inProgress = entries.some((e) => e.status === "in_progress");

  return (
    <div className="mx-4 mb-1.5 rounded-[calc(var(--radius-md)+2px)] border border-[color:var(--hairline-soft)] bg-[var(--material-floating)] px-2.5 py-1.5 shadow-none">
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
        <div role="list" className="beautiful-ui nex-ui-tasks mt-2">
          <TaskRows variant="List" labels={{ completed: "已完成", failed: "失败" }} rows={entries.map((e, i) => ({ key: String(i), label: e.content, amount: "", step: i + 1, status: e.status === "completed" ? "done" : e.status === "in_progress" ? "running" : "pending", details: [] }))}/>
        </div>
      )}
    </div>
  );
}
