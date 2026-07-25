import { useUiStore } from "../../stores/ui.store";
import { FileTree } from "../files/FileTree";
import { GitPanel } from "../git/GitPanel";
import { TerminalPanel } from "../terminal/TerminalPanel";

export function SidePanel() {
  const { sidePanelTab, terminalVisible, terminalHeight } = useUiStore();

  return (
    <div className="flex flex-col h-full">
      {/* Upper: active tab content */}
      <div className="flex-1 overflow-hidden">
        {sidePanelTab === "files" && <FileTree />}
        {sidePanelTab === "git" && <GitPanel />}
        {sidePanelTab === "search" && <div className="p-3 text-sm text-[var(--text-tertiary)]">Search (coming soon)</div>}
      </div>

      {/* Lower: terminal */}
      {terminalVisible && (
        <div className="border-t border-white/[0.06]" style={{ height: terminalHeight }}>
          <TerminalPanel />
        </div>
      )}
    </div>
  );
}
