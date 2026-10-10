import { memo } from "react";
import { formatCompactTokens, formatTurnDuration } from "./turnSummary";
import type { TurnSummaryEntry } from "./types";

/** 一轮对话末尾的用量摘要：耗时 · token · 模型。纯文本一行，不抢视觉。 */
export const TurnSummaryLine = memo(function TurnSummaryLine({
  entry,
}: {
  entry: TurnSummaryEntry;
}) {
  const hasTokens = entry.promptTokens != null || entry.completionTokens != null;
  const prompt = entry.promptTokens ?? 0;
  const completion = entry.completionTokens ?? 0;
  const tokenTitle = hasTokens
    ? [
        `输入 ${prompt.toLocaleString()} tokens`,
        `输出 ${completion.toLocaleString()} tokens`,
        entry.cacheHitTokens ? `缓存命中 ${entry.cacheHitTokens.toLocaleString()} tokens` : null,
      ]
        .filter(Boolean)
        .join("\n")
    : undefined;

  return (
    <div
      className="flex max-w-[96%] flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-[var(--text-tertiary)]"
      data-testid="turn-summary"
    >
      <span title="本轮耗时">用时 {formatTurnDuration(entry.durationMs)}</span>
      {hasTokens && (
        <>
          <span aria-hidden>·</span>
          <span title={tokenTitle} className="tabular-nums">
            输入 {formatCompactTokens(prompt)} / 输出 {formatCompactTokens(completion)} tokens
          </span>
        </>
      )}
      {entry.model && (
        <>
          <span aria-hidden>·</span>
          <span title="本轮模型" className="min-w-0 truncate">
            {entry.model}
          </span>
        </>
      )}
    </div>
  );
});
