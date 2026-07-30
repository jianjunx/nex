import { describe, expect, it } from "vitest";
import { sanitizeSidePanelTab, useUiStore } from "./ui.store";

describe("ui.store settings dialog flag", () => {
  it("opens, closes, toggles settings", () => {
    useUiStore.setState({ settingsOpen: false });
    useUiStore.getState().openSettings();
    expect(useUiStore.getState().settingsOpen).toBe(true);
    useUiStore.getState().toggleSettings();
    expect(useUiStore.getState().settingsOpen).toBe(false);
    useUiStore.getState().toggleSettings();
    expect(useUiStore.getState().settingsOpen).toBe(true);
    useUiStore.getState().closeSettings();
    expect(useUiStore.getState().settingsOpen).toBe(false);
  });
});

describe("sanitizeSidePanelTab", () => {
  it("returns valid tabs unchanged", () => {
    expect(sanitizeSidePanelTab("files")).toBe("files");
    expect(sanitizeSidePanelTab("git")).toBe("git");
    expect(sanitizeSidePanelTab("search")).toBe("search");
  });

  it('falls back to "files" for stale "settings" value', () => {
    expect(sanitizeSidePanelTab("settings")).toBe("files");
  });

  it('falls back to "files" for arbitrary/invalid values', () => {
    expect(sanitizeSidePanelTab("whatever")).toBe("files");
    expect(sanitizeSidePanelTab("")).toBe("files");
    expect(sanitizeSidePanelTab(null)).toBe("files");
    expect(sanitizeSidePanelTab(undefined)).toBe("files");
  });
});
