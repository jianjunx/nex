import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import type { AskQuestionAnswerPayload } from "../../bridge/events";
import { useAgentStore } from "../../stores/agent.store";
import { useConversationStore } from "../../stores/conversation.store";

export function AskQuestionModal() {
  const pending = useAgentStore((s) => s.pendingAskQuestion);
  const respondAskQuestion = useAgentStore((s) => s.respondAskQuestion);
  const sessions = useAgentStore((s) => s.sessions);
  const conversationsByProject = useConversationStore((s) => s.conversationsByProject);
  const [selections, setSelections] = useState<Record<string, string[]>>({});
  const submittingRef = useRef(false);

  useEffect(() => {
    submittingRef.current = false;
    if (!pending) {
      setSelections({});
      return;
    }
    const init: Record<string, string[]> = {};
    for (const q of pending.questions) init[q.id] = [];
    setSelections(init);
  }, [pending]);

  if (!pending) return null;

  const respondOnce = (
    outcome: "answered" | "skipped" | "cancelled",
    answers?: AskQuestionAnswerPayload[],
  ) => {
    if (submittingRef.current) return;
    submittingRef.current = true;
    void respondAskQuestion(pending.requestId, outcome, answers);
  };

  const dismiss = () => respondOnce("cancelled");
  const skip = () => respondOnce("skipped");

  const session = Object.values(sessions).find((ss) => ss.sessionId === pending.sessionId);
  const conversation = session
    ? Object.values(conversationsByProject).flat().find((c) => c.id === session.conversationId)
    : undefined;
  const conversationLabel = conversation?.title ?? session?.conversationId ?? null;
  const title = pending.title?.trim() || "需要你的选择";

  const allAnswered = pending.questions.every((q) => (selections[q.id]?.length ?? 0) > 0);

  const submit = () => {
    if (!allAnswered) return;
    const answers: AskQuestionAnswerPayload[] = pending.questions.map((q) => ({
      questionId: q.id,
      selectedOptionIds: selections[q.id] ?? [],
    }));
    respondOnce("answered", answers);
  };

  const toggleOption = (questionId: string, optionId: string, allowMultiple: boolean) => {
    setSelections((prev) => {
      const current = prev[questionId] ?? [];
      if (allowMultiple) {
        const next = current.includes(optionId)
          ? current.filter((id) => id !== optionId)
          : [...current, optionId];
        return { ...prev, [questionId]: next };
      }
      return { ...prev, [questionId]: [optionId] };
    });
  };

  // Fast path: one single-select question — clicking an option submits immediately.
  const singleFastPath =
    pending.questions.length === 1 && !pending.questions[0].allowMultiple;

  const onOptionClick = (questionId: string, optionId: string, allowMultiple: boolean) => {
    if (singleFastPath) {
      respondOnce("answered", [{ questionId, selectedOptionIds: [optionId] }]);
      return;
    }
    toggleOption(questionId, optionId, allowMultiple);
  };

  return (
    <Dialog open={true} onOpenChange={(o) => { if (!o) dismiss(); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 max-h-[60vh] overflow-y-auto">
          {pending.questions.map((q) => (
            <div key={q.id} className="space-y-2">
              <p className="text-sm text-[var(--text-primary)]">{q.prompt}</p>
              {q.allowMultiple && (
                <p className="text-xs text-[var(--text-tertiary)]">可多选</p>
              )}
              <div className="space-y-1.5">
                {q.options.map((opt) => {
                  const selected = (selections[q.id] ?? []).includes(opt.id);
                  return (
                    <Button
                      key={opt.id}
                      variant="outline"
                      className={cn(
                        "w-full justify-start",
                        selected && "border-[var(--accent)] bg-[var(--glass-2-surface)]",
                      )}
                      onClick={() => onOptionClick(q.id, opt.id, q.allowMultiple)}
                    >
                      {opt.label}
                    </Button>
                  );
                })}
              </div>
            </div>
          ))}
          {conversationLabel && (
            <p className="text-xs text-[var(--text-tertiary)]">Conversation: {conversationLabel}</p>
          )}
        </div>
        <div className="flex gap-2 justify-end">
          <Button variant="ghost" onClick={skip}>
            跳过
          </Button>
          {!singleFastPath && (
            <Button disabled={!allAnswered} onClick={submit}>
              提交
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
