import { describe, expect, it } from "vitest";
import type { ContextStatsDto } from "../../../bridge/tauri";
import { buildTurnSummary, formatCompactTokens, formatTurnDuration } from "./turnSummary";

function stats(partial: Partial<ContextStatsDto>): ContextStatsDto {
  return {
    schemaVersion: 4,
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
    usedSummaryFallback: false,
    overBudget: false,
    ...partial,
  };
}

describe("formatTurnDuration", () => {
  it.each([
    [0, "0s"],
    [850, "0.9s"],
    [3000, "3s"],
    [3400, "3.4s"],
    [12_300, "12s"],
    [59_400, "59s"],
    [83_000, "1m 23s"],
    [600_000, "10m 00s"],
    [3_725_000, "1h 02m"],
  ])("%d ms → %s", (ms, text) => {
    expect(formatTurnDuration(ms)).toBe(text);
  });

  it("clamps invalid input to 0s", () => {
    expect(formatTurnDuration(-5)).toBe("0s");
    expect(formatTurnDuration(Number.NaN)).toBe("0s");
  });
});

describe("formatCompactTokens", () => {
  it.each([
    [0, "0"],
    [12, "12"],
    [999, "999"],
    [1000, "1K"],
    [1234, "1.2K"],
    [12_345, "12K"],
    [999_999, "1000K"],
    [1_234_567, "1.2M"],
    [25_000_000, "25M"],
  ])("%d → %s", (n, text) => {
    expect(formatCompactTokens(n)).toBe(text);
  });
});

describe("buildTurnSummary", () => {
  it("uses turn-wide usage, not the latest request's context size", () => {
    const summary = buildTurnSummary({
      startedAt: 1000,
      endedAt: 4500,
      model: "deepseek-chat",
      stats: stats({
        promptTokens: 20,
        turnPromptTokens: 5000,
        turnCompletionTokens: 700,
        turnCacheHitTokens: 3000,
      }),
    });
    expect(summary).toEqual({
      durationMs: 3500,
      model: "deepseek-chat",
      promptTokens: 5000,
      completionTokens: 700,
      cacheHitTokens: 3000,
    });
  });

  it("omits token fields when the agent reports no usage (external ACP agents)", () => {
    const summary = buildTurnSummary({ startedAt: 0, endedAt: 2000, model: "Claude", stats: null });
    expect(summary).toEqual({ durationMs: 2000, model: "Claude" });
    expect("promptTokens" in summary).toBe(false);
  });

  it("omits token fields when every counter is zero", () => {
    const summary = buildTurnSummary({ startedAt: 0, endedAt: 10, stats: stats({}) });
    expect(summary).toEqual({ durationMs: 10 });
  });

  it("keeps output-only usage and drops a zero cache hit", () => {
    const summary = buildTurnSummary({
      startedAt: 0,
      endedAt: 10,
      stats: stats({ turnCompletionTokens: 9, turnCacheHitTokens: 0 }),
    });
    expect(summary).toEqual({ durationMs: 10, promptTokens: 0, completionTokens: 9 });
  });

  it("never yields a negative duration and trims a blank model", () => {
    const summary = buildTurnSummary({ startedAt: 5000, endedAt: 1000, model: "  " });
    expect(summary).toEqual({ durationMs: 0 });
  });
});
