import AgentUiRecommendationCard from "@/components/agent-ui/beautiful-ui/RecommendationCard";
import { useRef, useState } from "react";
import { CheckCircle2, ListTodo, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAgentStore } from "../../../stores/agent.store";
import type { PlanApprovalEntry } from "./types";

/**
 * In-thread Cursor plan approval card. Buttons sit under the plan body so the
 * user can confirm execution without a blocking modal.
 */
function PlanApprovalCardContent({ entry }: { entry: PlanApprovalEntry }) {
  const respondPlan = useAgentStore((s) => s.respondPlan);
  const submittingRef = useRef(false);
  const [submitting, setSubmitting] = useState(false);
  const pending = entry.status === "pending";
  const title = entry.name?.trim() || "确认执行计划";

  const respondOnce = (outcome: "accepted" | "rejected" | "cancelled") => {
    if (!pending || submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    void respondPlan(entry.requestId, outcome).finally(() => {
      submittingRef.current = false;
      setSubmitting(false);
    });
  };

  return (
    <div className="nex-approval-surface">
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
        <p className="mb-2 text-sm text-[var(--text-secondary)]">
          {entry.overview}
        </p>
      )}

      {entry.plan.trim() && (
        <pre className="mb-2 max-h-64 overflow-y-auto whitespace-pre-wrap rounded bg-[var(--material-sidebar,transparent)] p-2 text-xs text-[var(--text-secondary)]">
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
        <div className="nex-approval-actions">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => respondOnce("rejected")}
          >
            拒绝
          </Button>
          <Button size="sm" disabled={submitting} onClick={() => respondOnce("accepted")}>
            {submitting ? "正在提交…" : "确认执行"}
          </Button>
        </div>
      )}
    </div>
  );
}

export function PlanApprovalCard(
  props: Parameters<typeof PlanApprovalCardContent>[0],
) {
  return (
    <AgentUiRecommendationCard>
      <PlanApprovalCardContent {...props} />
    </AgentUiRecommendationCard>
  );
}
