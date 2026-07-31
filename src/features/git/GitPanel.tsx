import { useState, useEffect } from "react";
import { GitBranch, ChevronDown, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useGitStore } from "../../stores/git.store";
import { useProjectStore } from "../../stores/project.store";
import { BranchSelector } from "./BranchSelector";
import { ChangesSection } from "./ChangesSection";
import { CommitSection } from "./CommitSection";
import { HistorySection } from "./HistorySection";
import { GitActionsMenu, OpLogPanel } from "./GitActionsMenu";

export function GitPanel() {
  const { status, diff, diffFile, statusLoading, opRunning, error, refresh, loadBranches, loadStashes } = useGitStore();
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
        <Button
          variant="ghost"
          size="xs"
          className="max-w-[55%] gap-1.5"
          onClick={() => setBranchSelectorOpen(true)}
        >
          <GitBranch size={13} className="shrink-0 text-[var(--accent)]" />
          <span className="truncate">{status?.branch || "—"}</span>
          <ChevronDown size={12} className="shrink-0 text-[var(--text-tertiary)]" />
        </Button>
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
        <GitActionsMenu projectPath={project.path} onOpenBranchSelector={() => setBranchSelectorOpen(true)} />
      </div>
      {error && (
        <p className="border-b border-[color:var(--border-subtle)] px-4 py-1.5 text-xs text-[var(--error)]">{error}</p>
      )}

      {/* File lists */}
      <ChangesSection projectPath={project.path} />

      {/* Commit area */}
      <CommitSection projectPath={project.path} />

      {/* Diff viewer */}
      {diff && diffFile && (
        <div className="border-t border-[color:var(--border-subtle)] max-h-[200px] overflow-auto">
          <div className="px-4 py-2 text-xs text-[var(--text-tertiary)]">{diffFile}</div>
          {diff.includes("Binary files ") || diff.includes("GIT binary patch") ? (
            <div className="px-4 pb-4 text-xs text-[var(--text-tertiary)]">二进制文件 — 无法显示文本差异</div>
          ) : (
            <pre className="px-4 pb-4 text-xs font-mono text-[var(--text-secondary)] whitespace-pre-wrap leading-relaxed">
              {diff.split("\n").map((line, i) => (
                <div key={i} className={line.startsWith("+") ? "text-[var(--success)]" : line.startsWith("-") ? "text-[var(--error)]" : ""}>
                  {line}
                </div>
              ))}
            </pre>
          )}
        </div>
      )}
      <HistorySection projectPath={project.path} />
      <OpLogPanel />
      <BranchSelector
        projectPath={project.path}
        open={branchSelectorOpen}
        onOpenChange={setBranchSelectorOpen}
      />
    </div>
  );
}
