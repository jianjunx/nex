import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { persist } from "zustand/middleware";

export type SidePanelTab = "files" | "git" | "search";

interface UiState {
  sidePanelVisible: boolean;
  sidePanelTab: SidePanelTab;
  terminalVisible: boolean;
  sidePanelWidth: number;
  terminalHeight: number;
  editorVisible: boolean;
  editorWidth: number;

  toggleSidePanel: () => void;
  setSidePanelTab: (tab: SidePanelTab) => void;
  toggleTerminal: () => void;
  setSidePanelWidth: (w: number) => void;
  setTerminalHeight: (h: number) => void;
  setEditorVisible: (v: boolean) => void;
  setEditorWidth: (w: number) => void;
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
    }
  )
);
