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
      {(
        [
          { id: "files", label: "文件", icon: FolderTree },
          { id: "search", label: "搜索", icon: Search },
          { id: "git", label: "Git", icon: GitBranch },
        ] as const
      ).map(({ id, label, icon: Icon }) => (
        <Button
          key={id}
          variant="ghost"
          size="icon-sm"
          title={label}
          aria-label={label}
          aria-pressed={visible && selected === id}
          aria-controls="workspace-side-panel"
          className={
            visible && selected === id
              ? "text-[var(--accent)]"
              : "text-[var(--text-tertiary)]"
          }
          onClick={() => useUiStore.getState().toggleSidePanelTab(id)}
        >
          <Icon size={15} />
          {id === "git" && count > 0 && (
            <span className="text-[10px]">{count > 99 ? "99+" : count}</span>
          )}
        </Button>
      ))}
      <Button
        variant="ghost"
        size="icon-sm"
        title="终端"
        aria-label="终端"
        aria-pressed={terminal}
        onClick={() => useUiStore.getState().toggleTerminal()}
      >
        <Terminal size={15} />
      </Button>
    </div>
  );
}
