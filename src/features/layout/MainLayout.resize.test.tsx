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
    const painted = 900 - 208 - 280;
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
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(useUiStore.getState().editorVisible).toBe(false);
  });
});
