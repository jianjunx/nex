import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { LazyStore } from "@tauri-apps/plugin-store";
import { clearAllAutoSaveTimers } from "./editorAutosave";
import { useTerminalStore } from "./terminal.store";

export type Theme = "light" | "dark";

// Persistent layer: the plugin-store LazyStore writes settings.json in the
// app-data dir (next to nex.db), auto-saving with a 300 ms debounce. Zustand
// holds the in-memory mirror the UI binds to — the LazyStore is persistence,
// NOT the zustand persist middleware.
const settingsStore = new LazyStore("settings.json", { autoSave: 300 });

// Keys are pinned — all consumers read the same persisted names.
const KEYS = {
  theme: "appearance.theme",
  shell: "terminal.shell",
  fontSize: "terminal.fontSize",
  fontFamily: "terminal.fontFamily",
  scrollback: "terminal.scrollback",
  autoSave: "editor.autoSave",
  wordWrap: "editor.wordWrap",
  wrapColumn: "editor.wrapColumn",
} as const;

export const TERMINAL_DEFAULTS = {
  fontSize: 13,
  fontFamily: "JetBrains Mono, Menlo, Consolas, monospace",
  scrollback: 1000,
} as const;

interface SettingsState {
  loaded: boolean;
  theme: Theme;
  terminalShell: string; // "" = system default
  terminalFontSize: number;
  terminalFontFamily: string;
  terminalScrollback: number;
  editorAutoSave: boolean;
  editorWordWrap: boolean;
  editorWrapColumn: number;

  load: () => Promise<void>;
  setTheme: (theme: Theme) => void;
  setTerminalShell: (shell: string) => void;
  setTerminalFontSize: (size: number) => void;
  setTerminalFontFamily: (family: string) => void;
  setTerminalScrollback: (lines: number) => void;
  setEditorAutoSave: (v: boolean) => void;
  setEditorWordWrap: (v: boolean) => void;
  setEditorWrapColumn: (v: number) => void;
}

export const useSettingsStore = create<SettingsState>()(
  immer((set, get) => ({
    loaded: false,
    theme: "light",
    terminalShell: "",
    terminalFontSize: TERMINAL_DEFAULTS.fontSize,
    terminalFontFamily: TERMINAL_DEFAULTS.fontFamily,
    terminalScrollback: TERMINAL_DEFAULTS.scrollback,
    editorAutoSave: true,
    editorWordWrap: true,
    editorWrapColumn: 120,

    // Reads every key, keeping the built-in default for missing/invalid
    // entries (a deleted settings.json yields a clean light-default start).
    // Persistence failures must never strand the UI on old values, so each
    // getter failure falls through to defaults.
    load: async () => {
      try {
        const [theme, shell, fontSize, fontFamily, scrollback, autoSave, wordWrap, wrapColumn] = await Promise.all([
          settingsStore.get<Theme>(KEYS.theme),
          settingsStore.get<string>(KEYS.shell),
          settingsStore.get<number>(KEYS.fontSize),
          settingsStore.get<string>(KEYS.fontFamily),
          settingsStore.get<number>(KEYS.scrollback),
          settingsStore.get<boolean>(KEYS.autoSave),
          settingsStore.get<boolean>(KEYS.wordWrap),
          settingsStore.get<number>(KEYS.wrapColumn),
        ]);
        set((s) => {
          if (theme === "light" || theme === "dark") s.theme = theme;
          if (typeof shell === "string") s.terminalShell = shell;
          if (typeof fontSize === "number") {
            s.terminalFontSize = Math.min(48, Math.max(8, Math.round(fontSize)));
          }
          if (typeof fontFamily === "string" && fontFamily.trim()) s.terminalFontFamily = fontFamily;
          if (typeof scrollback === "number") {
            s.terminalScrollback = Math.min(100_000, Math.max(100, Math.round(scrollback)));
          }
          if (typeof autoSave === "boolean") s.editorAutoSave = autoSave;
          if (typeof wordWrap === "boolean") s.editorWordWrap = wordWrap;
          if (typeof wrapColumn === "number") {
            s.editorWrapColumn = Math.min(400, Math.max(40, Math.round(wrapColumn)));
          }
        });
      } catch {
        // Unreadable store: keep defaults.
      } finally {
        set((s) => { s.loaded = true; });
      }
      // Apply the resolved theme so the panel and the CSS can never fight.
      document.documentElement.setAttribute("data-theme", get().theme);
    },

    setTheme: (theme) => {
      set((s) => { s.theme = theme; });
      // CSS theming is driven entirely by this attribute (globals.css
      // @custom-variant dark + [data-theme="light"] overrides).
      document.documentElement.setAttribute("data-theme", theme);
      // Rebuild the terminal so its snapshotted theme colors follow the new theme.
      useTerminalStore.getState().bumpSettingsVersion();
      void settingsStore.set(KEYS.theme, theme).catch(() => {});
    },
    setTerminalShell: (shell) => {
      set((s) => { s.terminalShell = shell; });
      // No settingsVersion bump: the shell only affects newly created
      // terminals, never the running instance.
      void settingsStore.set(KEYS.shell, shell).catch(() => {});
    },
    setTerminalFontSize: (size) => {
      set((s) => { s.terminalFontSize = size; });
      useTerminalStore.getState().bumpSettingsVersion();
      void settingsStore.set(KEYS.fontSize, size).catch(() => {});
    },
    setTerminalFontFamily: (family) => {
      set((s) => { s.terminalFontFamily = family; });
      useTerminalStore.getState().bumpSettingsVersion();
      void settingsStore.set(KEYS.fontFamily, family).catch(() => {});
    },
    setTerminalScrollback: (lines) => {
      set((s) => { s.terminalScrollback = lines; });
      useTerminalStore.getState().bumpSettingsVersion();
      void settingsStore.set(KEYS.scrollback, lines).catch(() => {});
    },
    setEditorAutoSave: (v) => {
      set((s) => { s.editorAutoSave = v; });
      if (!v) clearAllAutoSaveTimers();
      void settingsStore.set(KEYS.autoSave, v).catch(() => {});
    },
    setEditorWordWrap: (v) => {
      set((s) => { s.editorWordWrap = v; });
      void settingsStore.set(KEYS.wordWrap, v).catch(() => {});
    },
    setEditorWrapColumn: (v) => {
      const clamped = Math.min(400, Math.max(40, Math.round(v)));
      set((s) => { s.editorWrapColumn = clamped; });
      void settingsStore.set(KEYS.wrapColumn, clamped).catch(() => {});
    },
  }))
);
