import { describe, expect, it } from "vitest";
import { errorMessage } from "./errors";

describe("errorMessage", () => {
  it("prefers plain string messages", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
    expect(errorMessage({ message: "boom" })).toBe("boom");
  });

  it("unwraps nested tauri-style payloads", () => {
    expect(errorMessage({ error: { message: "nested boom" } })).toBe("nested boom");
    expect(errorMessage({ data: { details: "details boom" } })).toBe("details boom");
    expect(errorMessage({ cause: { error: { message: "deep boom" } } })).toBe("deep boom");
  });

  it("falls back to JSON instead of [object Object]", () => {
    expect(errorMessage({ type: "AgentNotInstalled", hint: "Install Codex" })).toBe(
      JSON.stringify({ type: "AgentNotInstalled", hint: "Install Codex" }),
    );
  });

  it("handles arrays and nullish values", () => {
    expect(errorMessage([new Error("a"), { message: "b" }])).toBe("a; b");
    expect(errorMessage(null)).toBe("未知错误");
    expect(errorMessage(undefined)).toBe("未知错误");
  });

  it("caps huge JSON fallbacks", () => {
    const huge = { kind: "AgentError", payload: "x".repeat(2000) };
    const msg = errorMessage(huge);
    expect(msg).toContain("AgentError");
    expect(msg).toContain("[error object truncated]");
    expect(msg.length).toBeLessThan(460);
  });
});
