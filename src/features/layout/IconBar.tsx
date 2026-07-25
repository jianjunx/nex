import { FolderTree, GitBranch, Search, Settings, Terminal } from "lucide-react";
import { useUiStore, type SidePanelTab } from "../../stores/ui.store";

const tabs: { id: SidePanelTab; icon: typeof FolderTree; label: string }[] = [
  { id: "files", icon: FolderTree, label: "文件" },
  { id: "git", icon: GitBranch, label: "Git" },
  { id: "search", icon: Search, label: "搜索" },
];

export function IconBar() {
  const { sidePanelTab, setSidePanelTab, terminalVisible, toggleTerminal } = useUiStore();

  return (
    <div className="flex flex-col items-center py-3 gap-2 w-12 border-l border-[color:var(--border-subtle)] bg-[var(--glass-base-bg)] mr-1.5 rounded-l-[var(--radius-md)]">
      {tabs.map(({ id, icon: Icon, label }) => (
        <button
          key={id}
          title={label}
          onClick={() => setSidePanelTab(id)}
          className={`p-2.5 rounded-[var(--radius-sm)] transition-colors ${
            sidePanelTab === id ? "bg-[var(--overlay-active)] text-[var(--text-primary)]" : "text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] hover:bg-[var(--overlay-ghost)]"
          }`}
        >
          <Icon size={16} />
        </button>
      ))}
      <div className="flex-1" />
      <button
        title="终端"
        onClick={toggleTerminal}
        className={`p-2.5 rounded-[var(--radius-sm)] transition-colors ${
          terminalVisible ? "bg-[var(--overlay-active)] text-[var(--text-primary)]" : "text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] hover:bg-[var(--overlay-ghost)]"
        }`}
      >
        <Terminal size={16} />
      </button>
      <button
        title="设置"
        className="p-2.5 rounded-[var(--radius-sm)] text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] hover:bg-[var(--overlay-ghost)] transition-colors"
      >
        <Settings size={16} />
      </button>
    </div>
  );
}
