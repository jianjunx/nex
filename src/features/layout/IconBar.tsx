import { FolderTree, GitBranch, Search, Settings, Terminal } from "lucide-react";
import { Button } from "@glinui/ui";
import { useUiStore, type SidePanelTab } from "../../stores/ui.store";

const tabs: { id: SidePanelTab; icon: typeof FolderTree; label: string }[] = [
  { id: "files", icon: FolderTree, label: "文件" },
  { id: "git", icon: GitBranch, label: "Git" },
  { id: "search", icon: Search, label: "搜索" },
];

export function IconBar() {
  const { sidePanelTab, setSidePanelTab, terminalVisible, toggleTerminal } = useUiStore();

  return (
    <div className="flex flex-col items-center py-3 gap-2 w-12 border-l border-[color:var(--border-subtle)] bg-[var(--glass-1-surface)] mr-1.5 rounded-l-[var(--radius-md)]">
      {tabs.map(({ id, icon: Icon, label }) => (
        <Button
          key={id}
          variant="ghost"
          size="sm"
          title={label}
          onClick={() => setSidePanelTab(id)}
          className={
            sidePanelTab === id
              ? "bg-[var(--overlay-active)] text-[var(--text-primary)]"
              : "text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]"
          }
        >
          <Icon size={16} />
        </Button>
      ))}
      <div className="flex-1" />
      <Button
        variant="ghost"
        size="sm"
        title="终端"
        onClick={toggleTerminal}
        className={
          terminalVisible
            ? "bg-[var(--overlay-active)] text-[var(--text-primary)]"
            : "text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]"
        }
      >
        <Terminal size={16} />
      </Button>
      <Button
        variant="ghost"
        size="sm"
        title="设置"
        className="text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]"
      >
        <Settings size={16} />
      </Button>
    </div>
  );
}
