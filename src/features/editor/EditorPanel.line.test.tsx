/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

// ---- mocks（模块级可变绑定 + 闭包延迟读取，同 registry.run.test.ts 模式）----
let cmProps: Record<string, unknown> | null = null;
vi.mock("@uiw/react-codemirror", () => ({
  default: (props: Record<string, unknown>) => {
    cmProps = props;
    return null;
  },
  EditorView: {
    theme: () => ({}),
    scrollIntoView: (pos: number, opts?: unknown) => ({ kind: "scroll", pos, opts }),
  },
}));
vi.mock("./editorSearch", () => ({ editorSearchExtensions: () => [] }));
vi.mock("./language", () => ({ languageExtensionsForPath: () => [] }));
vi.mock("../../commands/editorKeybindings", () => ({ registerFindBarAccessor: vi.fn() }));

let fsState: {
  openFiles: {
    path: string; content: string | null; isText: boolean; size: number;
    draft: string; dirty: boolean; stale: boolean; pinned: boolean;
  }[];
  activePath: string | null;
  error: string | null;
  pendingLine: { path: string; line: number } | null;
  setDraft: ReturnType<typeof vi.fn>;
  switchFile: ReturnType<typeof vi.fn>;
  closeFile: ReturnType<typeof vi.fn>;
  reloadEditor: ReturnType<typeof vi.fn>;
  dismissStale: ReturnType<typeof vi.fn>;
  clearError: ReturnType<typeof vi.fn>;
  consumePendingLine: ReturnType<typeof vi.fn>;
};
vi.mock("../../stores/fs.store", () => ({
  useFsStore: Object.assign(
    (sel?: (s: typeof fsState) => unknown) => (sel ? sel(fsState) : fsState),
    { getState: () => fsState },
  ),
}));

const uiState = { setEditorVisible: vi.fn() };
vi.mock("../../stores/ui.store", () => ({
  useUiStore: Object.assign(
    (sel?: (s: typeof uiState) => unknown) => (sel ? sel(uiState) : uiState),
    { getState: () => uiState },
  ),
}));

const projectState = { projects: [], activeProjectId: null };
vi.mock("../../stores/project.store", () => ({
  useProjectStore: Object.assign(
    (sel?: (s: typeof projectState) => unknown) => (sel ? sel(projectState) : projectState),
    { getState: () => projectState },
  ),
}));

import { EditorPanel } from "./EditorPanel";

function makeFakeView(lines: number) {
  const dispatch = vi.fn();
  const view = {
    dispatch,
    requestMeasure: vi.fn(),
    state: { doc: { lines, line: (n: number) => ({ from: (n - 1) * 10 }) } },
  };
  return { view, dispatch };
}

beforeEach(() => {
  cmProps = null;
  fsState = {
    openFiles: [{
      path: "/p/a.ts", content: "x", isText: true, size: 1,
      draft: "x", dirty: false, stale: false, pinned: true,
    }],
    activePath: "/p/a.ts",
    error: null,
    pendingLine: null,
    setDraft: vi.fn(),
    switchFile: vi.fn(),
    closeFile: vi.fn(),
    reloadEditor: vi.fn(),
    dismissStale: vi.fn(),
    clearError: vi.fn(),
    consumePendingLine: vi.fn(),
  };
});
afterEach(() => cleanup());

describe("EditorPanel pending-line targeting", () => {
  it("selects + scrolls to the pending line when the view is created", () => {
    fsState.pendingLine = { path: "/p/a.ts", line: 4 };
    render(<EditorPanel />);
    expect(cmProps).not.toBeNull();
    const { view, dispatch } = makeFakeView(10);
    (cmProps!.onCreateEditor as (v: unknown) => void)(view);
    // 第 4 行 → from = (4-1)*10 = 30
    expect(dispatch).toHaveBeenCalledWith({
      selection: { anchor: 30 },
      effects: { kind: "scroll", pos: 30, opts: { y: "center" } },
    });
    expect(fsState.consumePendingLine).toHaveBeenCalledTimes(1);
  });

  it("ignores a pending line that targets another file", () => {
    fsState.pendingLine = { path: "/p/other.ts", line: 2 };
    render(<EditorPanel />);
    const { view, dispatch } = makeFakeView(10);
    (cmProps!.onCreateEditor as (v: unknown) => void)(view);
    expect(dispatch).not.toHaveBeenCalled();
    expect(fsState.consumePendingLine).not.toHaveBeenCalled();
  });

  it("clamps an out-of-range line to the document end", () => {
    fsState.pendingLine = { path: "/p/a.ts", line: 99 };
    render(<EditorPanel />);
    const { view, dispatch } = makeFakeView(5);
    (cmProps!.onCreateEditor as (v: unknown) => void)(view);
    expect(dispatch).toHaveBeenCalledWith({
      selection: { anchor: 40 }, // 钳制到第 5 行 → from = 40
      effects: { kind: "scroll", pos: 40, opts: { y: "center" } },
    });
  });
});
