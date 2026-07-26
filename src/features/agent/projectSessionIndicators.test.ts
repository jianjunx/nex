import { describe, expect, it } from "vitest";
import { projectSessionIndicators } from "./projectSessionIndicators";

describe("projectSessionIndicators", () => {
  it("returns false/false when no ids or all idle/missing", () => {
    expect(projectSessionIndicators([], {})).toEqual({ hasRunning: false, hasWaiting: false });
    expect(
      projectSessionIndicators(["a"], { a: { status: "idle" } }),
    ).toEqual({ hasRunning: false, hasWaiting: false });
    expect(projectSessionIndicators(["a"], {})).toEqual({ hasRunning: false, hasWaiting: false });
  });

  it("detects running and waiting independently and together", () => {
    expect(
      projectSessionIndicators(["a", "b"], {
        a: { status: "running" },
        b: { status: "idle" },
      }),
    ).toEqual({ hasRunning: true, hasWaiting: false });

    expect(
      projectSessionIndicators(["a", "b"], {
        a: { status: "waiting" },
        b: { status: "idle" },
      }),
    ).toEqual({ hasRunning: false, hasWaiting: true });

    expect(
      projectSessionIndicators(["a", "b"], {
        a: { status: "running" },
        b: { status: "waiting" },
      }),
    ).toEqual({ hasRunning: true, hasWaiting: true });
  });
});
