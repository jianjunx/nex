import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { persist } from "zustand/middleware";

export type SidePanelTab = "files" | "git" | "search";

/** Validate a hydrated sidePanelTab value; fall back to "files" for stale/unknown tabs. */
export function sanitizeSidePanelTab(v: unknown): SidePanelTab {
  if (v === "files" || v === "git" || v === "search") return v;
  return "files";
}

interface UiState {
  sidePanelVisible: boolean;
  sidePanelTab: SidePanelTab;
  terminalVisible: boolean;
  sidePanelWidth: number;
  terminalHeight: number;
  editorVisible: boolean;
  editorWidth: number;
  settingsOpen: boolean;

  toggleSidePanel: () => void;
  setSidePanelTab: (tab: SidePanelTab) => void;
  toggleTerminal: () => void;
  setSidePanelWidth: (w: number) => void;
  setTerminalHeight: (h: number) => void;
  setEditorVisible: (v: boolean) => void;
  setEditorWidth: (w: number) => void;
  resetLayoutDims: () => void;
  openSettings: () => void;
  closeSettings: () => void;
}

// Persist layout state so the window reopens exactly as the user left it
// (panel visibility/width, terminal toggle/height, active side-panel tab).
export const useUiStore = create<UiState>()(
  persist(
    immer((set) => ({
      sidePanelVisible: true,
      sidePanelTab: "files",
      terminalVisible: false,
      sidePanelWidth: 320,
      terminalHeight: 200,
      editorVisible: false,
      editorWidth: 480,
      settingsOpen: false,

      toggleSidePanel: () => set((s) => { s.sidePanelVisible = !s.sidePanelVisible; }),
      setSidePanelTab: (tab) => set((s) => { s.sidePanelTab = tab; s.sidePanelVisible = true; }),
      toggleTerminal: () => set((s) => {
        s.terminalVisible = !s.terminalVisible;
        // The terminal tray lives INSIDE the side panel; turning it on while
        // the panel is hidden would light the icon with nothing appearing.
        // (Same force-show precedent as setSidePanelTab.)
        if (s.terminalVisible) s.sidePanelVisible = true;
      }),
      setSidePanelWidth: (w) => set((s) => { s.sidePanelWidth = w; }),
      setTerminalHeight: (h) => set((s) => { s.terminalHeight = h; }),
      setEditorVisible: (v) => set((s) => { s.editorVisible = v; }),
      setEditorWidth: (w) => set((s) => { s.editorWidth = w; }),
      // "Restore defaults" in the settings panel: reset sizes only, never
      // visibility, so a tidy-up can't hide the user's panels.
      resetLayoutDims: () => set((s) => {
        s.sidePanelWidth = 320;
        s.terminalHeight = 200;
        s.editorWidth = 480;
      }),
      openSettings: () => set((s) => { s.settingsOpen = true; }),
      closeSettings: () => set((s) => { s.settingsOpen = false; }),
    })),
    {
      name: "nex-ui",
      // Only persist data fields; actions are re-created from the initializer.
      partialize: (s) => ({
        sidePanelVisible: s.sidePanelVisible,
        sidePanelTab: s.sidePanelTab,
        terminalVisible: s.terminalVisible,
        sidePanelWidth: s.sidePanelWidth,
        terminalHeight: s.terminalHeight,
        editorVisible: s.editorVisible,
        editorWidth: s.editorWidth,
      }),
      // I-2: 水合时校验 sidePanelTab，防止陈旧持久化值（如旧版 "settings"）导致侧栏空白
      merge: (persisted, current) => {
        const merged = { ...current, ...(persisted as Partial<UiState>) };
        return { ...merged, sidePanelTab: sanitizeSidePanelTab(merged.sidePanelTab) };
      },
    }
  )
);
