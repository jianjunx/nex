/**
 * @vitest-environment jsdom
 */
// src/commands/KeybindingHost.test.tsx
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { KeybindingHost, isInputContext } from "./KeybindingHost";

vi.mock("../stores/keybindings.store", () => ({
  useKeybindingsStore: {
    getState: () => ({
      loaded: true,
      resolve: (id: string) => {
        // Mirror a couple of defaults so the host can match without the real registry store.
        if (id === "view.toggleSidebar") return { primary: true, key: "keyb" };
        if (id === "editor.save") return { primary: true, key: "keys" };
        if (id === "editor.close") return { key: "escape" };
        return null;
      },
    }),
  },
}));

const toggle = vi.fn();
const save = vi.fn();
const close = vi.fn();
vi.mock("../commands/registry", () => ({
  listCommands: () => [
    { id: "view.toggleSidebar", title: "t", category: "c", defaultKey: null, run: toggle },
    { id: "editor.save", title: "s", category: "c", defaultKey: null, run: save },
    { id: "editor.close", title: "c", category: "c", defaultKey: null, run: close },
  ],
  getCommand: () => undefined,
}));

function fire(target: EventTarget, init: KeyboardEventInit) {
  target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ...init }));
}

beforeEach(() => {
  vi.clearAllMocks();
  render(<KeybindingHost />);
});
afterEach(() => {
  document.body.innerHTML = "";
});

describe("KeybindingHost", () => {
  it("dispatches a matching combo on window", () => {
    fire(window, { key: "b", code: "KeyB", ctrlKey: true });
    expect(toggle).toHaveBeenCalledTimes(1);
  });

  it("yields when focus is in an input", () => {
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    fire(window, { key: "b", code: "KeyB", ctrlKey: true });
    expect(toggle).not.toHaveBeenCalled();
  });

  it("allow-listed command (editor.save) still fires from an input", () => {
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    fire(window, { key: "s", code: "KeyS", ctrlKey: true });
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("ignores bare modifier presses", () => {
    fire(window, { key: "Control", code: "ControlLeft", ctrlKey: true });
    expect(toggle).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it("yields when a dialog is open", () => {
    const dlg = document.createElement("div");
    dlg.setAttribute("role", "dialog");
    document.body.appendChild(dlg);
    fire(window, { key: "b", code: "KeyB", ctrlKey: true });
    expect(toggle).not.toHaveBeenCalled();
  });

  it("yields bare Escape to an open dialog even for allow-listed editor.close", () => {
    const dlg = document.createElement("div");
    dlg.setAttribute("role", "dialog");
    document.body.appendChild(dlg);
    fire(window, { key: "Escape", code: "Escape" });
    expect(close).not.toHaveBeenCalled();
    dlg.remove();
  });

  it("isInputContext recognises editable elements", () => {
    const ta = document.createElement("textarea");
    const ce = document.createElement("div");
    ce.setAttribute("contenteditable", "true");
    expect(isInputContext(ta)).toBe(true);
    expect(isInputContext(ce)).toBe(true);
    expect(isInputContext(document.createElement("div"))).toBe(false);
  });
});
