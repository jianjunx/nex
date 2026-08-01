/**
 * @vitest-environment jsdom
 */
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

// 六个分区组件各自依赖 store/时间线，全部打桩成可识别文本
//（section targeting 用例按 testid 断言当前分区）。
vi.mock("./sections/AppearanceSection", () => ({ AppearanceSection: () => <div data-testid="sec">外观</div> }));
vi.mock("./sections/EditorSection", () => ({ EditorSection: () => <div data-testid="sec">编辑器</div> }));
vi.mock("./sections/TerminalSection", () => ({ TerminalSection: () => <div data-testid="sec">终端</div> }));
vi.mock("./sections/AgentsSection", () => ({ AgentsSection: () => <div data-testid="sec">智能体</div> }));
vi.mock("./sections/LayoutSection", () => ({ LayoutSection: () => <div data-testid="sec">布局</div> }));
vi.mock("./KeybindingsEditor", () => ({ KeybindingsEditor: () => <div data-testid="sec">快捷键</div> }));

import { SettingsDialog } from "./SettingsDialog";
import { setRecordingActive } from "./recordingState";
import { useUiStore } from "../../stores/ui.store";

beforeEach(() => {
  useUiStore.setState({ settingsOpen: true });
});
afterEach(() => {
  cleanup();
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

describe("SettingsDialog section targeting", () => {
  it("defaults to the appearance section", () => {
    render(<SettingsDialog />);
    expect(screen.getByTestId("sec").textContent).toBe("外观");
  });

  it("consumes a one-shot settingsSection on open", () => {
    useUiStore.setState({ settingsSection: "agents" });
    render(<SettingsDialog />);
    expect(screen.getByTestId("sec").textContent).toBe("智能体");
    expect(useUiStore.getState().settingsSection).toBeNull();
  });

  it("a plain reopen returns to appearance even after the tab was changed (R2)", () => {
    render(<SettingsDialog />);
    // 现有导航是原生 <button onClick> 页签（非 Radix Tabs），click 即切换页签。
    fireEvent.click(screen.getByRole("button", { name: "智能体" }));
    expect(screen.getByTestId("sec").textContent).toBe("智能体");
    act(() => useUiStore.setState({ settingsOpen: false }));
    act(() => useUiStore.setState({ settingsOpen: true }));
    expect(screen.getByTestId("sec").textContent).toBe("外观");
  });
});
