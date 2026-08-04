/**
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TextEditContextMenu } from "./TextEditContextMenu";

afterEach(() => {
  cleanup();
});

describe("TextEditContextMenu", () => {
  it("opens a menu on right-click without blanking the surrounding UI", () => {
    const onError = vi.fn();
    window.addEventListener("error", onError);

    render(
      <div data-testid="app-shell">
        <p data-testid="shell-label">still here</p>
        <TextEditContextMenu>
          <textarea data-testid="composer" defaultValue="hello" />
        </TextEditContextMenu>
      </div>,
    );

    fireEvent.contextMenu(screen.getByTestId("composer"), {
      clientX: 200,
      clientY: 200,
      bubbles: true,
    });

    expect(screen.getByTestId("shell-label")).toBeTruthy();
    expect(screen.getByTestId("app-shell").textContent).toContain("still here");
    const menu = screen.getByTestId("text-edit-context-menu");
    expect(menu).toBeTruthy();
    expect(screen.getByText("复制")).toBeTruthy();
    expect(screen.getByText("粘贴")).toBeTruthy();

    // Composer: X at click (opens to the right), Y vertically centered (est. H=132).
    expect(menu.style.left).toBe("200px");
    expect(menu.style.top).toBe("134px");

    // Radix modal menus aria-hide the app; ours must not.
    expect(screen.getByTestId("app-shell").getAttribute("aria-hidden")).toBeNull();
    expect(onError).not.toHaveBeenCalled();

    window.removeEventListener("error", onError);
  });

  it("closes when DropdownMenu requests close", () => {
    render(
      <TextEditContextMenu>
        <textarea data-testid="composer" defaultValue="hello" />
      </TextEditContextMenu>,
    );

    fireEvent.contextMenu(screen.getByTestId("composer"), {
      clientX: 10,
      clientY: 10,
      bubbles: true,
    });
    expect(screen.getByTestId("text-edit-context-menu")).toBeTruthy();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByTestId("text-edit-context-menu")).toBeNull();
  });
});
