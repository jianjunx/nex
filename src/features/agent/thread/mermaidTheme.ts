import type { MermaidConfig } from "mermaid";

/** Mermaid theme tuned for Nex dark/light workbench surfaces. */
export function mermaidConfigFor(theme: "light" | "dark"): MermaidConfig {
  if (theme === "dark") {
    return {
      startOnLoad: false,
      securityLevel: "strict",
      theme: "base",
      themeVariables: {
        darkMode: true,
        background: "transparent",
        primaryColor: "#334155",
        primaryTextColor: "#f1f5f9",
        primaryBorderColor: "#64748b",
        secondaryColor: "#475569",
        secondaryTextColor: "#e2e8f0",
        tertiaryColor: "#3f3f46",
        tertiaryTextColor: "#cbd5e1",
        lineColor: "#94a3b8",
        textColor: "#f1f5f9",
        mainBkg: "#334155",
        actorBkg: "#334155",
        actorBorder: "#64748b",
        actorTextColor: "#f8fafc",
        actorLineColor: "#64748b",
        /** Sequence-diagram arrow strokes — must stay light on dark panels. */
        signalColor: "#cbd5e1",
        /** Labels on sequence-diagram arrows. */
        signalTextColor: "#f8fafc",
        labelBoxBkgColor: "#475569",
        labelBoxBorderColor: "#64748b",
        labelTextColor: "#f8fafc",
        noteBkgColor: "#475569",
        noteTextColor: "#f8fafc",
        noteBorderColor: "#64748b",
        activationBorderColor: "#94a3b8",
        activationBkgColor: "#475569",
      },
    };
  }

  return {
    startOnLoad: false,
    securityLevel: "strict",
    theme: "base",
    themeVariables: {
      darkMode: false,
      background: "transparent",
      primaryColor: "#e2e8f0",
      primaryTextColor: "#1e293b",
      primaryBorderColor: "#94a3b8",
      secondaryColor: "#f1f5f9",
      secondaryTextColor: "#334155",
      lineColor: "#64748b",
      textColor: "#1e293b",
      mainBkg: "#f1f5f9",
      actorBkg: "#f1f5f9",
      actorBorder: "#94a3b8",
      actorTextColor: "#0f172a",
      actorLineColor: "#94a3b8",
      signalColor: "#475569",
      signalTextColor: "#0f172a",
      labelBoxBkgColor: "#e2e8f0",
      labelBoxBorderColor: "#94a3b8",
      labelTextColor: "#0f172a",
      noteBkgColor: "#e2e8f0",
      noteTextColor: "#0f172a",
      noteBorderColor: "#94a3b8",
      activationBorderColor: "#64748b",
      activationBkgColor: "#e2e8f0",
    },
  };
}
