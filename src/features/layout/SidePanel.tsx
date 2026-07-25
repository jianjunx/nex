import { useUiStore } from "../../stores/ui.store";
import { Card } from "@glinui/ui";
import { FileTree } from "../files/FileTree";
import { GitPanel } from "../git/GitPanel";
import { SearchPanel } from "../search/SearchPanel";
import { TerminalPanel } from "../terminal/TerminalPanel";

export function SidePanel() {
  const { sidePanelTab, terminalVisible, terminalHeight } = useUiStore();

  return (
    <div className="flex flex-col h-full gap-3 p-3">
      {/* Upper: active tab content, rendered as a Glin UI glass panel */}
      <Card variant="glass" className="flex-1 overflow-hidden !p-0">
        {sidePanelTab === "files" && <FileTree />}
        {sidePanelTab === "git" && <GitPanel />}
        {sidePanelTab === "search" && <SearchPanel />}
      </Card>

      {/* Lower: terminal */}
      {terminalVisible && (
        <div
          className="border border-[color:var(--border-subtle)] bg-[var(--glass-base-bg)] rounded-xl overflow-hidden"
          style={{ height: terminalHeight }}
        >
          <TerminalPanel />
        </div>
      )}
    </div>
  );
}
