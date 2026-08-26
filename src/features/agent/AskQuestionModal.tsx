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
  const [customTexts, setCustomTexts] = useState<Record<string, string>>({});
  const submittingRef = useRef(false);

  useEffect(() => {
    submittingRef.current = false;
    if (!pending) {
      setSelections({});
      setCustomTexts({});
      return;
    }
    const init: Record<string, string[]> = {};
    const customs: Record<string, string> = {};
    for (const q of pending.questions) {
      init[q.id] = [];
      customs[q.id] = "";
    }
    setSelections(init);
    setCustomTexts(customs);
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

  const isAnswered = (questionId: string) => {
    const custom = customTexts[questionId]?.trim();
    if (custom) return true;
    return (selections[questionId]?.length ?? 0) > 0;
  };

  const allAnswered = pending.questions.every((q) => isAnswered(q.id));

  const buildAnswers = (): AskQuestionAnswerPayload[] =>
    pending.questions.map((q) => {
      const custom = customTexts[q.id]?.trim();
      return {
        questionId: q.id,
        selectedOptionIds: custom ? [] : (selections[q.id] ?? []),
        ...(custom ? { customText: custom } : {}),
      };
    });

  const submit = () => {
    if (!allAnswered) return;
    respondOnce("answered", buildAnswers());
  };

  const toggleOption = (questionId: string, optionId: string, allowMultiple: boolean) => {
    setCustomTexts((prev) => ({ ...prev, [questionId]: "" }));
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

  // Fast path: one single-select question — clicking an option submits immediately
  // (unless the user is typing a custom answer).
  const singleFastPath =
    pending.questions.length === 1 && !pending.questions[0].allowMultiple;

  const onOptionClick = (questionId: string, optionId: string, allowMultiple: boolean) => {
    if (singleFastPath && !customTexts[questionId]?.trim()) {
      respondOnce("answered", [
        { questionId, selectedOptionIds: [optionId] },
      ]);
      return;
    }
    toggleOption(questionId, optionId, allowMultiple);
  };

  return (
    <Dialog open={true} onOpenChange={(o) => { if (!o) dismiss(); }}>
      <DialogContent className="sm:max-w-lg border-[color:var(--hairline-soft)] bg-[var(--material-elevated)]">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 max-h-[60vh] overflow-y-auto">
          {pending.questions.map((q) => (
            <div key={q.id} className="space-y-2">
              {pending.questions.length > 1 && (
                <p className="text-sm text-[var(--text-primary)]">{q.prompt}</p>
              )}
              {pending.questions.length === 1 && q.prompt !== title && (
                <p className="text-sm text-[var(--text-secondary)]">{q.prompt}</p>
              )}
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
                        "h-auto w-full flex-col items-start gap-0.5 whitespace-normal py-2 text-left",
                        selected && "border-[var(--accent)] bg-[color:color-mix(in_srgb,var(--material-elevated)_88%,transparent)] shadow-[inset_0_1px_0_0_var(--edge-highlight-soft)]",
                      )}
                      onClick={() => onOptionClick(q.id, opt.id, q.allowMultiple)}
                    >
                      <span>{opt.label}</span>
                      {opt.description?.trim() && (
                        <span className="text-xs font-normal text-[var(--text-tertiary)]">
                          {opt.description}
                        </span>
                      )}
                    </Button>
                  );
                })}
              </div>
              <div className="space-y-1">
                <label className="text-xs text-[var(--text-tertiary)]" htmlFor={`ask-other-${q.id}`}>
                  其他（可选）
                </label>
                <input
                  id={`ask-other-${q.id}`}
                  type="text"
                  value={customTexts[q.id] ?? ""}
                  placeholder="输入自定义答案…"
                  className="w-full rounded-[var(--radius-md)] border border-[color:var(--hairline-soft)] bg-[color:color-mix(in_srgb,var(--material-panel)_72%,transparent)] px-2.5 py-1.5 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
                  onChange={(e) => {
                    const value = e.target.value;
                    setCustomTexts((prev) => ({ ...prev, [q.id]: value }));
                    if (value.trim()) {
                      setSelections((prev) => ({ ...prev, [q.id]: [] }));
                    }
                  }}
                />
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
          {(!singleFastPath || Object.values(customTexts).some((t) => t.trim())) && (
            <Button disabled={!allAnswered} onClick={submit}>
              提交
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
