import { describe, expect, it } from "vitest";
import type { ContextUsage } from "./types";
import { usageCounters, usageDelta } from "./turnUsage";

function usage(tokens: ContextUsage["tokens"], used = 0, total = 0): ContextUsage {
  return { used, total, tokens };
}

describe("usageCounters", () => {
  it("buckets the common ACP token types", () => {
    expect(
      usageCounters(
        usage([
          { type: "input", value: 40_000 },
          { type: "output", value: 2_000 },
          { type: "cache_read", value: 12_000 },
        ]),
      ),
    ).toEqual({ input: 40_000, output: 2_000, cache: 12_000 });
  });

  it("accepts provider-specific spellings and cache_write style names", () => {
    expect(
      usageCounters(
        usage([
          { type: "prompt_tokens", value: 10 },
          { type: "completion_tokens", value: 3 },
          { type: "token", name: "cache_creation_input_tokens", value: 7 },
        ]),
      ),
    ).toEqual({ input: 10, output: 3, cache: 7 });
  });

  it("ignores unrecognised breakdown entries", () => {
    expect(usageCounters(usage([{ type: "reasoning", value: 5 }]))).toBeNull();
  });

  it("falls back to `used` when there is no breakdown", () => {
    expect(usageCounters(usage([], 42_000, 200_000))).toEqual({
      input: 42_000,
      output: 0,
      cache: 0,
    });
  });

  it("returns null when the agent reports nothing usable", () => {
    expect(usageCounters(null)).toBeNull();
    expect(usageCounters(usage([], 0, 0))).toBeNull();
  });
});

describe("usageDelta", () => {
  it("subtracts the baseline so session history is not billed to this turn", () => {
    expect(
      usageDelta({ input: 5_000, output: 700, cache: 3_000 }, { input: 4_000, output: 500, cache: 3_000 }),
    ).toEqual({ input: 1_000, output: 200, cache: 0 });
  });

  it("treats the first report of a turn as usage from zero", () => {
    expect(usageDelta({ input: 900, output: 100, cache: 0 }, null)).toEqual({
      input: 900,
      output: 100,
      cache: 0,
    });
  });

  it("clamps a falling counter (context compaction) instead of going negative", () => {
    expect(usageDelta({ input: 100, output: 5, cache: 0 }, { input: 9_000, output: 5, cache: 0 })).toEqual({
      input: 0,
      output: 0,
      cache: 0,
    });
  });

  it("returns null when the agent never reported usage", () => {
    expect(usageDelta(null, { input: 1, output: 1, cache: 0 })).toBeNull();
    expect(usageDelta(null, null)).toBeNull();
  });
});
