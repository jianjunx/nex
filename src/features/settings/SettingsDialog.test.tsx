/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

// Sections pull in heavy stores (agent/tauri bridge); none are under test here.
vi.mock("./sections/AppearanceSection", () => ({ AppearanceSection: () => <div /> }));
vi.mock("./sections/EditorSection", () => ({ EditorSection: () => <div /> }));
vi.mock("./sections/TerminalSection", () => ({ TerminalSection: () => <div /> }));
vi.mock("./sections/AgentsSection", () => ({ AgentsSection: () => <div /> }));
vi.mock("./sections/LayoutSection", () => ({ LayoutSection: () => <div /> }));
vi.mock("./KeybindingsEditor", () => ({ KeybindingsEditor: () => <div /> }));

import { SettingsDialog } from "./SettingsDialog";
import { setRecordingActive } from "./recordingState";
import { useUiStore } from "../../stores/ui.store";

beforeEach(() => {
  useUiStore.setState({ settingsOpen: true });
});
afterEach(() => {
  useUiStore.setState({ settingsOpen: false });
  setRecordingActive(false);
});

describe("SettingsDialog Esc handling", () => {
  it("stays open on Esc while a key recording is active", () => {
    render(<SettingsDialog />);
    expect(screen.getByRole("dialog")).toBeTruthy();
    setRecordingActive(true);
    fireEvent.keyDown(document.body, { key: "Escape", code: "Escape" });
    expect(useUiStore.getState().settingsOpen).toBe(true);
  });

  it("closes on Esc when no recording is active", () => {
    render(<SettingsDialog />);
    fireEvent.keyDown(document.body, { key: "Escape", code: "Escape" });
    expect(useUiStore.getState().settingsOpen).toBe(false);
  });
});
