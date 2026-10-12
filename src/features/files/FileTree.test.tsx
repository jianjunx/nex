/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, act } from "@testing-library/react";

vi.mock("../../lib/osDragDrop", () => ({
  useOsDragDrop: () => {},
}));

vi.mock("../../lib/usePointerDrag", () => ({
  usePointerDrag: () => ({
    payload: null,
    start: () => () => {},
    ghostRef: { current: null },
  }),
}));

vi.mock("../../lib/composerAttach", () => ({
  attachToComposer: vi.fn(),
}));

vi.mock("./TreeContextMenu", () => ({
  TreeContextMenu: () => null,
}));

vi.mock("../git/GitConfirmDialog", () => ({
  GitConfirmDialog: () => null,
}));

import { FileTree } from "./FileTree";
import { useFsStore } from "../../stores/fs.store";
import { useProjectStore } from "../../stores/project.store";
import { useUiStore } from "../../stores/ui.store";

const PROJECT = {
  id: "p1",
  name: "Demo",
  path: "/tmp/demo",
  created_at: 0,
  last_opened: 0,
};

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });

  useProjectStore.setState({
    projects: [PROJECT],
    activeProjectId: PROJECT.id,
  });

  useFsStore.setState({
    nodesByDir: {
      [PROJECT.path]: [
        { name: "src", path: `${PROJECT.path}/src`, is_dir: true },
        { name: "a.ts", path: `${PROJECT.path}/a.ts`, is_dir: false },
      ],
      [`${PROJECT.path}/src`]: [
        { name: "nested.ts", path: `${PROJECT.path}/src/nested.ts`, is_dir: false },
      ],
    },
    expandedDirs: new Set([PROJECT.path, `${PROJECT.path}/src`]),
    selectedPath: PROJECT.path,
    pendingRenamePath: null,
    pendingDeletePath: null,
    openFiles: [],
    loadRoot: vi.fn().mockResolvedValue(undefined),
    expandDir: vi.fn().mockResolvedValue(undefined),
    refreshDir: vi.fn().mockResolvedValue(undefined),
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("FileTree keyboard navigation", () => {
  it("ArrowDown / ArrowUp move selection across visible files and folders like VS Code", () => {
    const { container } = render(<FileTree />);

    const root = container.querySelector<HTMLElement>(`[data-dir-path="${PROJECT.path}"]`);
    const src = container.querySelector<HTMLElement>(`[data-dir-path="${PROJECT.path}/src"]`);
    const nested = container.querySelector<HTMLElement>(`[data-file-path="${PROJECT.path}/src/nested.ts"]`);
    const file = container.querySelector<HTMLElement>(`[data-file-path="${PROJECT.path}/a.ts"]`);

    expect(root).toBeTruthy();
    expect(src).toBeTruthy();
    expect(nested).toBeTruthy();
    expect(file).toBeTruthy();

    root?.focus();
    fireEvent.keyDown(root as HTMLElement, { key: "ArrowDown" });
    expect(useFsStore.getState().selectedPath).toBe(`${PROJECT.path}/src`);
    expect(document.activeElement).toBe(src);

    fireEvent.keyDown(src as HTMLElement, { key: "ArrowDown" });
    expect(useFsStore.getState().selectedPath).toBe(`${PROJECT.path}/src/nested.ts`);
    expect(document.activeElement).toBe(nested);

    fireEvent.keyDown(nested as HTMLElement, { key: "ArrowDown" });
    expect(useFsStore.getState().selectedPath).toBe(`${PROJECT.path}/a.ts`);
    expect(document.activeElement).toBe(file);

    fireEvent.keyDown(file as HTMLElement, { key: "ArrowUp" });
    expect(useFsStore.getState().selectedPath).toBe(`${PROJECT.path}/src/nested.ts`);
    expect(document.activeElement).toBe(nested);
  });
});

describe("FileTree open gesture", () => {
  const filePath = `${PROJECT.path}/a.ts`;

  it("single click selects without opening the editor", () => {
    const openFile = vi.fn().mockResolvedValue(undefined);
    useFsStore.setState({ openFile, selectedPath: PROJECT.path });
    const { container } = render(<FileTree />);

    const file = container.querySelector<HTMLElement>(`[data-file-path="${filePath}"]`);
    fireEvent.click(file as HTMLElement);

    expect(openFile).not.toHaveBeenCalled();
    expect(useFsStore.getState().selectedPath).toBe(filePath);
  });

  it("double click opens the file as a pinned tab", () => {
    const openFile = vi.fn().mockResolvedValue(undefined);
    useFsStore.setState({ openFile, selectedPath: PROJECT.path });
    const { container } = render(<FileTree />);

    const file = container.querySelector<HTMLElement>(`[data-file-path="${filePath}"]`);
    fireEvent.doubleClick(file as HTMLElement);

    expect(openFile).toHaveBeenCalledTimes(1);
    expect(openFile).toHaveBeenCalledWith(filePath, true);
  });

  it("single click still toggles folder expansion", () => {
    const expandDir = vi.fn().mockResolvedValue(undefined);
    useFsStore.setState({ expandDir, openFile: vi.fn() });
    const { container } = render(<FileTree />);

    // `src` starts expanded in the fixture, so a click must collapse it.
    const collapseDir = vi.fn().mockResolvedValue(undefined);
    useFsStore.setState({ collapseDir });

    const src = container.querySelector<HTMLElement>(`[data-dir-path="${PROJECT.path}/src"]`);
    fireEvent.click(src as HTMLElement);

    expect(collapseDir).toHaveBeenCalledWith(`${PROJECT.path}/src`);
    expect(expandDir).not.toHaveBeenCalled();
  });

  it("Enter opens the focused file (keyboard equivalent of double click)", () => {
    const openFile = vi.fn().mockResolvedValue(undefined);
    useFsStore.setState({ openFile });
    const { container } = render(<FileTree />);

    const file = container.querySelector<HTMLElement>(`[data-file-path="${filePath}"]`);
    fireEvent.keyDown(file as HTMLElement, { key: "Enter" });

    expect(openFile).toHaveBeenCalledWith(filePath, true);
  });
});

// files.focus（Cmd/Ctrl+Shift+E）光切 tab 不够：files.rename 的 when() 要求
// activeElement 落在树行内，否则 F2 / Enter 重命名依旧没反应。
describe("FileTree focus request", () => {
  it("moves DOM focus to the selected row", () => {
    useFsStore.setState({ selectedPath: `${PROJECT.path}/a.ts` });
    useUiStore.setState({ filesFocusRequest: 0 });
    const { container } = render(<FileTree />);

    act(() => { useUiStore.setState({ filesFocusRequest: 1 }); });

    const file = container.querySelector<HTMLElement>(`[data-file-path="${PROJECT.path}/a.ts"]`);
    expect(document.activeElement).toBe(file);
  });

  it("falls back to the first row when nothing is selected", () => {
    useFsStore.setState({ selectedPath: null });
    useUiStore.setState({ filesFocusRequest: 0 });
    const { container } = render(<FileTree />);

    act(() => { useUiStore.setState({ filesFocusRequest: 1 }); });

    const root = container.querySelector<HTMLElement>(`[data-dir-path="${PROJECT.path}"]`);
    expect(document.activeElement).toBe(root);
  });
});
