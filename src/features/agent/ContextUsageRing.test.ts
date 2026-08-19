/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import type { ContextStatsDto } from "../../bridge/tauri";
import { ContextUsageRing, fmtTokens, resolveContextRingUsage, summarizeRecentCacheHits } from "./ContextUsageRing";

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

describe("summarizeRecentCacheHits", () => {
  it("computes a token-weighted summary", () => {
    expect(
      summarizeRecentCacheHits([
        { cacheHitTokens: 90, promptTokens: 100, timestamp: 1 },
        { cacheHitTokens: 10, promptTokens: 100, timestamp: 2 },
        { cacheHitTokens: 20, promptTokens: 50, timestamp: 3 },
      ]),
    ).toEqual({ sampleCount: 3, cacheHitTokens: 120, promptTokens: 250 });
  });

  it("ignores zero-prompt samples", () => {
    expect(
      summarizeRecentCacheHits([
        { cacheHitTokens: 50, promptTokens: 0, timestamp: 1 },
        { cacheHitTokens: 20, promptTokens: 40, timestamp: 2 },
      ]),
    ).toEqual({ sampleCount: 1, cacheHitTokens: 20, promptTokens: 40 });
  });

  it("returns null when no usable samples remain", () => {
    expect(summarizeRecentCacheHits([{ cacheHitTokens: 50, promptTokens: 0, timestamp: 1 }])).toBeNull();
  });
});

describe("ContextUsageRing", () => {
  it("renders this-turn and recent cache-hit labels", () => {
    render(
      createElement(ContextUsageRing, {
        usage: { used: 30_000, total: 200_000, tokens: [] },
        stats: stats({ cacheHitTokens: 12_000, promptTokens: 20_000 }),
        recentCacheHitSummary: { sampleCount: 3, cacheHitTokens: 48_000, promptTokens: 100_000 },
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "上下文用量 30K / 200K" }));

    expect(screen.getByText("缓存命中（本轮）")).toBeTruthy();
    expect(screen.getByText("12K / 20K (60%)")).toBeTruthy();
    expect(screen.getByText("缓存命中（近 3 轮）")).toBeTruthy();
    expect(screen.getByText("48K / 100K (48%)")).toBeTruthy();
  });
});
