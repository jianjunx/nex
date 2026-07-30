/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";

// mock detectPlatform 以按用例切换平台；可变绑定在渲染期延迟读取。
let platform: "mac" | "other" = "other";
vi.mock("../../commands/types", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../commands/types")>();
  return { ...actual, detectPlatform: () => platform };
});

const setMock = vi.fn();
const getMock = vi.fn();
vi.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: class {
    constructor() {}
    get = (...a: unknown[]) => getMock(...a);
    set = (...a: unknown[]) => setMock(...a);
  },
}));

import { KeybindingsEditor } from "./KeybindingsEditor";
import { useKeybindingsStore } from "../../stores/keybindings.store";
import { isRecordingActive, setRecordingActive } from "./recordingState";

beforeEach(() => {
  platform = "other";
  vi.clearAllMocks();
  getMock.mockResolvedValue(undefined);
  setMock.mockResolvedValue(undefined);
  useKeybindingsStore.setState({ loaded: true, overrides: {} });
});

afterEach(() => {
  document.body.innerHTML = "";
  setRecordingActive(false);
});

/** 打开指定命令行的录制器，返回"请按键…" span。 */
function startRecording(commandTitle: string): HTMLElement {
  render(<KeybindingsEditor />);
  const row = screen.getByText(commandTitle).closest(".grid")!;
  fireEvent.click(within(row as HTMLElement).getByTitle("改键"));
  return screen.getByText("请按键…");
}

describe("KeybindingsEditor recording", () => {
  it("records a combo and stores the override", () => {
    const rec = startRecording("保存文件");
    fireEvent.keyDown(rec, { key: "k", code: "KeyK", ctrlKey: true });
    expect(useKeybindingsStore.getState().overrides["editor.save"]).toBe("primary+keyk");
    expect(screen.queryByText("请按键…")).toBeNull(); // 录制器已收起
  });

  it("rejects a bare printable key with a hint", () => {
    const rec = startRecording("保存文件");
    fireEvent.keyDown(rec, { key: "k", code: "KeyK" });
    expect(screen.getByText(/需包含 Ctrl/)).toBeTruthy();
    expect(useKeybindingsStore.getState().overrides["editor.save"]).toBeUndefined();
    expect(screen.getByText("请按键…")).toBeTruthy(); // 仍在录制
  });

  it("Escape cancels recording without saving and clears the flag", () => {
    const rec = startRecording("保存文件");
    expect(isRecordingActive()).toBe(true);
    fireEvent.keyDown(rec, { key: "Escape", code: "Escape" });
    expect(screen.queryByText("请按键…")).toBeNull();
    expect(useKeybindingsStore.getState().overrides["editor.save"]).toBeUndefined();
    expect(isRecordingActive()).toBe(false);
  });

  it("blur cancels recording (M-4)", () => {
    const rec = startRecording("保存文件");
    fireEvent.blur(rec);
    expect(screen.queryByText("请按键…")).toBeNull();
    expect(useKeybindingsStore.getState().overrides["editor.save"]).toBeUndefined();
    expect(isRecordingActive()).toBe(false);
  });

  it("mac: bare Ctrl is NOT primary — rejected as bare printable (M-3)", () => {
    platform = "mac";
    const rec = startRecording("保存文件");
    fireEvent.keyDown(rec, { key: "k", code: "KeyK", ctrlKey: true, metaKey: false });
    expect(screen.getByText(/需包含 Ctrl/)).toBeTruthy();
    expect(useKeybindingsStore.getState().overrides["editor.save"]).toBeUndefined();
  });

  it("mac: Cmd records as primary (M-3)", () => {
    platform = "mac";
    const rec = startRecording("保存文件");
    fireEvent.keyDown(rec, { key: "k", code: "KeyK", metaKey: true });
    expect(useKeybindingsStore.getState().overrides["editor.save"]).toBe("primary+keyk");
  });

  it("shows the conflict banner naming the other command (M-10)", () => {
    // editor.close 录成 editor.save 的默认键 primary+keys → 冲突横幅点名「保存文件」
    const rec = startRecording("关闭编辑器面板");
    fireEvent.keyDown(rec, { key: "s", code: "KeyS", ctrlKey: true });
    expect(screen.getByText(/该键位与「保存文件」冲突/)).toBeTruthy();
    expect(useKeybindingsStore.getState().overrides["editor.close"]).toBe("primary+keys");
  });
});
