import type { ContextUsage } from "./types";

/**
 * 归一化后的用量计数器。ACP 的 `usage.tokens[]` 是带 type 的细分项
 * （input / output / cache_read…），不同 agent 的命名不统一，这里先归并成
 * 三个计数器再参与计算。
 */
export interface UsageCounters {
  input: number;
  output: number;
  cache: number;
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z]/g, "");
}

// 细分命名各 agent 不统一（cache_read_input_tokens / cacheRead /
// cache_creation_input_tokens…），且含义有时落在 name 上，所以按子串匹配。
// cache 必须最先判：它自身常带 "input"（cache_read_input_tokens）。
const CACHE_HINTS = ["cache", "cached"];
const INPUT_HINTS = ["input", "prompt"];
const OUTPUT_HINTS = ["output", "completion"];

function matchesAny(token: string, hints: string[]): boolean {
  return hints.some((h) => token.includes(h));
}

/** 把一条 token 细分项归类到 input / output / cache；无法识别返回 null。 */
function bucketOf(type: string, name?: string): keyof UsageCounters | null {
  const candidates = [normalize(type), name ? normalize(name) : ""].filter(Boolean);
  if (candidates.length === 0) return null;
  if (candidates.some((c) => matchesAny(c, CACHE_HINTS))) return "cache";
  if (candidates.some((c) => matchesAny(c, INPUT_HINTS))) return "input";
  if (candidates.some((c) => matchesAny(c, OUTPUT_HINTS))) return "output";
  return null;
}

/**
 * 从一条 ACP usage 上报里取出计数器；没有任何可识别项时返回 null
 * （调用方据此判断"这个 agent 不上报用量"）。
 *
 * 没有 tokens[] 细分时退回 `used`：那是"当前上下文占用量"的快照，只能当
 * input 的近似值——总比完全不显示好。
 */
export function usageCounters(usage: ContextUsage | null | undefined): UsageCounters | null {
  if (!usage) return null;
  const out: UsageCounters = { input: 0, output: 0, cache: 0 };
  let seen = false;
  for (const t of usage.tokens) {
    const bucket = bucketOf(t.type, t.name);
    if (!bucket) continue;
    out[bucket] += t.value;
    seen = true;
  }
  if (!seen && usage.used > 0) {
    out.input = usage.used;
    seen = true;
  }
  return seen ? out : null;
}

/**
 * 整轮用量 = 收尾时的计数器 − 发 prompt 时的计数器。
 *
 * ACP 的 usage 上报按累计计数器语义（同块的 cost 明确写着 "cumulative
 * session cost"），所以取差才是"这一轮用了多少"。取差同时天然免疫两种
 * 噪声：会话历史的底数（baseline 抵消），以及中途上下文压缩导致的值回落
 * （负差钳到 0，不产出负数）。
 *
 * baseline 为 null 表示发 prompt 时 agent 还没上报过用量，此时 latest 即是
 * 从 0 起算的本轮用量。
 */
export function usageDelta(
  latest: UsageCounters | null,
  baseline: UsageCounters | null,
): UsageCounters | null {
  if (!latest) return null;
  if (!baseline) return latest;
  return {
    input: Math.max(0, latest.input - baseline.input),
    output: Math.max(0, latest.output - baseline.output),
    cache: Math.max(0, latest.cache - baseline.cache),
  };
}
