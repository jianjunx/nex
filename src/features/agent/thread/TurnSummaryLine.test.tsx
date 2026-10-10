// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { TurnSummaryLine } from "./TurnSummaryLine";

afterEach(cleanup);

describe("TurnSummaryLine", () => {
  it("shows duration, tokens and model", () => {
    render(
      <TurnSummaryLine
        entry={{
          id: "s",
          kind: "turn_summary",
          timestamp: 1,
          durationMs: 83_000,
          model: "DeepSeek Chat",
          promptTokens: 12_345,
          completionTokens: 1234,
          cacheHitTokens: 8000,
        }}
      />,
    );
    const text = screen.getByTestId("turn-summary").textContent ?? "";
    expect(text).toContain("用时 1m 23s");
    expect(text).toContain("输入 12K / 输出 1.2K tokens");
    expect(text).toContain("DeepSeek Chat");
    const tokenSpan = screen.getByText(/输入 12K/);
    expect(tokenSpan.getAttribute("title")).toContain("缓存命中 8,000 tokens");
  });

  it("hides the token segment when the agent reports no usage", () => {
    render(
      <TurnSummaryLine
        entry={{ id: "s", kind: "turn_summary", timestamp: 1, durationMs: 2000, model: "Claude" }}
      />,
    );
    const text = screen.getByTestId("turn-summary").textContent ?? "";
    expect(text).toContain("用时 2s");
    expect(text).toContain("Claude");
    expect(text).not.toContain("tokens");
  });
});
