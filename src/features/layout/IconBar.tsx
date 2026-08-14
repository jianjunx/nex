import { FolderTree, GitBranch, Search, Settings, Terminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useUiStore, type SidePanelTab } from "../../stores/ui.store";
import { useGitStore } from "../../stores/git.store";
import { ProjectRail } from "../projects/ProjectRail";

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
    <div className="nex-material-panel flex w-11 flex-col items-center border-l border-[color:var(--hairline-soft)] py-2.5">
      <div className="flex flex-col items-center gap-2">
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
              className={`nex-interactive-chrome nex-pressable relative rounded-[var(--radius-md)] border border-transparent ${
                active
                  ? "bg-[color:color-mix(in_srgb,var(--material-elevated)_88%,transparent)] text-[var(--accent)] shadow-[inset_0_1px_0_0_var(--edge-highlight-bright),0_10px_24px_-18px_rgba(0,0,0,0.78)] border-[color:var(--hairline-soft)]"
                  : "text-[var(--text-tertiary)] hover:bg-[color:color-mix(in_srgb,var(--material-floating)_72%,transparent)] hover:text-[var(--text-secondary)] hover:border-[color:var(--hairline-soft)]"
              }`}
            >
              <Icon size={16} />
              {badge > 0 && (
                <span
                  data-git-badge
                  className="absolute -right-0.5 -bottom-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-[var(--accent)] px-0.5 text-[9px] font-semibold leading-none text-white"
                >
                  {badge > 99 ? "99+" : badge}
                </span>
              )}
            </Button>
          );
        })}
        <ProjectRail />
      </div>
      <div className="flex-1" />
      <div className="mx-2 mb-1.5 h-px w-4 bg-[color:var(--hairline-soft)]" />
      <Button
        variant="ghost"
        size="icon-sm"
        title="终端"
        onClick={toggleTerminal}
        className={`nex-interactive-chrome nex-pressable relative rounded-[var(--radius-md)] border border-transparent ${
          terminalVisible
            ? "bg-[color:color-mix(in_srgb,var(--material-elevated)_88%,transparent)] text-[var(--accent)] shadow-[inset_0_1px_0_0_var(--edge-highlight-bright),0_10px_24px_-18px_rgba(0,0,0,0.78)] border-[color:var(--hairline-soft)]"
            : "text-[var(--text-tertiary)] hover:bg-[color:color-mix(in_srgb,var(--material-floating)_72%,transparent)] hover:text-[var(--text-secondary)] hover:border-[color:var(--hairline-soft)]"
        }`}
      >
        <Terminal size={16} />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        title="设置"
        onClick={() => openSettings()}
        className={`nex-interactive-chrome nex-pressable relative rounded-[var(--radius-md)] border border-transparent ${
          settingsOpen
            ? "bg-[color:color-mix(in_srgb,var(--material-elevated)_88%,transparent)] text-[var(--accent)] shadow-[inset_0_1px_0_0_var(--edge-highlight-bright),0_10px_24px_-18px_rgba(0,0,0,0.78)] border-[color:var(--hairline-soft)]"
            : "text-[var(--text-tertiary)] hover:bg-[color:color-mix(in_srgb,var(--material-floating)_72%,transparent)] hover:text-[var(--text-secondary)] hover:border-[color:var(--hairline-soft)]"
        }`}
      >
        <Settings size={16} />
      </Button>
    </div>
  );
}
