import { describe, expect, it } from "vitest";
import { mermaidConfigFor } from "./mermaidTheme";

describe("mermaidConfigFor", () => {
  it("uses high-contrast sequence arrow colors on dark theme", () => {
    const cfg = mermaidConfigFor("dark");
    expect(cfg.themeVariables?.signalColor).toBe("#cbd5e1");
    expect(cfg.themeVariables?.signalTextColor).toBe("#f8fafc");
  });

  it("uses readable sequence arrow colors on light theme", () => {
    const cfg = mermaidConfigFor("light");
    expect(cfg.themeVariables?.signalColor).toBe("#475569");
    expect(cfg.themeVariables?.signalTextColor).toBe("#0f172a");
  });
});
