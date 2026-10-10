import { FolderTree, GitBranch, Search, Terminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useUiStore } from "@/stores/ui.store";
import { useGitStore } from "@/stores/git.store";

export function IconBar() {
  const visible = useUiStore((s) => s.sidePanelVisible);
  const selected = useUiStore((s) => s.sidePanelTab);
  const terminal = useUiStore((s) => s.terminalVisible);
  const count = useGitStore((s) =>
    s.hasRepo ? (s.status?.files.length ?? 0) : 0,
  );
  return (
    <div
      role="toolbar"
      aria-label="工作区工具"
      className="flex shrink-0 items-center gap-1"
    >
      <Button
        variant="ghost"
        size="icon-sm"
        title="终端"
        aria-label="终端"
        aria-pressed={terminal}
        className={terminal ? "text-[var(--accent)]" : "text-[var(--text-tertiary)]"}
        onClick={() => useUiStore.getState().toggleTerminal()}
      >
        <Terminal size={15} />
      </Button>
      {(
        [
          { id: "files", label: "文件", icon: FolderTree },
          { id: "git", label: "Git", icon: GitBranch },
          { id: "search", label: "搜索", icon: Search },
        ] as const
      ).map(({ id, label, icon: Icon }) => {
        const badge = id === "git" && count > 0 ? (count > 99 ? "99+" : String(count)) : null;
        return (
          <Button
            key={id}
            variant="ghost"
            size="icon-sm"
            title={badge ? `${label}（${count} 项更改）` : label}
            aria-label={label}
            aria-pressed={visible && selected === id}
            aria-controls="workspace-side-panel"
            className={`relative ${
              visible && selected === id
                ? "text-[var(--accent)]"
                : "text-[var(--text-tertiary)]"
            }`}
            onClick={() => useUiStore.getState().toggleSidePanelTab(id)}
          >
            <Icon size={15} />
            {badge && (
              <span
                aria-hidden
                className="pointer-events-none absolute top-0.5 right-0 flex h-[14px] min-w-[14px] items-center justify-center rounded-full bg-[var(--text-primary)] px-1 text-[9px] font-semibold leading-none text-[var(--material-canvas)]"
              >
                {badge}
              </span>
            )}
          </Button>
        );
      })}
    </div>
  );
}
