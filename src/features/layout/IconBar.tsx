import { FolderTree, GitBranch, Search, Settings, Terminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useUiStore, type SidePanelTab } from "../../stores/ui.store";
import { useGitStore } from "../../stores/git.store";

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
  // Live changes count drives the Git badge (hidden when zero).
  const gitChangesCount = useGitStore((s) => s.status?.files.length ?? 0);

  return (
    <div className="flex flex-col items-center py-2 gap-1 w-10 border-l border-[color:var(--border-subtle)] bg-[var(--background)] mr-1 rounded-l-[var(--radius-md)]">
      {tabs.map(({ id, icon: Icon, label }) => {
        const active = sidePanelVisible && sidePanelTab === id;
        const badge = id === "git" && gitChangesCount > 0 ? gitChangesCount : 0;
        return (
          <Button
            key={id}
            variant="ghost"
            size="icon-sm"
            title={label}
            onClick={() => toggleSidePanelTab(id)}
            className={`relative transition-colors duration-150 ${
              active
                ? "bg-[var(--accent)]/15 text-[var(--accent)]"
                : "text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]"
            }`}
          >
            <Icon size={16} />
            {badge > 0 && (
              <span
                data-git-badge
                className="absolute right-0 top-0 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-[var(--accent)] px-0.5 text-[9px] font-semibold leading-none text-white"
              >
                {badge > 99 ? "99+" : badge}
              </span>
            )}
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
