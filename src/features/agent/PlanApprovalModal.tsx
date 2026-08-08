import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useAgentStore } from "../../stores/agent.store";
import { useConversationStore } from "../../stores/conversation.store";

export function PlanApprovalModal() {
  const pending = useAgentStore((s) => s.pendingPlanApproval);
  const respondPlan = useAgentStore((s) => s.respondPlan);
  const sessions = useAgentStore((s) => s.sessions);
  const conversationsByProject = useConversationStore((s) => s.conversationsByProject);

  if (!pending) return null;

  const dismiss = () => void respondPlan(pending.requestId, "cancelled");

  const session = Object.values(sessions).find((ss) => ss.sessionId === pending.sessionId);
  const conversation = session
    ? Object.values(conversationsByProject).flat().find((c) => c.id === session.conversationId)
    : undefined;
  const conversationLabel = conversation?.title ?? session?.conversationId ?? null;
  const title = pending.name?.trim() || "确认执行计划";

  return (
    <Dialog open={true} onOpenChange={(o) => { if (!o) dismiss(); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 max-h-[60vh] overflow-y-auto">
          {pending.overview?.trim() && (
            <p className="text-sm text-[var(--text-secondary)]">{pending.overview}</p>
          )}
          {pending.plan.trim() && (
            <pre className="text-xs whitespace-pre-wrap rounded bg-[var(--glass-2-surface)] p-2 text-[var(--text-secondary)]">
              {pending.plan}
            </pre>
          )}
          {pending.todos.length > 0 && (
            <ul className="space-y-1">
              {pending.todos.map((t) => (
                <li
                  key={t.id || t.content}
                  className="text-xs text-[var(--text-primary)] flex gap-2"
                >
                  <span className="text-[var(--text-tertiary)] shrink-0 font-mono">
                    [{t.status}]
                  </span>
                  <span>{t.content}</span>
                </li>
              ))}
            </ul>
          )}
          {conversationLabel && (
            <p className="text-xs text-[var(--text-tertiary)]">Conversation: {conversationLabel}</p>
          )}
        </div>
        <div className="flex gap-2 justify-end">
          <Button variant="ghost" onClick={() => void respondPlan(pending.requestId, "rejected")}>
            拒绝
          </Button>
          <Button onClick={() => void respondPlan(pending.requestId, "accepted")}>
            接受并执行
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
