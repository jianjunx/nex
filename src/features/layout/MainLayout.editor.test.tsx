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
// data-workbench-surface 让 KeybindingHost 不让行，且左右留出两栏的宽度——
// 否则文件树在编辑器打开期间点不动也聚焦不了，树快捷键照样全灭。
describe("MainLayout editor surface", () => {
  beforeEach(() => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 1200,
    });
    useUiStore.setState({
      sidePanelVisible: true,
      sidePanelWidth: 320,
      sidebarWidth: 208,
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

  it("keeps the side panel clear of the editor overlay", () => {
    renderWithEditor();
    const dialog = document.querySelector<HTMLElement>("[role='dialog']");
    const style = dialog?.getAttribute("style") ?? "";
    // 左侧留出工作区侧栏，右侧留出侧栏面板——两边都不能被浮层盖住。
    expect(style).toContain("left: 220px");
    expect(style).toContain("right: 332px");
  });

  it("spans to the right edge when the side panel is hidden", () => {
    useUiStore.setState({ sidePanelVisible: false });
    renderWithEditor();
    const dialog = document.querySelector<HTMLElement>("[role='dialog']");
    expect(dialog?.getAttribute("style")).toContain("right: 12px");
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
