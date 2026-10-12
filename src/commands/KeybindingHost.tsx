import { useEffect } from "react";
import {
  combosMatch,
  detectPlatform,
  eventToLogicalCombo,
  isModifierOnly,
  type KeyCombo,
} from "./types";
import { listCommands } from "./registry";
import { useKeybindingsStore } from "../stores/keybindings.store";

// Commands that must work even while typing (VSCode semantics).
const ALLOW_IN_INPUT = new Set([
  "editor.save",
  "editor.close",
  "scm.commit",
  "files.copy",
  "files.cut",
  "files.paste",
  "files.rename",
  "files.delete",
  "workbench.closeActiveTab",
  "terminal.toggle",
]);

/** Workbench shortcuts still allowed while the integrated terminal is focused. */
const ALLOW_IN_TERMINAL = new Set(["terminal.toggle"]);

export const INPUT_SELECTOR = "input, textarea, select, [contenteditable=''], [contenteditable='true']";
export const TERMINAL_SELECTOR = ".xterm, [data-terminal-host]";
/** CodeMirror's editable surface (`.cm-content` is contenteditable). */
export const CODE_EDITOR_SELECTOR = ".cm-editor, .cm-content";

export function isInputContext(el: EventTarget | null): boolean {
  return el instanceof HTMLElement ? !!el.closest(INPUT_SELECTOR) : false;
}

export function isTerminalContext(el: EventTarget | null): boolean {
  return el instanceof HTMLElement ? !!el.closest(TERMINAL_SELECTOR) : false;
}

export function isCodeEditorContext(el: EventTarget | null): boolean {
  return el instanceof HTMLElement ? !!el.closest(CODE_EDITOR_SELECTOR) : false;
}

/**
 * A modal dialog owns every shortcut (Esc to radix, no workbench command).
 * The editor preview is portalled into a Dialog but is a workbench surface, not
 * a modal: it is marked `data-workbench-surface` and must not silence the host,
 * or ⌘S / Esc / ⌘W die the moment a file is opened (and the side panel becomes
 * unreachable for the same reason — see MainLayout).
 */
function dialogOpen(): boolean {
  return !!document.querySelector(
    '[role="dialog"]:not([data-workbench-surface]), [role="alertdialog"]',
  );
}

function extraCombosForCommand(id: string, platform: ReturnType<typeof detectPlatform>): KeyCombo[] {
  if (id === "files.delete" && platform === "mac") {
    return [
      { primary: true, key: "arrowleft" },
      { primary: true, key: "backspace" },
    ];
  }
  return [];
}

export function KeybindingHost() {
  useEffect(() => {
    const platform = detectPlatform();
    // Pre-resolve canonical combo -> command each dispatch (cheap; registry is tiny).
    const onKeyDown = (e: KeyboardEvent) => {
      if (isModifierOnly(e)) return;
      const inTerminal =
        isTerminalContext(e.target) || isTerminalContext(document.activeElement);
      // CodeMirror's content is contenteditable, so it is also an "input" — but
      // unlike a text field it must not swallow workbench shortcuts. It gets its
      // own (narrower) rule below, so it is tested before the generic one.
      const inCodeEditor =
        isCodeEditorContext(e.target) || isCodeEditorContext(document.activeElement);
      const inInput = isInputContext(e.target) || isInputContext(document.activeElement);
      const dlg = dialogOpen();

      const combo = eventToLogicalCombo(e, platform);
      if (!combo || combo.key == null) return;

      // C-1: 裸可打印字符（字母/数字/单字符标点）绝不放行白名单旁路，防止吞掉正常输入
      const isTypingKey =
        combo.key !== null &&
        (combo.key.length === 1 || /^key[a-z]$/.test(combo.key) || /^digit[0-9]$/.test(combo.key));
      // 带修饰键的组合（⌘S / Ctrl+` / Alt+Shift+F…）在工作台各处语义一致。
      const hasModifier = !!combo.primary || !!combo.ctrl || !!combo.alt;

      const { resolve, overrides } = useKeybindingsStore.getState();
      // I-1: 有用户覆盖的命令优先响应，其次保持 registry 序
      const cmds = [...listCommands()].sort(
        (a, b) => (a.id in overrides ? 0 : 1) - (b.id in overrides ? 0 : 1),
      );
      for (const cmd of cmds) {
        const resolved = resolve(cmd.id);
        const matched =
          combosMatch(resolved, combo, platform) ||
          extraCombosForCommand(cmd.id, platform).some((alt) => combosMatch(alt, combo, platform));
        if (!matched) continue;
        if (dlg) continue; // 模态对话框打开时全局键位全部让行（Esc 交给 radix）
        // Terminal owns arrow/history/paste keys — only allow a small workbench set.
        // xterm's helper textarea is also an "input", so terminal checks must win.
        if (inTerminal) {
          if (!ALLOW_IN_TERMINAL.has(cmd.id)) continue;
        } else if (inCodeEditor) {
          // CM 的 keymap 独占裸键（输入、方向、Esc 关查找栏）；只有带修饰键的
          // 工作台快捷键放行，否则编辑器成了快捷键黑洞。会与文本编辑冲突的
          // 命令（撤销 / 剪贴板 / 文件树操作）由各自的 when() 主动排除。
          if (!hasModifier && isTypingKey) continue;
        } else {
          // 放行条件：命令在白名单，且（带 primary/alt，或键 token 为功能键/非可打印字符）
          const allowBypass =
            ALLOW_IN_INPUT.has(cmd.id) &&
            (!isTypingKey || hasModifier);
          if (inInput && !allowBypass) continue;
        }
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
