/**
 * @vitest-environment jsdom
 *
 * 回归测试：真实 fs.store + 真实 CodeMirror，模拟「点击搜索结果 →
 * openFile({line})」全链路，断言光标落到目标行。
 *
 * 覆盖的核心竞态：切换到另一个已打开文件时 CodeMirror 按 key 重建，
 * 父组件 effect 会先于新视图创建、拿着旧文件的 viewRef 跑——
 * 若提前消费 pendingLine，新视图光标会停在文件开头（见
 * EditorPanel.applyPendingLine 的 ownerPath 守卫）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";

const fsReadFile = vi.fn();

vi.mock("../../bridge/tauri", () => ({
  fsReadFile: (...args: unknown[]) => fsReadFile(...args),
  fsWriteFile: vi.fn(),
  fsSearch: vi.fn(),
  fsSearchReplace: vi.fn(),
  fsApplyReplace: vi.fn(),
  fsReadTree: vi.fn(),
  fsExpandDir: vi.fn(),
  fsCreateFile: vi.fn(),
  fsCreateDir: vi.fn(),
}));

vi.mock("../../stores/ui.store", () => ({
  useUiStore: Object.assign(() => ({}), {
    getState: () => ({ setEditorVisible: vi.fn(), syncEditorVisibleForProject: vi.fn() }),
  }),
}));

vi.mock("../../stores/settings.store", () => ({
  useSettingsStore: Object.assign((sel?: (s: Record<string, unknown>) => unknown) => {
    const s = {
      theme: "dark",
      editorWordWrap: false,
      editorWrapColumn: 120,
      editorAutoSave: false,
    };
    return sel ? sel(s) : s;
  }, {
    getState: () => ({ editorAutoSave: false }),
  }),
}));

vi.mock("../../stores/project.store", () => ({
  useProjectStore: Object.assign((sel?: (s: Record<string, unknown>) => unknown) => {
    const s = { projects: [{ id: "p1", path: "/p" }], activeProjectId: "p1" };
    return sel ? sel(s) : s;
  }, {
    getState: () => ({ projects: [{ id: "p1", path: "/p" }], activeProjectId: "p1" }),
  }),
}));

vi.mock("../../commands/editorKeybindings", () => ({ registerFindBarAccessor: vi.fn() }));

import { EditorView } from "@codemirror/view";
import { useFsStore } from "../../stores/fs.store";
import { EditorPanel } from "./EditorPanel";

// CodeMirror 的视口测量会在 rAF 回调里调 Range.getClientRects，jsdom 未
// 实现——stub 成空列表保持输出干净（光标位置由 state 决定，与测量无关）。
Range.prototype.getClientRects = () => [] as unknown as DOMRectList;

const CONTENT = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join("\n");

beforeEach(() => {
  vi.clearAllMocks();
  fsReadFile.mockResolvedValue({ content: CONTENT, is_text: true, size: CONTENT.length });
  useFsStore.setState({
    openFiles: [],
    activePath: null,
    error: null,
    loading: false,
    pendingLine: null,
  });
});
afterEach(() => cleanup());

function findView(): EditorView | null {
  const el = document.querySelector(".cm-editor");
  return el instanceof HTMLElement ? EditorView.findFromDOM(el) : null;
}

describe("search-result jump (real CodeMirror)", () => {
  it("openFile({line}) moves the selection to that line", async () => {
    render(<EditorPanel />);
    await useFsStore.getState().openFile("/p/a.ts", { line: 25 });
    await waitFor(() => {
      const view = findView();
      expect(view).not.toBeNull();
      const pos = view!.state.selection.main.anchor;
      expect(pos).toBe(view!.state.doc.line(25).from);
    });
  });

  it("second jump within the same open file moves the selection again", async () => {
    render(<EditorPanel />);
    await useFsStore.getState().openFile("/p/a.ts", { line: 25 });
    await waitFor(() => expect(findView()).not.toBeNull());
    await useFsStore.getState().openFile("/p/a.ts", { line: 40, pin: true });
    await waitFor(() => {
      const view = findView();
      expect(view!.state.selection.main.anchor).toBe(view!.state.doc.line(40).from);
    });
  });

  it("jumping to another already-open file switches and targets its line", async () => {
    render(<EditorPanel />);
    await useFsStore.getState().openFile("/p/a.ts", { pin: true });
    await useFsStore.getState().openFile("/p/b.ts", { pin: true });
    await waitFor(() => expect(findView()).not.toBeNull());
    await useFsStore.getState().openFile("/p/a.ts", { line: 7 });
    await waitFor(() => {
      const view = findView();
      expect(view!.state.selection.main.anchor).toBe(view!.state.doc.line(7).from);
    });
  });
});
