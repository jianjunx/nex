/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";

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
