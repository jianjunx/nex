import { describe, expect, it } from "vitest";
import type { ContextStatsDto } from "../../bridge/tauri";
import { fmtTokens, resolveContextRingUsage } from "./ContextUsageRing";

function stats(partial: Partial<ContextStatsDto>): ContextStatsDto {
  return {
    schemaVersion: 3,
    initialTokens: 0,
    finalTokens: 0,
    compactionPasses: 0,
    snippedMessages: 0,
    foldedMessages: 0,
    archiveFilesWritten: 0,
    toolResults: 0,
    partialToolResults: 0,
    cacheHitTokens: 0,
    promptTokens: 0,
    contextWindow: 0,
    usedSummaryFallback: false,
    overBudget: false,
    ...partial,
  };
}

describe("fmtTokens", () => {
  it("formats whole thousands as uppercase K", () => {
    expect(fmtTokens(30_000)).toBe("30K");
    expect(fmtTokens(200_000)).toBe("200K");
    expect(fmtTokens(1_000)).toBe("1K");
  });

  it("keeps one decimal under 10K", () => {
    expect(fmtTokens(1_234)).toBe("1.2K");
  });

  it("formats millions", () => {
    expect(fmtTokens(1_000_000)).toBe("1M");
    expect(fmtTokens(1_500_000)).toBe("1.5M");
  });
});

describe("resolveContextRingUsage", () => {
  it("fills total from native contextWindow when ACP usage has none", () => {
    const usage = resolveContextRingUsage(
      { used: 30_000, total: 0, tokens: [] },
      stats({ contextWindow: 200_000, finalTokens: 30_000 }),
    );
    expect(usage).toEqual({ used: 30_000, total: 200_000, tokens: [] });
  });

  it("uses native stats when ACP did not report usage", () => {
    const usage = resolveContextRingUsage(
      null,
      stats({ contextWindow: 200_000, finalTokens: 30_000 }),
    );
    expect(usage).toEqual({ used: 30_000, total: 200_000, tokens: [] });
  });

  it("prefers ACP size when both are present", () => {
    const usage = resolveContextRingUsage(
      { used: 12, total: 100, tokens: [{ type: "input", value: 12 }] },
      stats({ contextWindow: 200_000, finalTokens: 30_000 }),
    );
    expect(usage?.used).toBe(12);
    expect(usage?.total).toBe(100);
  });

  it("returns null when nothing is known", () => {
    expect(resolveContextRingUsage(null, undefined)).toBeNull();
  });
});
