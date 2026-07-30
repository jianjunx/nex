import { describe, expect, it } from "vitest";
import {
  canonicalToCombo,
  comboToCanonical,
  comboToLabel,
  eventToLogicalCombo,
  isModifierOnly,
  normalizeKeyToken,
} from "./types";

describe("combo canonical round-trip", () => {
  it("serializes modifiers in fixed order", () => {
    expect(comboToCanonical({ shift: true, primary: true, key: "keyf" })).toBe("primary+shift+keyf");
    expect(comboToCanonical({ alt: true, primary: true, shift: true, key: "enter" })).toBe(
      "primary+alt+shift+enter",
    );
  });

  it("round-trips through canonical", () => {
    const c = { primary: true, shift: true, key: "keyn" };
    expect(canonicalToCombo(comboToCanonical(c))).toEqual(c);
  });

  it("null key means unbound", () => {
    expect(comboToCanonical({ key: null })).toBeNull();
    expect(canonicalToCombo(null)).toEqual({ key: null });
  });
});

describe("normalizeKeyToken", () => {
  it("letter codes become keyX", () => {
    expect(normalizeKeyToken("KeyA", "a")).toBe("keya");
    expect(normalizeKeyToken("KeyF", "F")).toBe("keyf");
  });
  it("special keys use lowercased e.key", () => {
    expect(normalizeKeyToken("Enter", "Enter")).toBe("enter");
    expect(normalizeKeyToken("Escape", "Escape")).toBe("escape");
    expect(normalizeKeyToken("BracketLeft", "[")).toBe("[");
  });
});

describe("eventToLogicalCombo", () => {
  it("maps Cmd to primary on mac, Ctrl to primary elsewhere", () => {
    const ev = { ctrlKey: false, metaKey: true, altKey: false, shiftKey: false, code: "KeyB", key: "b" };
    expect(eventToLogicalCombo(ev, "mac")).toEqual({ primary: true, key: "keyb" });
    expect(eventToLogicalCombo({ ...ev, metaKey: false, ctrlKey: true }, "other")).toEqual({
      primary: true,
      key: "keyb",
    });
  });
  it("ignores the platform-native cmd/ctrl cross bit", () => {
    // On mac a Ctrl+B should NOT be primary; on other a Cmd+B should NOT be primary.
    expect(eventToLogicalCombo({ ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, code: "KeyB", key: "b" }, "mac")).toEqual({ key: "keyb" });
    expect(eventToLogicalCombo({ ctrlKey: false, metaKey: true, altKey: false, shiftKey: false, code: "KeyB", key: "b" }, "other")).toEqual({ key: "keyb" });
  });
});

describe("isModifierOnly", () => {
  it("true for bare modifier presses", () => {
    expect(isModifierOnly({ key: "Control" } as KeyboardEvent)).toBe(true);
    expect(isModifierOnly({ key: "Meta" } as KeyboardEvent)).toBe(true);
    expect(isModifierOnly({ key: "Shift" } as KeyboardEvent)).toBe(true);
    expect(isModifierOnly({ key: "Alt" } as KeyboardEvent)).toBe(true);
  });
  it("false for real keys", () => {
    expect(isModifierOnly({ key: "b" } as KeyboardEvent)).toBe(false);
  });
});

describe("comboToLabel", () => {
  it("uses glyphs on mac", () => {
    expect(comboToLabel({ primary: true, shift: true, key: "keyf" }, "mac")).toBe("⌘⇧F");
  });
  it("uses words elsewhere", () => {
    expect(comboToLabel({ primary: true, key: "keyb" }, "other")).toBe("Ctrl+B");
  });
  it("unbound shows placeholder", () => {
    expect(comboToLabel({ key: null }, "mac")).toBe("—");
  });
});
