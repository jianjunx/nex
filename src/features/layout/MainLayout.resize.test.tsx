/**
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./TopBar", () => ({
  TopBar: () => <div data-testid="top-bar" />,
}));
vi.mock("./IconBar", () => ({
  IconBar: () => <div data-testid="icon-bar" />,
}));

import { MainLayout } from "./MainLayout";
vi.mock("./WorkspaceSidebar", () => ({
  WorkspaceSidebar: () => <div>projects</div>,
}));
import { useUiStore } from "../../stores/ui.store";

describe("MainLayout side-panel resize", () => {
  beforeEach(() => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 900,
    });
    useUiStore.setState({
      sidePanelVisible: true,
      sidePanelWidth: 500,
      editorWidth: 480,
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("starts from the painted width so the first pointermove follows the mouse", () => {
    render(
      <MainLayout
        mainContent={<div>chat</div>}
        editorPanel={null}
        sidePanel={<div>files</div>}
      />,
    );

    const pane = screen.getByTestId("side-pane");
    const painted = 900 - 228 - 280;
    expect(pane.style.width).toBe(`${painted}px`);
    expect(painted).toBeLessThan(500);

    const handle = screen.getByTestId("side-resize-handle");
    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 400 });
    window.dispatchEvent(
      new PointerEvent("pointermove", {
        pointerId: 1,
        clientX: 410,
        bubbles: true,
      }),
    );

    expect(pane.style.width).toBe(`${painted - 10}px`);
    expect(useUiStore.getState().sidePanelWidth).toBe(500);

    window.dispatchEvent(
      new PointerEvent("pointerup", {
        pointerId: 1,
        clientX: 410,
        bubbles: true,
      }),
    );
    expect(useUiStore.getState().sidePanelWidth).toBe(painted - 10);
  });

  it("drags the sidebar wider by up to 100px and persists it", () => {
    useUiStore.setState({ sidebarCollapsed: false, sidebarWidth: 228, sidePanelVisible: false });
    const { container } = render(
      <MainLayout mainContent={<div>chat</div>} editorPanel={null} sidePanel={<div>files</div>} />,
    );
    const root = container.firstElementChild as HTMLElement;
    expect(root.style.getPropertyValue("--nex-sidebar-w")).toBe("228px");

    fireEvent.pointerDown(screen.getByTestId("sidebar-resize-handle"), { pointerId: 2, clientX: 228 });
    window.dispatchEvent(new PointerEvent("pointermove", { pointerId: 2, clientX: 288, bubbles: true }));
    expect(root.style.getPropertyValue("--nex-sidebar-w")).toBe("288px");
    // Past +100px the width stops growing.
    window.dispatchEvent(new PointerEvent("pointerup", { pointerId: 2, clientX: 600, bubbles: true }));
    expect(useUiStore.getState().sidebarWidth).toBe(328);
  });

  it("has no sidebar handle while the sidebar is folded", () => {
    useUiStore.setState({ sidebarCollapsed: true });
    render(
      <MainLayout mainContent={<div>chat</div>} editorPanel={null} sidePanel={<div>files</div>} />,
    );
    expect(screen.queryByTestId("sidebar-resize-handle")).toBeNull();
    useUiStore.setState({ sidebarCollapsed: false });
  });

  it("opens files in a dialog without an editor split pane", () => {
    render(
      <MainLayout
        mainContent={<div>chat</div>}
        editorPanel={<div>file editor</div>}
        sidePanel={<div>files</div>}
      />,
    );
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.queryByTestId("editor-pane")).toBeNull();
    expect(screen.queryByTestId("editor-resize-handle")).toBeNull();
    // The close button lives in EditorPanel's tab row; Esc still dismisses.
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(useUiStore.getState().editorVisible).toBe(false);
  });
});
