import { FolderTree, GitBranch, Search, Settings } from "lucide-react";
import { useUiStore, type SidePanelTab } from "../../stores/ui.store";

const tabs: { id: SidePanelTab; icon: typeof FolderTree; label: string }[] = [
  { id: "files", icon: FolderTree, label: "文件" },
  { id: "git", icon: GitBranch, label: "Git" },
  { id: "search", icon: Search, label: "搜索" },
];

export function IconBar() {
  const { sidePanelTab, setSidePanelTab } = useUiStore();

  return (
    <div className="flex flex-col items-center py-2 gap-1 w-10 border-l border-white/[0.06] bg-[var(--glass-base-bg)]">
      {tabs.map(({ id, icon: Icon, label }) => (
        <button
          key={id}
          title={label}
          onClick={() => setSidePanelTab(id)}
          className={`p-2 rounded-[var(--radius-sm)] transition-colors ${
            sidePanelTab === id ? "bg-white/[0.10] text-[var(--text-primary)]" : "text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]"
          }`}
        >
          <Icon size={16} />
        </button>
      ))}
      <div className="flex-1" />
      <button
        title="设置"
        className="p-2 rounded-[var(--radius-sm)] text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] transition-colors"
      >
        <Settings size={16} />
      </button>
    </div>
  );
}
