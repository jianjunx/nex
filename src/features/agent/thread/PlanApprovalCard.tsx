import { useRef, useState } from "react";
import { ApprovalPromptCard } from "@/components/agent-ui/beautiful-ui/ApprovalCard";
import { useAgentStore } from "../../../stores/agent.store";
import type { PlanApprovalEntry } from "./types";

/**
 * In-thread Cursor plan approval. Same Approval Card frame as questions and
 * permission prompts: the plan body sits under the heading, actions in the footer.
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

  const statusLabel =
    entry.status === "accepted"
      ? "已确认执行"
      : entry.status === "rejected"
        ? "已拒绝"
        : "已取消";

  return (
    <ApprovalPromptCard
      status={
        pending
          ? null
          : { label: statusLabel, tone: entry.status === "accepted" ? "ok" : "muted" }
      }
      sections={[
        {
          id: entry.requestId,
          prompt: title,
          type: "radio",
          options: [],
          selectedIds: [],
          pending: false,
          extra: (
            <div className="mt-2.5 flex flex-col gap-2">
              {entry.overview?.trim() && (
                <p className="text-[13px] leading-relaxed text-ink-2">{entry.overview}</p>
              )}
              {entry.plan.trim() && (
                <pre className="max-h-64 overflow-y-auto whitespace-pre-wrap rounded-control bg-inset p-2 font-mono text-[11.5px] leading-relaxed text-ink-2">
                  {entry.plan}
                </pre>
              )}
              {entry.todos.length > 0 && (
                <ul className="flex flex-col gap-1">
                  {entry.todos.map((t) => (
                    <li
                      key={t.id || t.content}
                      className="flex gap-2 text-[12.5px] text-ink"
                    >
                      <span className="shrink-0 font-mono text-ink-3">[{t.status}]</span>
                      <span>{t.content}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ),
        },
      ]}
      skipLabel="拒绝"
      onSkip={pending ? () => respondOnce("rejected") : undefined}
      showSubmit={pending}
      submitLabel={submitting ? "正在提交…" : "确认执行"}
      submitDisabled={submitting}
      onSubmit={() => respondOnce("accepted")}
    />
  );
}

export function PlanApprovalCard(
  props: Parameters<typeof PlanApprovalCardContent>[0],
) {
  return <PlanApprovalCardContent {...props} />;
}
