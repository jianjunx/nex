import { useState, useEffect } from "react";
import { FolderTree, List, Loader2, RefreshCw, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useGitStore } from "../../stores/git.store";
import { useProjectStore } from "../../stores/project.store";
import { BranchSelector } from "./BranchSelector";
import { ChangesSection } from "./ChangesSection";
import { HistorySection } from "./HistorySection";
import { GitActionsMenu, OpLogPanel } from "./GitActionsMenu";
import { GitErrorDialog } from "./GitErrorDialog";

export function GitPanel() {
  const {
    status,
    statusLoading,
    opRunning,
    error,
    clearError,
    refresh,
    loadBranches,
    loadStashes,
    push,
    treeView,
    setTreeView,
  } = useGitStore();
  const projects = useProjectStore((s) => s.projects);
  const activeProjectId = useProjectStore((s) => s.activeProjectId);
  const project = projects.find((p) => p.id === activeProjectId);
  const [branchSelectorOpen, setBranchSelectorOpen] = useState(false);

  useEffect(() => {
    if (project) refresh(project.path);
  }, [project?.path]);

  if (!project) return <div className="px-3 py-4 text-sm text-[var(--text-tertiary)]">还没有打开项目</div>;

  const ahead = status?.ahead ?? 0;
  const behind = status?.behind ?? 0;
  const pushing = opRunning === "推送";
  const busy = statusLoading || !!opRunning;

  return (
    <div className="flex flex-col h-full overflow-hidden text-sm">
      {/* Header */}
      <div className="nex-material-toolbar flex items-center gap-1.5 border-b border-[color:var(--hairline-soft)] px-3 py-2.5">
        {/* 分支切换下拉面板（触发器在内） */}
        <BranchSelector projectPath={project.path} open={branchSelectorOpen} onOpenChange={setBranchSelectorOpen} />
        {status && (ahead > 0 || behind > 0) && (
          <span className="inline-flex items-center gap-1 text-xs tabular-nums">
            {ahead > 0 && (
              <span data-testid="git-ahead" className="text-[var(--error)]">
                ↑{ahead}
              </span>
            )}
            {behind > 0 && (
              <span data-testid="git-behind" className="text-[var(--success)]">
                ↓{behind}
              </span>
            )}
          </span>
        )}
        <div className="flex-1" />
        {ahead > 0 && (
          <Button
            variant="ghost"
            size="xs"
            data-testid="git-push-button"
            title="推送"
            disabled={busy}
            className="gap-1 border border-[color:var(--hairline-soft)] bg-[color:color-mix(in_srgb,var(--material-panel)_78%,transparent)] shadow-[inset_0_1px_0_0_var(--edge-highlight-soft)]"
            onClick={() => void push(project.path)}
          >
            {pushing ? <Loader2 size={13} className="animate-spin" /> : <Upload size={13} />}
            Push
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon-xs"
          title="刷新"
          disabled={busy}
          onClick={() => {
            refresh(project.path);
            loadBranches(project.path);
            loadStashes(project.path);
          }}
        >
          <RefreshCw size={13} className={statusLoading ? "animate-spin" : ""} />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          data-testid="toggle-tree-view"
          title={treeView ? "切换为列表视图" : "切换为树视图"}
          onClick={() => setTreeView(!treeView)}
        >
          {treeView ? <List size={13} /> : <FolderTree size={13} />}
        </Button>
        <GitActionsMenu projectPath={project.path} onOpenBranchSelector={() => setBranchSelectorOpen(true)} />
      </div>

      {/* File lists + commit box（提交框在 ChangesSection 内「更改」标题下方） */}
      <ChangesSection projectPath={project.path} />

      <HistorySection projectPath={project.path} />
      <OpLogPanel />

      <GitErrorDialog open={!!error} error={error} onClose={clearError} />
    </div>
  );
}
