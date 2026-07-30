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
      if (!combo || !canonical) return;

      // C-1: 裸可打印字符（字母/数字/单字符标点）绝不放行白名单旁路，防止吞掉正常输入
      const isTypingKey =
        combo.key !== null &&
        (combo.key.length === 1 || /^key[a-z]$/.test(combo.key) || /^digit[0-9]$/.test(combo.key));

      const { resolve, overrides } = useKeybindingsStore.getState();
      // I-1: 有用户覆盖的命令优先响应，其次保持 registry 序
      const cmds = [...listCommands()].sort(
        (a, b) => (a.id in overrides ? 0 : 1) - (b.id in overrides ? 0 : 1),
      );
      for (const cmd of cmds) {
        if (comboToCanonical(resolve(cmd.id)) !== canonical) continue;
        if (dlg) continue; // 模态对话框打开时全局键位全部让行（Esc 交给 radix）
        // 放行条件：命令在白名单，且（带 primary/alt，或键 token 为功能键/非可打印字符）
        const allowBypass = ALLOW_IN_INPUT.has(cmd.id) && (!isTypingKey || !!combo.primary || !!combo.alt);
        if (inInput && !allowBypass) continue;
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
