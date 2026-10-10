import { useEffect, useRef, useState } from "react";
import { ApprovalPromptCard } from "@/components/agent-ui/beautiful-ui/ApprovalCard";
import type { AskQuestionAnswerPayload } from "../../../bridge/events";
import { useAgentStore } from "../../../stores/agent.store";
import type { AskQuestionEntry } from "./types";

/**
 * In-thread AskUserQuestion card. One question at a time, matching Approval Card,
 * with the original answer / skip callbacks.
 */
function AskQuestionCardContent({ entry }: { entry: AskQuestionEntry }) {
  const respondAskQuestion = useAgentStore((s) => s.respondAskQuestion);
  const submittingRef = useRef(false);
  const pending = entry.status === "pending";
  const [qi, setQi] = useState(0);
  const [selections, setSelections] = useState<Record<string, string[]>>({});
  const [customTexts, setCustomTexts] = useState<Record<string, string>>({});

  useEffect(() => {
    submittingRef.current = false;
    setQi(0);
    const init: Record<string, string[]> = {};
    const customs: Record<string, string> = {};
    for (const q of entry.questions) {
      init[q.id] = [];
      customs[q.id] = "";
    }
    setSelections(init);
    setCustomTexts(customs);
  }, [entry.requestId, entry.questions]);

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

  const toggleOption = (
    questionId: string,
    optionId: string,
    allowMultiple: boolean,
  ) => {
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

  const singleFastPath =
    pending &&
    entry.questions.length === 1 &&
    !entry.questions[0].allowMultiple;

  const onOptionClick = (
    questionId: string,
    optionId: string,
    allowMultiple: boolean,
  ) => {
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

  const index = Math.min(qi, Math.max(0, entry.questions.length - 1));
  const visible = pending && entry.questions.length > 1
    ? [entry.questions[index]]
    : entry.questions;
  const current = entry.questions[index];
  const hasCustom = Object.values(customTexts).some((t) => t.trim());
  const showSubmit = pending && (!singleFastPath || hasCustom);
  const last = index >= entry.questions.length - 1;
  const submitDisabled = entry.questions.length > 1
    ? last
      ? !allAnswered
      : !current || !isAnswered(current.id)
    : !allAnswered;

  return (
    <ApprovalPromptCard
      status={
        pending
          ? null
          : { label: statusLabel, tone: entry.status === "answered" ? "ok" : "muted" }
      }
      sections={visible.map((q) => {
        const submitted = resolvedAnswer(q.id);
        const prompt =
          entry.questions.length === 1 && q.prompt === (entry.title?.trim() || q.prompt)
            ? entry.title?.trim() || q.prompt
            : q.prompt;
        return {
          id: q.id,
          prompt,
          hint: q.allowMultiple && pending ? "可多选" : undefined,
          type: q.allowMultiple ? "check" as const : "radio" as const,
          options: q.options.map((opt) => ({
            id: opt.id,
            label: opt.label,
            description: opt.description,
          })),
          selectedIds: pending
            ? (selections[q.id] ?? [])
            : (submitted?.selectedOptionIds ?? []),
          customText: pending ? (customTexts[q.id] ?? "") : (submitted?.customText ?? ""),
          pending,
          customPlaceholder: "其他…",
          onToggle: (optionId) => onOptionClick(q.id, optionId, q.allowMultiple),
          onCustomChange: (value) => {
            setCustomTexts((prev) => ({ ...prev, [q.id]: value }));
            if (value.trim()) setSelections((prev) => ({ ...prev, [q.id]: [] }));
          },
          onCustomKeyDown: (event) => {
            if (event.key === "Enter" && isAnswered(q.id)) {
              event.preventDefault();
              if (entry.questions.length > 1 && !last) setQi((i) => i + 1);
              else respondOnce("answered", buildAnswers());
            }
          },
        };
      })}
      step={
        pending && entry.questions.length > 1
          ? {
              index,
              total: entry.questions.length,
              onPrev: () => setQi((i) => Math.max(0, i - 1)),
              onNext: () => setQi((i) => Math.min(entry.questions.length - 1, i + 1)),
            }
          : null
      }
      skipLabel="跳过"
      onSkip={pending ? () => respondOnce("skipped") : undefined}
      showSubmit={showSubmit}
      submitLabel={entry.questions.length > 1 && !last ? "继续" : "提交"}
      submitDisabled={submitDisabled}
      onSubmit={() => {
        if (entry.questions.length > 1 && !last) {
          setQi((i) => i + 1);
          return;
        }
        respondOnce("answered", buildAnswers());
      }}
    />
  );
}

export function AskQuestionCard(
  props: Parameters<typeof AskQuestionCardContent>[0],
) {
  return <AskQuestionCardContent {...props} />;
}
