import { describe, expect, it } from "vitest";
import { sanitizeSidePanelTab, useUiStore } from "./ui.store";

describe("ui.store settings dialog flag", () => {
  it("opens and closes settings", () => {
    useUiStore.setState({ settingsOpen: false });
    useUiStore.getState().openSettings();
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

describe("search focus request counter", () => {
  it("requestSearchFocus switches to the search tab, shows the panel and bumps the counter", () => {
    const before = useUiStore.getState().searchFocusRequest;
    useUiStore.setState({ sidePanelTab: "files", sidePanelVisible: false });
    useUiStore.getState().requestSearchFocus();
    const s = useUiStore.getState();
    expect(s.sidePanelTab).toBe("search");
    expect(s.sidePanelVisible).toBe(true);
    expect(s.searchFocusRequest).toBe(before + 1);
    // 连续触发必须继续自增（计数而非布尔黏滞）
    useUiStore.getState().requestSearchFocus();
    expect(useUiStore.getState().searchFocusRequest).toBe(before + 2);
  });
});
