/**
 * @vitest-environment jsdom
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./TopBar", () => ({
  TopBar: () => <div data-testid="top-bar" />,
}));

import { MainLayout } from "./MainLayout";
vi.mock("./WorkspaceSidebar", () => ({
  WorkspaceSidebar: () => <div>projects</div>,
}));
import { useUiStore } from "../../stores/ui.store";
import { useFsStore } from "../../stores/fs.store";

// 编辑器浮层必须是"非模态的工作台面板"：modal=false 不锁焦点，
// data-workbench-surface 让 KeybindingHost 不让行。尺寸保持 92vw 居中，
// 不为了给侧栏让位而把编辑器压窄。
describe("MainLayout editor surface", () => {
  beforeEach(() => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 1200,
    });
    useUiStore.setState({
      sidePanelVisible: true,
      sidePanelWidth: 320,
      sidebarWidth: 228,
      sidebarCollapsed: false,
    });
    useFsStore.setState({ openFiles: [], activePath: null });
  });

  afterEach(() => {
    cleanup();
  });

  function renderWithEditor() {
    useFsStore.setState({
      openFiles: [
        {
          path: "/p/a.ts",
          content: "",
          draft: "",
          isText: true,
          size: 0,
          dirty: false,
          stale: false,
          pinned: true,
        },
      ],
      activePath: "/p/a.ts",
    });
    return render(
      <MainLayout
        mainContent={<div>chat</div>}
        editorPanel={<div data-testid="editor-panel">editor</div>}
        sidePanel={<div data-testid="side-panel-body">files</div>}
      />,
    );
  }

  it("marks the editor dialog as a workbench surface", () => {
    renderWithEditor();
    const dialog = document.querySelector<HTMLElement>("[role='dialog']");
    expect(dialog).toBeTruthy();
    expect(dialog?.hasAttribute("data-workbench-surface")).toBe(true);
    expect(screen.getByTestId("editor-panel")).toBeTruthy();
  });

  it("keeps the original 92vw centred sizing", () => {
    renderWithEditor();
    const dialog = document.querySelector<HTMLElement>("[role='dialog']");
    expect(dialog?.className).toContain("w-[92vw]");
    expect(dialog?.className).toContain("max-w-[1200px]");
    // 不写内联 left/right：那是把编辑器压成主列宽度的旧写法
    expect(dialog?.getAttribute("style")).toBeNull();
  });

  it("renders no editor dialog when no file is open", () => {
    render(
      <MainLayout
        mainContent={<div>chat</div>}
        editorPanel={null}
        sidePanel={<div>files</div>}
      />,
    );
    expect(document.querySelector("[role='dialog']")).toBeNull();
  });
});
