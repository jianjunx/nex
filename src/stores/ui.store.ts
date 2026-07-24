import { create } from "zustand";
import { immer } from "zustand/middleware/immer";

export type SidePanelTab = "files" | "git" | "search";

interface UiState {
  sidePanelVisible: boolean;
  sidePanelTab: SidePanelTab;
  terminalVisible: boolean;
  sidePanelWidth: number;
  terminalHeight: number;

  toggleSidePanel: () => void;
  setSidePanelTab: (tab: SidePanelTab) => void;
  toggleTerminal: () => void;
  setSidePanelWidth: (w: number) => void;
  setTerminalHeight: (h: number) => void;
}

export const useUiStore = create<UiState>()(
  immer((set) => ({
    sidePanelVisible: true,
    sidePanelTab: "files",
    terminalVisible: false,
    sidePanelWidth: 320,
    terminalHeight: 200,

    toggleSidePanel: () => set((s) => { s.sidePanelVisible = !s.sidePanelVisible; }),
    setSidePanelTab: (tab) => set((s) => { s.sidePanelTab = tab; s.sidePanelVisible = true; }),
    toggleTerminal: () => set((s) => { s.terminalVisible = !s.terminalVisible; }),
    setSidePanelWidth: (w) => set((s) => { s.sidePanelWidth = w; }),
    setTerminalHeight: (h) => set((s) => { s.terminalHeight = h; }),
  }))
);
