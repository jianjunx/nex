import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { persist } from "zustand/middleware";

export type SidePanelTab = "files" | "git" | "search";

/** Validate a hydrated sidePanelTab value; fall back to "files" for stale/unknown tabs. */
export function sanitizeSidePanelTab(v: unknown): SidePanelTab {
  if (v === "files" || v === "git" || v === "search") return v;
  return "files";
}

/** 设置弹窗六分区；供 ui.store.settingsSection 一次性定向导航（如"管理智能体…"）。 */
export type SettingsSection =
  | "appearance"
  | "editor"
  | "terminal"
  | "agents"
  | "keybindings"
  | "layout";

interface UiState {
  sidePanelVisible: boolean;
  sidePanelTab: SidePanelTab;
  terminalVisible: boolean;
  sidePanelWidth: number;
  terminalHeight: number;
  editorVisible: boolean;
  editorWidth: number;
  settingsOpen: boolean;
  newConversationOpen: boolean;
  /** 一次性设置弹窗定向：置位后由 SettingsDialog 打开时消费并清空。 */
  settingsSection: SettingsSection | null;
  /** 自增计数触发搜索面板聚焦；不持久化（partialize 未收录即生效）。 */
  searchFocusRequest: number;
  /** 自增计数请求关闭当前对话页签（Cmd/Ctrl+W）；不持久化。 */
  closeTabRequest: number;

  toggleSidePanel: () => void;
  setSidePanelTab: (tab: SidePanelTab) => void;
  /** 点亮态再点同一图标则收起；否则切换 tab 并展开面板。 */
  toggleSidePanelTab: (tab: SidePanelTab) => void;
  toggleTerminal: () => void;
  setTerminalVisible: (v: boolean) => void;
  setSidePanelWidth: (w: number) => void;
  setTerminalHeight: (h: number) => void;
  setEditorVisible: (v: boolean) => void;
  setEditorWidth: (w: number) => void;
  resetLayoutDims: () => void;
  openSettings: () => void;
  closeSettings: () => void;
  openNewConversation: () => void;
  closeNewConversation: () => void;
  toggleNewConversation: () => void;
  setSettingsSection: (section: SettingsSection | null) => void;
  requestSearchFocus: () => void;
  requestCloseActiveTab: () => void;
  consumeCloseTabRequest: () => void;
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
      newConversationOpen: false,
      settingsSection: null,
      searchFocusRequest: 0,
      closeTabRequest: 0,

      toggleSidePanel: () => set((s) => { s.sidePanelVisible = !s.sidePanelVisible; }),
      setSidePanelTab: (tab) => set((s) => { s.sidePanelTab = tab; s.sidePanelVisible = true; }),
      toggleSidePanelTab: (tab) => set((s) => {
        if (s.sidePanelVisible && s.sidePanelTab === tab) {
          s.sidePanelVisible = false;
        } else {
          s.sidePanelTab = tab;
          s.sidePanelVisible = true;
        }
      }),
      toggleTerminal: () => set((s) => {
        s.terminalVisible = !s.terminalVisible;
        // The terminal tray lives INSIDE the side panel; turning it on while
        // the panel is hidden would light the icon with nothing appearing.
        // (Same force-show precedent as setSidePanelTab.)
        if (s.terminalVisible) s.sidePanelVisible = true;
      }),
      setTerminalVisible: (v) => set((s) => {
        s.terminalVisible = v;
        if (v) s.sidePanelVisible = true;
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
      openNewConversation: () => set((s) => { s.newConversationOpen = true; }),
      closeNewConversation: () => set((s) => { s.newConversationOpen = false; }),
      toggleNewConversation: () => set((s) => { s.newConversationOpen = !s.newConversationOpen; }),
      setSettingsSection: (section) => set((s) => { s.settingsSection = section; }),
      requestSearchFocus: () => set((s) => {
        s.sidePanelTab = "search";
        s.sidePanelVisible = true;
        s.searchFocusRequest += 1;
      }),
      requestCloseActiveTab: () => set((s) => { s.closeTabRequest += 1; }),
      consumeCloseTabRequest: () => set((s) => { s.closeTabRequest = 0; }),
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
