// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentLoadingIndicator } from "./AgentLoadingIndicator";
import { LOADING_PHRASE_POOLS, LOADING_ROTATE_MS, LONG_WAIT_TICKS } from "./loadingPhrases";

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0); // seed = 0，文案顺序可预测
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const visibleText = () => document.querySelector("[role=status]")?.textContent ?? "";

describe("AgentLoadingIndicator", () => {
  it("starts with a phrase for the given context", () => {
    render(<AgentLoadingIndicator context="after_run" />);
    expect(visibleText()).toContain(LOADING_PHRASE_POOLS.contexts.after_run[0]);
  });

  it("rotates to the next phrase on every interval", () => {
    render(<AgentLoadingIndicator context="start" />);
    const pool = LOADING_PHRASE_POOLS.contexts.start;
    act(() => {
      vi.advanceTimersByTime(LOADING_ROTATE_MS);
    });
    expect(visibleText()).toContain(pool[1]);
    act(() => {
      vi.advanceTimersByTime(LOADING_ROTATE_MS);
    });
    expect(visibleText()).toContain(pool[2]);
  });

  it("switches to long-wait phrases after waiting long enough", () => {
    render(<AgentLoadingIndicator context="after_read" />);
    act(() => {
      vi.advanceTimersByTime(LOADING_ROTATE_MS * LONG_WAIT_TICKS);
    });
    expect(visibleText()).toContain(LOADING_PHRASE_POOLS.longWait[0]);
  });

  it("exposes one stable accessible name and hides the rotating text from screen readers", () => {
    render(<AgentLoadingIndicator context="start" />);
    const status = screen.getByRole("status");
    expect(status.getAttribute("aria-label")).toBe("正在思考");
    const before = status.getAttribute("aria-label");
    act(() => {
      vi.advanceTimersByTime(LOADING_ROTATE_MS);
    });
    expect(status.getAttribute("aria-label")).toBe(before);
    const label = [...status.querySelectorAll("span")].find((s) =>
      s.textContent?.includes(LOADING_PHRASE_POOLS.contexts.start[1]),
    );
    expect(label?.getAttribute("aria-hidden")).toBe("true");
  });

  it("stops its timer on unmount", () => {
    const { unmount } = render(<AgentLoadingIndicator context="start" />);
    const before = vi.getTimerCount();
    unmount();
    expect(vi.getTimerCount()).toBeLessThan(before);
  });
});
