// src/commands/KeybindingHost.tsx
import { useEffect } from "react";
import {
  comboToCanonical,
  detectPlatform,
  eventToLogicalCombo,
  isModifierOnly,
} from "./types";
import { listCommands } from "./registry";
import { useKeybindingsStore } from "../stores/keybindings.store";

// Commands that must work even while typing (VSCode semantics).
const ALLOW_IN_INPUT = new Set(["editor.save", "editor.close"]);

export const INPUT_SELECTOR = "input, textarea, select, [contenteditable=''], [contenteditable='true']";

export function isInputContext(el: EventTarget | null): boolean {
  return el instanceof HTMLElement ? !!el.closest(INPUT_SELECTOR) : false;
}

function dialogOpen(): boolean {
  return !!document.querySelector('[role="dialog"], [role="alertdialog"]');
}

export function KeybindingHost() {
  useEffect(() => {
    const platform = detectPlatform();
    // Pre-resolve canonical combo -> command each dispatch (cheap; registry is tiny).
    const onKeyDown = (e: KeyboardEvent) => {
      if (isModifierOnly(e)) return;
      const inInput = isInputContext(e.target) || isInputContext(document.activeElement);
      const dlg = dialogOpen();

      const combo = eventToLogicalCombo(e, platform);
      const canonical = comboToCanonical(combo);
      if (!canonical) return;

      const { resolve } = useKeybindingsStore.getState();
      for (const cmd of listCommands()) {
        if (comboToCanonical(resolve(cmd.id)) !== canonical) continue;
        if ((inInput || dlg) && !ALLOW_IN_INPUT.has(cmd.id)) continue;
        if (cmd.when && !cmd.when()) continue;
        e.preventDefault();
        e.stopImmediatePropagation();
        cmd.run();
        return;
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);
  return null;
}
