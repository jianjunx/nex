import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { persist } from "zustand/middleware";
import { useProjectStore } from "./project.store";

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
  /** Visible terminal tray for the *current* project (mirrored from by-project map). */
  terminalVisible: boolean;
  /** Per-project terminal tray visibility; survives project switches. */
  terminalVisibleByProject: Record<string, boolean>;
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
  /** Restore `terminalVisible` from the per-project map (call on project switch). */
  syncTerminalVisibleForProject: (projectId: string | null) => void;
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

function rememberTerminalVisible(s: UiState, visible: boolean) {
  s.terminalVisible = visible;
  if (visible) s.sidePanelVisible = true;
  const projectId = useProjectStore.getState().activeProjectId;
  if (projectId) s.terminalVisibleByProject[projectId] = visible;
}

// Persist layout state so the window reopens exactly as the user left it
// (panel visibility/width, terminal toggle/height, active side-panel tab).
export const useUiStore = create<UiState>()(
  persist(
    immer((set) => ({
      sidePanelVisible: true,
      sidePanelTab: "files",
      terminalVisible: false,
      terminalVisibleByProject: {},
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
        rememberTerminalVisible(s, !s.terminalVisible);
      }),
      setTerminalVisible: (v) => set((s) => {
        rememberTerminalVisible(s, v);
      }),
      syncTerminalVisibleForProject: (projectId) => set((s) => {
        if (!projectId) {
          s.terminalVisible = false;
          return;
        }
        if (Object.prototype.hasOwnProperty.call(s.terminalVisibleByProject, projectId)) {
          s.terminalVisible = !!s.terminalVisibleByProject[projectId];
          return;
        }
        // First visit for this project: migrate legacy single-flag once when
        // the map is still empty; otherwise default to hidden.
        const inheritLegacy =
          Object.keys(s.terminalVisibleByProject).length === 0 && s.terminalVisible;
        const next = inheritLegacy;
        s.terminalVisibleByProject[projectId] = next;
        s.terminalVisible = next;
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
        terminalVisibleByProject: s.terminalVisibleByProject,
        sidePanelWidth: s.sidePanelWidth,
        terminalHeight: s.terminalHeight,
        editorVisible: s.editorVisible,
        editorWidth: s.editorWidth,
      }),
      // I-2: 水合时校验 sidePanelTab，防止陈旧持久化值（如旧版 "settings"）导致侧栏空白
      // Clamp panel sizes so corrupted persisted values cannot hide the UI.
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<UiState>;
        const merged = { ...current, ...p };
        const clamp = (n: unknown, min: number, max: number, fallback: number) => {
          if (typeof n !== "number" || !Number.isFinite(n)) return fallback;
          return Math.min(max, Math.max(min, n));
        };
        const byProject =
          p.terminalVisibleByProject &&
          typeof p.terminalVisibleByProject === "object" &&
          !Array.isArray(p.terminalVisibleByProject)
            ? p.terminalVisibleByProject
            : {};
        return {
          ...merged,
          sidePanelTab: sanitizeSidePanelTab(merged.sidePanelTab),
          terminalVisibleByProject: byProject,
          sidePanelWidth: clamp(merged.sidePanelWidth, 160, 800, current.sidePanelWidth),
          terminalHeight: clamp(merged.terminalHeight, 80, 800, current.terminalHeight),
          editorWidth: clamp(merged.editorWidth, 200, 2000, current.editorWidth),
        };
      },
    }
  )
);
