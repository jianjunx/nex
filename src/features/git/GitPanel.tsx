import { useState, useEffect } from "react";
import { GitBranch, Plus, Minus, Check } from "lucide-react";
import { GlassButton } from "../../ui";
import { useGitStore } from "../../stores/git.store";
import { useProjectStore } from "../../stores/project.store";

export function GitPanel() {
  const { status, diff, diffFile, loading, error, refresh, viewDiff, stage, unstage, commit } = useGitStore();
  const projects = useProjectStore((s) => s.projects);
  const activeProjectId = useProjectStore((s) => s.activeProjectId);
  const project = projects.find((p) => p.id === activeProjectId);
  const [commitMsg, setCommitMsg] = useState("");

  useEffect(() => {
    if (project) refresh(project.path);
  }, [project?.path]);

  if (!project) return <div className="p-3 text-sm text-[var(--text-tertiary)]">No project</div>;

  const handleCommit = async () => {
    if (!commitMsg.trim()) return;
    await commit(project.path, commitMsg);
    setCommitMsg("");
    refresh(project.path);
  };

  const handleStage = async (files: string[]) => {
    await stage(project.path, files);
    refresh(project.path);
  };

  const handleUnstage = async (files: string[]) => {
    await unstage(project.path, files);
    refresh(project.path);
  };

  const staged = status?.files.filter((f) => f.staged) || [];
  const unstaged = status?.files.filter((f) => !f.staged) || [];

  return (
    <div className="flex flex-col h-full text-sm overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-3.5 border-b border-[color:var(--border-subtle)]">
        <GitBranch size={14} className="text-[var(--accent)]" />
        <span className="text-[var(--text-primary)] font-medium">{status?.branch || "—"}</span>
        {status && (status.ahead > 0 || status.behind > 0) && (
          <span className="text-[var(--text-tertiary)] text-xs">↑{status.ahead} ↓{status.behind}</span>
        )}
      </div>

      {/* File lists */}
      <div className="flex-1 overflow-y-auto px-4 py-3">
        {unstaged.length > 0 && (
          <div className="mb-4">
            <div className="flex items-center justify-between px-2 py-1.5 text-xs text-[var(--text-tertiary)]">
              <span>Changes ({unstaged.length})</span>
              <GlassButton size="sm" variant="ghost" disabled={loading} onClick={() => handleStage(unstaged.map((f) => f.path))}>
                <Plus size={10} />
              </GlassButton>
            </div>
            {unstaged.map((f) => (
              <div key={f.path} className="flex items-center gap-2 px-2.5 py-1.5 hover:bg-[var(--overlay-hover)] rounded-[var(--radius-sm)] cursor-pointer" onClick={() => viewDiff(project.path, f.path, false)}>
                <span className="text-[var(--warning)] text-xs w-3">{f.status[0].toUpperCase()}</span>
                <span className="text-[var(--text-secondary)] truncate">{f.path}</span>
              </div>
            ))}
          </div>
        )}
        {staged.length > 0 && (
          <div>
            <div className="flex items-center justify-between px-2 py-1.5 text-xs text-[var(--text-tertiary)]">
              <span>Staged ({staged.length})</span>
              <GlassButton size="sm" variant="ghost" disabled={loading} onClick={() => handleUnstage(staged.map((f) => f.path))}>
                <Minus size={10} />
              </GlassButton>
            </div>
            {staged.map((f) => (
              <div key={f.path} className="flex items-center gap-2 px-2.5 py-1.5 hover:bg-[var(--overlay-hover)] rounded-[var(--radius-sm)] cursor-pointer" onClick={() => viewDiff(project.path, f.path, true)}>
                <span className="text-[var(--success)] text-xs w-3">{f.status[0].toUpperCase()}</span>
                <span className="text-[var(--text-secondary)] truncate">{f.path}</span>
              </div>
            ))}
          </div>
        )}
        {error && <p className="text-[var(--error)] text-xs px-2 mt-2">{error}</p>}
      </div>

      {/* Commit area */}
      <div className="p-4 border-t border-[color:var(--border-subtle)]">
        <input
          value={commitMsg}
          onChange={(e) => setCommitMsg(e.target.value)}
          placeholder="Commit message..."
          className="w-full bg-[var(--glass-interactive-bg)] border border-[color:var(--border-default)] rounded-[var(--radius-md)] px-4 py-2.5 text-sm text-[var(--text-primary)] outline-none focus:border-[color:var(--border-focus)] transition-colors"
          onKeyDown={(e) => e.key === "Enter" && handleCommit()}
        />
        <GlassButton variant="accent" className="mt-3 w-full" disabled={loading || !commitMsg.trim()} onClick={handleCommit}>
          <Check size={14} className="mr-2" /> Commit
        </GlassButton>
      </div>

      {/* Diff viewer */}
      {diff && diffFile && (
        <div className="border-t border-[color:var(--border-subtle)] max-h-[200px] overflow-auto">
          <div className="px-4 py-2 text-xs text-[var(--text-tertiary)]">{diffFile}</div>
          <pre className="px-4 pb-4 text-xs font-mono text-[var(--text-secondary)] whitespace-pre-wrap leading-relaxed">
            {diff.split("\n").map((line, i) => (
              <div key={i} className={line.startsWith("+") ? "text-[var(--success)]" : line.startsWith("-") ? "text-[var(--error)]" : ""}>
                {line}
              </div>
            ))}
          </pre>
        </div>
      )}
    </div>
  );
}
