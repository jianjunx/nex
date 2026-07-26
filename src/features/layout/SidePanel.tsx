import { useUiStore } from "../../stores/ui.store";
import { FileTree } from "../files/FileTree";
import { GitPanel } from "../git/GitPanel";
import { SearchPanel } from "../search/SearchPanel";
import { SettingsPanel } from "../settings/SettingsPanel";
import { TerminalPanel } from "../terminal/TerminalPanel";

export function SidePanel() {
  const { sidePanelTab, terminalVisible, terminalHeight } = useUiStore();

  return (
    <div className="flex flex-col h-full">
      {/* Upper: active tab content */}
      <div className="flex-1 overflow-hidden">
        {sidePanelTab === "files" && <FileTree />}
        {sidePanelTab === "git" && <GitPanel />}
        {sidePanelTab === "search" && <SearchPanel />}
        {sidePanelTab === "settings" && <SettingsPanel />}
      </div>

      {/* Lower: terminal */}
      {terminalVisible && (
        <div className="border-t border-[color:var(--border-subtle)] bg-[var(--glass-1-surface)]" style={{ height: terminalHeight }}>
          <TerminalPanel />
        </div>
      )}
    </div>
  );
}
