// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ChatComposer from "./beautiful-ui/ChatComposer";
import ThinkingState from "./beautiful-ui/ThinkingState";
import ApprovalCard from "./beautiful-ui/ApprovalCard";

afterEach(cleanup);

describe("Nex live UI adapters", () => {
  it("renders host interactions without starting preview timers", () => {
    vi.useFakeTimers();
    try {
      const onClick = vi.fn();
      const { container } = render(
        <ChatComposer>
          <ThinkingState>
            <ApprovalCard>
              <button onClick={onClick}>真实审批</button>
            </ApprovalCard>
          </ThinkingState>
        </ChatComposer>,
      );
      expect(container.querySelectorAll("[data-agent-ui]")).toHaveLength(3);
      expect(vi.getTimerCount()).toBe(0);
      fireEvent.click(screen.getByRole("button", { name: "真实审批" }));
      expect(onClick).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
