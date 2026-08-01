import { FolderTree, GitBranch, Search, Settings, Terminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useUiStore, type SidePanelTab } from "../../stores/ui.store";

const tabs: { id: SidePanelTab; icon: typeof FolderTree; label: string }[] = [
  { id: "files", icon: FolderTree, label: "文件" },
  { id: "git", icon: GitBranch, label: "Git" },
  { id: "search", icon: Search, label: "搜索" },
];

export function IconBar() {
  const {
    sidePanelTab,
    sidePanelVisible,
    toggleSidePanelTab,
    terminalVisible,
    toggleTerminal,
    settingsOpen,
    openSettings,
  } = useUiStore();

  return (
    <div className="flex flex-col items-center py-2 gap-1 w-10 border-l border-[color:var(--border-subtle)] bg-[var(--background)] mr-1 rounded-l-[var(--radius-md)]">
      {tabs.map(({ id, icon: Icon, label }) => {
        const active = sidePanelVisible && sidePanelTab === id;
        return (
          <Button
            key={id}
            variant="ghost"
            size="icon-sm"
            title={label}
            onClick={() => toggleSidePanelTab(id)}
            className={`transition-colors duration-150 ${
              active
                ? "bg-[var(--accent)]/15 text-[var(--accent)]"
                : "text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]"
            }`}
          >
            <Icon size={16} />
          </Button>
        );
      })}
      <div className="flex-1" />
      <Button
        variant="ghost"
        size="icon-sm"
        title="终端"
        onClick={toggleTerminal}
        className={`transition-colors duration-150 ${
          terminalVisible
            ? "bg-[var(--accent)]/15 text-[var(--accent)]"
            : "text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]"
        }`}
      >
        <Terminal size={16} />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        title="设置"
        onClick={() => openSettings()}
        className={`transition-colors duration-150 ${
          settingsOpen
            ? "bg-[var(--accent)]/15 text-[var(--accent)]"
            : "text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]"
        }`}
      >
        <Settings size={16} />
      </Button>
    </div>
  );
}
