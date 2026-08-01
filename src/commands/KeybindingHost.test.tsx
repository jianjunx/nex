/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { KeybindingHost, isInputContext, isTerminalContext } from "./KeybindingHost";

// Module-level mutable state so individual tests can override bindings (C-1/I-1 cases).
let bindingOverrides: Record<string, object | null> = {};
let storeOverrides: Record<string, string | null> = {};

vi.mock("../stores/keybindings.store", () => ({
  useKeybindingsStore: {
    getState: () => ({
      loaded: true,
      overrides: storeOverrides,
      resolve: (id: string) => {
        if (id in bindingOverrides) return bindingOverrides[id] ?? null;
        // Mirror a couple of defaults so the host can match without the real registry store.
        if (id === "view.toggleSidebar") return { primary: true, key: "keyb" };
        if (id === "editor.save") return { primary: true, key: "keys" };
        if (id === "editor.close") return { key: "escape" };
        if (id === "scm.commit") return { primary: true, key: "enter" };
        if (id === "terminal.toggle") return { primary: true, key: "`" };
        return null;
      },
    }),
  },
}));

const toggle = vi.fn();
const save = vi.fn();
const close = vi.fn();
const scmCommit = vi.fn();
const terminalToggle = vi.fn();
vi.mock("../commands/registry", () => ({
  listCommands: () => [
    { id: "view.toggleSidebar", title: "t", category: "c", defaultKey: null, run: toggle },
    { id: "editor.save", title: "s", category: "c", defaultKey: null, run: save },
    { id: "editor.close", title: "c", category: "c", defaultKey: null, run: close },
    {
      id: "scm.commit",
      title: "k",
      category: "c",
      defaultKey: null,
      when: () => !!document.activeElement?.closest("[data-scm-commit-input]"),
      run: scmCommit,
    },
    { id: "terminal.toggle", title: "term", category: "c", defaultKey: null, run: terminalToggle },
  ],
  getCommand: () => undefined,
}));

function fire(target: EventTarget, init: KeyboardEventInit) {
  target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ...init }));
}

beforeEach(() => {
  bindingOverrides = {};
  storeOverrides = {};
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

  it("isTerminalContext recognises xterm hosts", () => {
    const host = document.createElement("div");
    host.setAttribute("data-terminal-host", "");
    const ta = document.createElement("textarea");
    host.appendChild(ta);
    expect(isTerminalContext(ta)).toBe(true);
    expect(isTerminalContext(document.createElement("div"))).toBe(false);
  });

  it("does not steal Escape / Ctrl+B from the integrated terminal", () => {
    const host = document.createElement("div");
    host.setAttribute("data-terminal-host", "");
    const ta = document.createElement("textarea");
    host.appendChild(ta);
    document.body.appendChild(host);
    ta.focus();
    fire(window, { key: "Escape", code: "Escape" });
    fire(window, { key: "b", code: "KeyB", ctrlKey: true });
    expect(close).not.toHaveBeenCalled();
    expect(toggle).not.toHaveBeenCalled();
  });

  it("still allows terminal.toggle while the terminal is focused", () => {
    const host = document.createElement("div");
    host.setAttribute("data-terminal-host", "");
    const ta = document.createElement("textarea");
    host.appendChild(ta);
    document.body.appendChild(host);
    ta.focus();
    fire(window, { key: "`", code: "Backquote", ctrlKey: true });
    expect(terminalToggle).toHaveBeenCalledTimes(1);
  });

  // C-1: 裸可打印字符绑定挂在放行白名单命令上不得吞掉正常输入
  it("C-1: bare printable binding on allowlisted command does NOT fire from input", () => {
    bindingOverrides = { "editor.save": { key: "keys" } }; // 裸 's'，无修饰键
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    fire(window, { key: "s", code: "KeyS" });
    expect(save).not.toHaveBeenCalled();
  });

  it("C-1: bare printable binding fires outside input context", () => {
    bindingOverrides = { "editor.save": { key: "keys" } };
    fire(window, { key: "s", code: "KeyS" });
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("C-1: bare escape (non-printable) on allowlisted command fires from input", () => {
    // editor.close 默认绑定为裸 escape——非打印键，必须保留放行（关查找栏等）
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    fire(window, { key: "Escape", code: "Escape" });
    expect(close).toHaveBeenCalledTimes(1);
  });

  // I-1: 有用户覆盖的命令优先于 registry 序
  it("I-1: command with user override wins over earlier registry command", () => {
    // 两个命令均 resolve 到 primary+keys；editor.save 在 overrides 里（靠后于 toggleSidebar）
    bindingOverrides = { "view.toggleSidebar": { primary: true, key: "keys" } };
    storeOverrides = { "editor.save": "primary+keys" }; // 值不重要，host 只看 `in overrides`
    fire(window, { key: "s", code: "KeyS", ctrlKey: true });
    expect(save).toHaveBeenCalledTimes(1);
    expect(toggle).not.toHaveBeenCalled();
  });

  it("scm.commit fires on Ctrl+Enter from the commit input", () => {
    const input = document.createElement("input");
    input.setAttribute("data-scm-commit-input", "");
    document.body.appendChild(input);
    input.focus();
    fire(window, { key: "Enter", code: "Enter", ctrlKey: true });
    expect(scmCommit).toHaveBeenCalledTimes(1);
  });

  it("scm.commit does not fire from an unrelated input", () => {
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    fire(window, { key: "Enter", code: "Enter", ctrlKey: true });
    expect(scmCommit).not.toHaveBeenCalled();
  });

  it("yields allowlisted editor.save when a dialog is open, even from an input", () => {
    // 对话框优先于白名单：dlg 打开时 host 全让行，Esc 交给 radix、Ctrl+S 不触发
    const dlg = document.createElement("div");
    dlg.setAttribute("role", "dialog");
    document.body.appendChild(dlg);
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    fire(window, { key: "s", code: "KeyS", ctrlKey: true });
    expect(save).not.toHaveBeenCalled();
    dlg.remove();
  });
});
