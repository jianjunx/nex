import { useRef } from "react";
import { CheckCircle2, ListTodo, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAgentStore } from "../../../stores/agent.store";
import type { PlanApprovalEntry } from "./types";

/**
 * In-thread Cursor plan approval card. Buttons sit under the plan body so the
 * user can confirm execution without a blocking modal.
 */
export function PlanApprovalCard({ entry }: { entry: PlanApprovalEntry }) {
  const respondPlan = useAgentStore((s) => s.respondPlan);
  const submittingRef = useRef(false);
  const pending = entry.status === "pending";
  const title = entry.name?.trim() || "确认执行计划";

  const respondOnce = (outcome: "accepted" | "rejected" | "cancelled") => {
    if (!pending || submittingRef.current) return;
    submittingRef.current = true;
    void respondPlan(entry.requestId, outcome).finally(() => {
      submittingRef.current = false;
    });
  };

  return (
    <div className="rounded-[var(--radius-md)] border border-[color:var(--border-subtle)] bg-[var(--glass-2-surface)] px-3 py-2.5">
      <div className="mb-2 flex items-center gap-2 text-sm text-[var(--text-primary)]">
        <ListTodo size={14} className="shrink-0 text-[var(--accent)]" />
        <span className="font-medium">{title}</span>
        {!pending && (
          <span className="ml-auto inline-flex items-center gap-1 text-xs text-[var(--text-tertiary)]">
            {entry.status === "accepted" ? (
              <>
                <CheckCircle2 size={12} className="text-emerald-500" />
                已确认执行
              </>
            ) : (
              <>
                <XCircle size={12} />
                {entry.status === "rejected" ? "已拒绝" : "已取消"}
              </>
            )}
          </span>
        )}
      </div>

      {entry.overview?.trim() && (
        <p className="mb-2 text-sm text-[var(--text-secondary)]">{entry.overview}</p>
      )}

      {entry.plan.trim() && (
        <pre className="mb-2 max-h-64 overflow-y-auto whitespace-pre-wrap rounded bg-[var(--glass-1-surface,transparent)] p-2 text-xs text-[var(--text-secondary)]">
          {entry.plan}
        </pre>
      )}

      {entry.todos.length > 0 && (
        <ul className="mb-2 space-y-1">
          {entry.todos.map((t) => (
            <li
              key={t.id || t.content}
              className="flex gap-2 text-xs text-[var(--text-primary)]"
            >
              <span className="shrink-0 font-mono text-[var(--text-tertiary)]">
                [{t.status}]
              </span>
              <span>{t.content}</span>
            </li>
          ))}
        </ul>
      )}

      {pending && (
        <div className="flex flex-wrap justify-end gap-2 pt-1">
          <Button variant="ghost" size="sm" onClick={() => respondOnce("rejected")}>
            拒绝
          </Button>
          <Button size="sm" onClick={() => respondOnce("accepted")}>
            确认执行
          </Button>
        </div>
      )}
    </div>
  );
}
