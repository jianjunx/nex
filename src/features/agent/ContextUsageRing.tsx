import { Popover } from "radix-ui";
import type { ContextStatsDto } from "../../bridge/tauri";
import type { CacheHitSample } from "../../stores/agent.store";
import type { ContextUsage } from "./thread/types";

/** Compact token count: 30000 → 30K, 200000 → 200K, 1234 → 1.2K. */
export function fmtTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0";
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return `${Number.isInteger(m) ? m : m.toFixed(1)}M`;
  }
  if (n >= 1_000) {
    const k = n / 1_000;
    if (Number.isInteger(k)) return `${k}K`;
    return `${k.toFixed(k >= 10 ? 0 : 1)}K`;
  }
  return String(Math.round(n));
}

const TOKEN_TYPE_LABELS: Record<string, string> = {
  input: "输入",
  output: "输出",
};

function tokenLabel(type: string, name?: string): string {
  if (name) return name;
  return TOKEN_TYPE_LABELS[type] ?? type;
}

/** 环形进度颜色：<70% 常规色，70-90% 提醒色，>90% 告警色。 */
function ringColor(ratio: number): string {
  if (ratio >= 0.9) return "var(--danger, #ef4444)";
  if (ratio >= 0.7) return "var(--warning, #f59e0b)";
  return "var(--accent)";
}

/** Merge ACP session usage with native per-turn stats so the ring always has a window. */
export function resolveContextRingUsage(
  contextUsage: ContextUsage | null | undefined,
  stats?: ContextStatsDto | null,
): ContextUsage | null {
  const window = stats?.contextWindow ?? 0;
  // Provider-reported input usage is exact for the serialized request; keep
  // the local estimate only as the preflight/fallback value.
  const observed = stats?.promptTokens ?? 0;
  const estimated = observed > 0 ? observed : (stats?.finalTokens ?? 0);
  if (contextUsage) {
    return {
      used: contextUsage.used > 0 ? contextUsage.used : estimated,
      total: contextUsage.total > 0 ? contextUsage.total : window,
      tokens: contextUsage.tokens,
    };
  }
  if (!stats) return null;
  return { used: estimated, total: window, tokens: [] };
}

function cacheHitLabel(stats: ContextStatsDto): string {
  const prompt = stats.promptTokens;
  const hit = stats.cacheHitTokens;
  if (prompt <= 0 && hit <= 0) return "—";
  if (prompt <= 0) return fmtTokens(hit);
  const pct = Math.round((hit / prompt) * 100);
  return `${fmtTokens(hit)} / ${fmtTokens(prompt)} (${pct}%)`;
}

export interface CacheHitSummary {
  sampleCount: number;
  cacheHitTokens: number;
  promptTokens: number;
}

export function summarizeRecentCacheHits(samples: CacheHitSample[]): CacheHitSummary | null {
  let cacheHitTokens = 0;
  let promptTokens = 0;
  let sampleCount = 0;
  for (const sample of samples) {
    if (sample.promptTokens <= 0) continue;
    cacheHitTokens += sample.cacheHitTokens;
    promptTokens += sample.promptTokens;
    sampleCount += 1;
  }
  if (sampleCount === 0 || promptTokens <= 0) return null;
  return { sampleCount, cacheHitTokens, promptTokens };
}

function cacheHitSummaryLabel(summary: CacheHitSummary | null): string {
  if (!summary) return "—";
  const pct = Math.round((summary.cacheHitTokens / summary.promptTokens) * 100);
  return `${fmtTokens(summary.cacheHitTokens)} / ${fmtTokens(summary.promptTokens)} (${pct}%)`;
}

interface Props {
  usage: ContextUsage;
  stats?: ContextStatsDto | null;
  recentCacheHitSummary?: CacheHitSummary | null;
}

/** Composer 模式切换前的上下文用量环；点击展开后右侧显示 30K / 200K。 */
export function ContextUsageRing({ usage, stats, recentCacheHitSummary }: Props) {
  const { used, total, tokens } = usage;
  const ratio = total > 0 ? Math.min(1, used / total) : 0;
  const color = ringColor(ratio);

  // SVG 环形进度（r=6.5，周长≈40.84）
  const R = 6.5;
  const C = 2 * Math.PI * R;
  const dash = C * (total > 0 ? ratio : 0);
  const fraction = total > 0 ? `${fmtTokens(used)} / ${fmtTokens(total)}` : fmtTokens(used);

  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label={`上下文用量 ${fraction}`}
          title={`上下文用量 ${fraction}`}
          className="nex-interactive-chrome flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--radius-md)] border border-[color:var(--hairline-soft)] bg-[color:color-mix(in_srgb,var(--material-panel)_78%,transparent)] text-[var(--text-secondary)] shadow-[inset_0_1px_0_0_var(--edge-highlight-soft)] hover:bg-[color:color-mix(in_srgb,var(--material-floating)_78%,transparent)]"
        >
          <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden>
            <circle
              cx="9"
              cy="9"
              r={R}
              fill="none"
              stroke="var(--border-subtle)"
              strokeWidth="2.5"
            />
            <circle
              cx="9"
              cy="9"
              r={R}
              fill="none"
              stroke={color}
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeDasharray={`${dash} ${C - dash}`}
              transform="rotate(-90 9 9)"
            />
          </svg>
        </button>
      </Popover.Trigger>
      <Popover.Content
        side="top"
        align="end"
        sideOffset={8}
        className="z-[70] w-64 rounded-[calc(var(--radius-md)+2px)] border border-[color:var(--hairline-soft)] bg-[var(--material-floating)] p-3 nex-material-floating"
      >
        <div className="text-xs font-semibold text-[var(--text-primary)]">上下文用量</div>
        {total > 0 ? (
          <>
            <div className="mt-2 flex items-baseline justify-between gap-2">
              <span className="text-lg font-semibold" style={{ color }}>
                {Math.round(ratio * 100)}%
              </span>
              <span className="text-xs tabular-nums text-[var(--text-secondary)]">
                {fmtTokens(used)} / {fmtTokens(total)}
              </span>
            </div>
            <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-[color:color-mix(in_srgb,var(--material-panel)_72%,transparent)]">
              <div
                className="h-full rounded-full"
                style={{ width: `${ratio * 100}%`, backgroundColor: color }}
              />
            </div>
          </>
        ) : (
          <div className="mt-2 text-xs tabular-nums text-[var(--text-secondary)]">
            已用 {fmtTokens(used)}
          </div>
        )}
        {tokens.length > 0 && (
          <div className="mt-2 space-y-1 border-t border-[color:var(--hairline-soft)] pt-2">
            {tokens.map((t, i) => (
              <div key={`${t.type}-${i}`} className="flex items-center justify-between text-xs">
                <span className="text-[var(--text-secondary)]">{tokenLabel(t.type, t.name)}</span>
                <span className="font-mono tabular-nums text-[var(--text-primary)]">{fmtTokens(t.value)}</span>
              </div>
            ))}
          </div>
        )}
        {stats && (
          <div className="mt-2 space-y-1 border-t border-[color:var(--hairline-soft)] pt-2">
            <div className="flex items-center justify-between text-xs">
              <span className="text-[var(--text-secondary)] whitespace-nowrap">缓存命中（本轮）</span>
              <span className="font-mono tabular-nums text-[var(--text-primary)] whitespace-nowrap">
                {cacheHitLabel(stats)}
              </span>
            </div>
            <div className="flex items-center justify-between text-xs">
              <span className="text-[var(--text-secondary)]">
                缓存命中（近 {recentCacheHitSummary?.sampleCount ?? 0} 轮）
              </span>
              <span className="font-mono tabular-nums text-[var(--text-primary)] whitespace-nowrap">
                {cacheHitSummaryLabel(recentCacheHitSummary ?? null)}
              </span>
            </div>
            <div className="flex items-center justify-between gap-2 text-xs">
              <span className="text-[var(--text-secondary)]">压缩</span>
              <span className="font-mono tabular-nums text-[var(--text-primary)]">
                {stats.compactionPasses} 轮 / 截断 {stats.snippedMessages} / 折叠 {stats.foldedMessages}
              </span>
            </div>
            {stats.usedSummaryFallback && (
              <div className="text-xs text-[var(--text-secondary)]">已使用摘要折叠</div>
            )}
            {stats.overBudget && (
              <div className="text-xs text-[var(--error,#ef4444)]">超出窗口，本轮未发送</div>
            )}
          </div>
        )}
      </Popover.Content>
    </Popover.Root>
  );
}
