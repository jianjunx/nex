/**
 * @vitest-environment jsdom
 */
// src/commands/integration.test.tsx
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { KeybindingHost } from "./KeybindingHost";

const toggle = vi.fn();
vi.mock("../commands/registry", () => ({
  listCommands: () => [{ id: "view.toggleSidebar", title: "t", category: "c", defaultKey: null, run: toggle }],
  getCommand: () => undefined,
}));

let overrides: Record<string, string | null> = {};
vi.mock("../stores/keybindings.store", () => ({
  useKeybindingsStore: {
    getState: () => ({
      loaded: true,
      resolve: (id: string) => {
        if (id !== "view.toggleSidebar") return null;
        // default primary+keyb unless overridden
        if (id in overrides) return overrides[id] === null ? { key: null } : parse(overrides[id]!);
        return { primary: true, key: "keyb" };
      },
    }),
  },
}));
function parse(s: string) {
  const c: Record<string, boolean | string> = { key: "" };
  for (const t of s.split("+")) {
    if (t === "primary") c.primary = true;
    else if (t === "alt") c.alt = true;
    else if (t === "shift") c.shift = true;
    else c.key = t;
  }
  return c;
}
const fire = (init: KeyboardEventInit) =>
  window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ...init }));

beforeEach(() => { overrides = {}; vi.clearAllMocks(); render(<KeybindingHost />); });
afterEach(() => { document.body.innerHTML = ""; });

describe("keybinding integration", () => {
  it("default binding dispatches", () => {
    fire({ key: "b", code: "KeyB", ctrlKey: true });
    expect(toggle).toHaveBeenCalledTimes(1);
  });
  it("override changes the dispatch key", () => {
    overrides = { "view.toggleSidebar": "primary+alt+keyb" };
    fire({ key: "b", code: "KeyB", ctrlKey: true });
    expect(toggle).not.toHaveBeenCalled();
    fire({ key: "b", code: "KeyB", ctrlKey: true, altKey: true });
    expect(toggle).toHaveBeenCalledTimes(1);
  });
  it("unbound disables the command", () => {
    overrides = { "view.toggleSidebar": null };
    fire({ key: "b", code: "KeyB", ctrlKey: true });
    expect(toggle).not.toHaveBeenCalled();
  });
});
