import { useState, useEffect } from "react";
import { FolderTree, List, RefreshCw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useGitStore } from "../../stores/git.store";
import { useProjectStore } from "../../stores/project.store";
import { BranchSelector } from "./BranchSelector";
import { ChangesSection } from "./ChangesSection";
import { HistorySection } from "./HistorySection";
import { GitActionsMenu, OpLogPanel } from "./GitActionsMenu";

export function GitPanel() {
  const { status, statusLoading, opRunning, error, clearError, refresh, loadBranches, loadStashes, treeView, setTreeView } =
    useGitStore();
  const projects = useProjectStore((s) => s.projects);
  const activeProjectId = useProjectStore((s) => s.activeProjectId);
  const project = projects.find((p) => p.id === activeProjectId);
  const [branchSelectorOpen, setBranchSelectorOpen] = useState(false);

  useEffect(() => {
    if (project) refresh(project.path);
  }, [project?.path]);

  if (!project) return <div className="p-3 text-sm text-[var(--text-tertiary)]">No project</div>;

  return (
    <div className="flex flex-col h-full text-sm overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-1.5 px-3 py-2.5 border-b border-[color:var(--border-subtle)]">
        {/* 分支切换下拉面板（触发器在内） */}
        <BranchSelector projectPath={project.path} open={branchSelectorOpen} onOpenChange={setBranchSelectorOpen} />
        {status && (status.ahead > 0 || status.behind > 0) && (
          <span className="text-[var(--text-tertiary)] text-xs">↑{status.ahead} ↓{status.behind}</span>
        )}
        <div className="flex-1" />
        <Button
          variant="ghost"
          size="icon-xs"
          title="刷新"
          disabled={statusLoading || !!opRunning}
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
      {error && (
        <div className="flex items-start gap-1.5 border-b border-[color:var(--border-subtle)] px-3 py-1.5">
          <p className="flex-1 break-words text-xs text-[var(--error)]">{error}</p>
          <button
            data-testid="dismiss-git-error"
            title="关闭错误提示"
            className="shrink-0 rounded p-0.5 text-[var(--text-tertiary)] transition-colors duration-100 hover:bg-[var(--overlay-hover)] hover:text-[var(--text-primary)]"
            onClick={clearError}
          >
            <X size={12} />
          </button>
        </div>
      )}

      {/* File lists + commit box（提交框在 ChangesSection 内「更改」标题下方） */}
      <ChangesSection projectPath={project.path} />

      <HistorySection projectPath={project.path} />
      <OpLogPanel />
    </div>
  );
}
