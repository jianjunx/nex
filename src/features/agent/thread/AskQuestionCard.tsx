import { useEffect, useRef, useState } from "react";
import { CheckCircle2, CheckSquare, Circle, HelpCircle, Square, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { AskQuestionAnswerPayload } from "../../../bridge/events";
import { useAgentStore } from "../../../stores/agent.store";
import type { AskQuestionEntry } from "./types";

/**
 * In-thread AskUserQuestion card. Options sit in the conversation so the
 * user can answer without a blocking modal.
 */
export function AskQuestionCard({ entry }: { entry: AskQuestionEntry }) {
  const respondAskQuestion = useAgentStore((s) => s.respondAskQuestion);
  const submittingRef = useRef(false);
  const pending = entry.status === "pending";
  const [selections, setSelections] = useState<Record<string, string[]>>({});
  const [customTexts, setCustomTexts] = useState<Record<string, string>>({});

  useEffect(() => {
    submittingRef.current = false;
    const init: Record<string, string[]> = {};
    const customs: Record<string, string> = {};
    for (const q of entry.questions) {
      init[q.id] = [];
      customs[q.id] = "";
    }
    setSelections(init);
    setCustomTexts(customs);
  }, [entry.requestId, entry.questions]);

  const title = entry.title?.trim() || "需要你的选择";

  const isAnswered = (questionId: string) => {
    const custom = customTexts[questionId]?.trim();
    if (custom) return true;
    return (selections[questionId]?.length ?? 0) > 0;
  };

  const allAnswered = entry.questions.every((q) => isAnswered(q.id));

  const buildAnswers = (): AskQuestionAnswerPayload[] =>
    entry.questions.map((q) => {
      const custom = customTexts[q.id]?.trim();
      return {
        questionId: q.id,
        selectedOptionIds: custom ? [] : (selections[q.id] ?? []),
        ...(custom ? { customText: custom } : {}),
      };
    });

  const respondOnce = (
    outcome: "answered" | "skipped" | "cancelled",
    answers?: AskQuestionAnswerPayload[],
  ) => {
    if (!pending || submittingRef.current) return;
    submittingRef.current = true;
    void respondAskQuestion(entry.requestId, outcome, answers).finally(() => {
      submittingRef.current = false;
    });
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
    pending && entry.questions.length === 1 && !entry.questions[0].allowMultiple;

  const onOptionClick = (questionId: string, optionId: string, allowMultiple: boolean) => {
    if (!pending) return;
    if (singleFastPath && !customTexts[questionId]?.trim()) {
      respondOnce("answered", [{ questionId, selectedOptionIds: [optionId] }]);
      return;
    }
    toggleOption(questionId, optionId, allowMultiple);
  };

  const statusLabel =
    entry.status === "answered"
      ? "已回答"
      : entry.status === "skipped"
        ? "已跳过"
        : "已取消";

  const resolvedAnswer = (questionId: string) =>
    entry.answers?.find((a) => a.questionId === questionId);

  return (
    <div className="nex-material-panel rounded-[calc(var(--radius-md)+2px)] border border-[color:var(--hairline-soft)] px-3 py-2.5 shadow-[inset_0_1px_0_0_var(--edge-highlight-soft)]">
      <div className="mb-2 flex items-center gap-2 text-sm text-[var(--text-primary)]">
        <HelpCircle size={14} className="shrink-0 text-[var(--accent)]" />
        <span className="font-medium">{title}</span>
        {!pending && (
          <span className="ml-auto inline-flex items-center gap-1 text-xs text-[var(--text-tertiary)]">
            {entry.status === "answered" ? (
              <>
                <CheckCircle2 size={12} className="text-emerald-500" />
                {statusLabel}
              </>
            ) : (
              <>
                <XCircle size={12} />
                {statusLabel}
              </>
            )}
          </span>
        )}
      </div>

      <div className="space-y-4">
        {entry.questions.map((q) => {
          const submitted = resolvedAnswer(q.id);
          return (
            <div key={q.id} className="space-y-2">
              {entry.questions.length > 1 && (
                <p className="text-sm text-[var(--text-primary)]">{q.prompt}</p>
              )}
              {entry.questions.length === 1 && q.prompt !== title && (
                <p className="text-sm text-[var(--text-secondary)]">{q.prompt}</p>
              )}
              {q.allowMultiple && pending && (
                <p className="text-xs text-[var(--text-tertiary)]">可多选</p>
              )}
              <div
                className="space-y-1.5"
                role={q.allowMultiple ? "group" : "radiogroup"}
                aria-label={q.prompt}
              >
                {q.options.map((opt) => {
                  const selected = pending
                    ? (selections[q.id] ?? []).includes(opt.id)
                    : (submitted?.selectedOptionIds ?? []).includes(opt.id);
                  const Indicator = q.allowMultiple
                    ? selected
                      ? CheckSquare
                      : Square
                    : selected
                      ? CheckCircle2
                      : Circle;
                  return (
                    <Button
                      key={opt.id}
                      type="button"
                      variant="ghost"
                      role={q.allowMultiple ? "checkbox" : "radio"}
                      aria-checked={selected}
                      disabled={!pending}
                      className={cn(
                        "nex-interactive-chrome nex-pressable h-auto w-full items-start justify-start gap-2.5 whitespace-normal py-2 text-left font-medium",
                        selected
                          ? "border border-[color:var(--accent)] bg-[color:color-mix(in_srgb,var(--accent)_16%,transparent)] text-[var(--text-primary)] shadow-[inset_0_1px_0_0_var(--edge-highlight-bright)] hover:bg-[color:color-mix(in_srgb,var(--accent)_22%,transparent)] disabled:opacity-100 dark:border-[color:var(--accent)] dark:bg-[color:color-mix(in_srgb,var(--accent)_16%,transparent)] dark:hover:bg-[color:color-mix(in_srgb,var(--accent)_22%,transparent)]"
                          : "border border-[color:var(--hairline-soft)] bg-[color:color-mix(in_srgb,var(--material-panel)_56%,transparent)] text-[var(--text-primary)] hover:border-[color:var(--hairline-strong)] hover:bg-[color:color-mix(in_srgb,var(--material-elevated)_86%,transparent)] disabled:opacity-40",
                      )}
                      onClick={() => onOptionClick(q.id, opt.id, q.allowMultiple)}
                    >
                      <Indicator
                        size={16}
                        className={cn(
                          "mt-0.5 shrink-0",
                          selected ? "text-[var(--accent)]" : "text-[var(--text-tertiary)]",
                        )}
                      />
                      <span className="flex min-w-0 flex-1 flex-col items-start gap-0.5">
                        <span>{opt.label}</span>
                        {opt.description?.trim() && (
                          <span className="text-xs font-normal text-[var(--text-tertiary)]">
                            {opt.description}
                          </span>
                        )}
                      </span>
                    </Button>
                  );
                })}
              </div>
              {pending ? (
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
              ) : submitted?.customText?.trim() ? (
                <p className="text-sm text-[var(--text-secondary)]">
                  其他：{submitted.customText.trim()}
                </p>
              ) : null}
            </div>
          );
        })}
      </div>

      {pending && (
        <div className="flex flex-wrap justify-end gap-2 pt-3">
          <Button variant="ghost" size="sm" onClick={() => respondOnce("skipped")}>
            跳过
          </Button>
          {(!singleFastPath || Object.values(customTexts).some((t) => t.trim())) && (
            <Button size="sm" disabled={!allAnswered} onClick={() => respondOnce("answered", buildAnswers())}>
              提交
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
