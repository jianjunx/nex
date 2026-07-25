import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { LazyStore } from "@tauri-apps/plugin-store";

export type Theme = "light" | "dark";

// Persistent layer: the plugin-store LazyStore writes settings.json in the
// app-data dir (next to nex.db), auto-saving with a 300 ms debounce. Zustand
// holds the in-memory mirror the UI binds to — the LazyStore is persistence,
// NOT the zustand persist middleware.
const settingsStore = new LazyStore("settings.json", { autoSave: 300 });

// Keys are pinned — task 8 and future batches read the same names.
const KEYS = {
  theme: "appearance.theme",
  shell: "terminal.shell",
  fontSize: "terminal.fontSize",
  fontFamily: "terminal.fontFamily",
  scrollback: "terminal.scrollback",
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

  load: () => Promise<void>;
  setTheme: (theme: Theme) => void;
  setTerminalShell: (shell: string) => void;
  setTerminalFontSize: (size: number) => void;
  setTerminalFontFamily: (family: string) => void;
  setTerminalScrollback: (lines: number) => void;
}

export const useSettingsStore = create<SettingsState>()(
  immer((set, get) => ({
    loaded: false,
    theme: "light",
    terminalShell: "",
    terminalFontSize: TERMINAL_DEFAULTS.fontSize,
    terminalFontFamily: TERMINAL_DEFAULTS.fontFamily,
    terminalScrollback: TERMINAL_DEFAULTS.scrollback,

    // Reads every key, keeping the built-in default for missing/invalid
    // entries (a deleted settings.json yields a clean light-default start).
    // Persistence failures must never strand the UI on old values, so each
    // getter failure falls through to defaults.
    load: async () => {
      try {
        const [theme, shell, fontSize, fontFamily, scrollback] = await Promise.all([
          settingsStore.get<Theme>(KEYS.theme),
          settingsStore.get<string>(KEYS.shell),
          settingsStore.get<number>(KEYS.fontSize),
          settingsStore.get<string>(KEYS.fontFamily),
          settingsStore.get<number>(KEYS.scrollback),
        ]);
        set((s) => {
          if (theme === "light" || theme === "dark") s.theme = theme;
          if (typeof shell === "string") s.terminalShell = shell;
          if (typeof fontSize === "number") s.terminalFontSize = fontSize;
          if (typeof fontFamily === "string") s.terminalFontFamily = fontFamily;
          if (typeof scrollback === "number") s.terminalScrollback = scrollback;
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
      // @custom-variant dark + [data-theme="light"] overrides); the OS
      // glass re-tint joins this setter in a later commit.
      document.documentElement.setAttribute("data-theme", theme);
      void settingsStore.set(KEYS.theme, theme).catch(() => {});
    },
    setTerminalShell: (shell) => {
      set((s) => { s.terminalShell = shell; });
      void settingsStore.set(KEYS.shell, shell).catch(() => {});
    },
    setTerminalFontSize: (size) => {
      set((s) => { s.terminalFontSize = size; });
      void settingsStore.set(KEYS.fontSize, size).catch(() => {});
    },
    setTerminalFontFamily: (family) => {
      set((s) => { s.terminalFontFamily = family; });
      void settingsStore.set(KEYS.fontFamily, family).catch(() => {});
    },
    setTerminalScrollback: (lines) => {
      set((s) => { s.terminalScrollback = lines; });
      void settingsStore.set(KEYS.scrollback, lines).catch(() => {});
    },
  }))
);
