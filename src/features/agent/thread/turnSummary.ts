import type { ContextStatsDto } from "../../../bridge/tauri";
import type { TurnSummaryEntry } from "./types";

/** 12 → "12"，1234 → "1.2K"，12345 → "12K"，1234567 → "1.2M"。 */
export function formatCompactTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) {
    const k = n / 1000;
    return k < 10 ? `${trimZero(k.toFixed(1))}K` : `${Math.round(k)}K`;
  }
  const m = n / 1_000_000;
  return m < 10 ? `${trimZero(m.toFixed(1))}M` : `${Math.round(m)}M`;
}

function trimZero(s: string): string {
  return s.endsWith(".0") ? s.slice(0, -2) : s;
}

/** 850 → "0.9s"，12_300 → "12s"，83_000 → "1m 23s"，3_725_000 → "1h 02m"。 */
export function formatTurnDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0s";
  // 先按 0.1s 取整再格式化，避免 0.85.toFixed(1) 这类浮点误差得到 0.8。
  if (ms < 10_000) return `${trimZero((Math.round(ms / 100) / 10).toFixed(1))}s`;
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  if (totalSec < 3600) return `${min}m ${String(totalSec % 60).padStart(2, "0")}s`;
  const hour = Math.floor(min / 60);
  return `${hour}h ${String(min % 60).padStart(2, "0")}m`;
}

export interface TurnSummaryInput {
  startedAt: number;
  endedAt: number;
  model?: string | null;
  stats?: ContextStatsDto | null;
}

/**
 * 组装本轮摘要。token 取整轮累计值（turn*），不是最近一次请求的上下文占用；
 * 没有任何用量上报（外部 ACP agent）时不写 token 字段，界面只显示耗时与模型。
 */
export function buildTurnSummary(
  input: TurnSummaryInput,
): Omit<TurnSummaryEntry, "id" | "kind" | "timestamp"> {
  const out: Omit<TurnSummaryEntry, "id" | "kind" | "timestamp"> = {
    durationMs: Math.max(0, input.endedAt - input.startedAt),
  };
  const model = input.model?.trim();
  if (model) out.model = model;
  const prompt = input.stats?.turnPromptTokens ?? 0;
  const completion = input.stats?.turnCompletionTokens ?? 0;
  if (prompt > 0 || completion > 0) {
    out.promptTokens = prompt;
    out.completionTokens = completion;
    const cache = input.stats?.turnCacheHitTokens ?? 0;
    if (cache > 0) out.cacheHitTokens = cache;
  }
  return out;
}
