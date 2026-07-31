import { useEffect, useRef, useState } from "react";
import { ChevronRight, RefreshCw } from "lucide-react";
import { useGitStore } from "../../stores/git.store";

/**
 * 相对时间。后端 CommitInfo.time 为 Unix 秒（repository::get_log 取
 * c.time().seconds()），故先除以 1000 再作差。
 */
function relTime(unixSeconds: number): string {
  const delta = Math.max(0, Math.floor(Date.now() / 1000) - unixSeconds);
  if (delta < 60) return "刚刚";
  if (delta < 3600) return `${Math.floor(delta / 60)} 分钟前`;
  if (delta < 86400) return `${Math.floor(delta / 3600)} 小时前`;
  return `${Math.floor(delta / 86400)} 天前`;
}

/** 底部可折叠提交历史区；数据走 T7 loadHistory（gitLog 封装 T6 已定义）。 */
export function HistorySection({ projectPath }: { projectPath: string }) {
  const commits = useGitStore((s) => s.commits);
  const historyLoading = useGitStore((s) => s.historyLoading);
  const historyOpen = useGitStore((s) => s.historyOpen);
  const setHistoryOpen = useGitStore((s) => s.setHistoryOpen);
  const loadHistory = useGitStore((s) => s.loadHistory);
  const openCommitDiff = useGitStore((s) => s.openCommitDiff);

  const [selectedCommit, setSelectedCommit] = useState<string | null>(null);

  // GitPanel 挂载时若历史为空自动加载一次；项目切换则无条件重载——
  // commits 是全局 store 字段、切项目不清空（R1：只按「空」判定会让 B 项目
  // 显示 A 项目的提交，点击还拿 A 的 hash 配 B 的路径出错）。
  const prevPath = useRef(projectPath);
  useEffect(() => {
    const projectChanged = prevPath.current !== projectPath;
    prevPath.current = projectPath;
    if (commits.length === 0 || projectChanged) void loadHistory(projectPath);
  }, [projectPath, commits.length, loadHistory]);

  return (
    <div className="border-t border-[color:var(--border-subtle)]">
      <div
        className="flex cursor-pointer items-center gap-1.5 px-3 py-2 text-xs text-[var(--text-tertiary)] hover:bg-[var(--overlay-hover)]"
        onClick={() => setHistoryOpen(!historyOpen)}
      >
        <ChevronRight size={12} className={`transition-transform duration-150 ${historyOpen ? "rotate-90" : ""}`} />
        <span className="font-medium">历史</span>
        {commits.length > 0 && <span>({commits.length})</span>}
        <div className="flex-1" />
        <button
          title="刷新历史"
          className="rounded p-0.5 transition-colors duration-100 hover:bg-[var(--overlay-hover)] hover:text-[var(--text-primary)]"
          onClick={(e) => {
            e.stopPropagation();
            void loadHistory(projectPath);
          }}
        >
          <RefreshCw size={12} className={historyLoading ? "animate-spin" : ""} />
        </button>
      </div>
      {historyOpen && (
        <div className="max-h-56 overflow-y-auto pb-1">
          {commits.length === 0 && (
            <div className="px-3 py-1.5 text-xs text-[var(--text-tertiary)]">暂无提交历史</div>
          )}
          {commits.map((c) => (
            <div
              key={c.hash}
              data-testid={`commit-${c.hash}`}
              className={`flex cursor-pointer items-baseline gap-2 px-3 py-1 text-xs transition-colors duration-100 hover:bg-[var(--overlay-hover)] ${
                selectedCommit === c.hash ? "bg-[var(--accent)]/15" : ""
              }`}
              onClick={() => {
                setSelectedCommit(c.hash);
                openCommitDiff(projectPath, c.hash);
              }}
            >
              <span className="shrink-0 font-mono text-[var(--accent)]">{c.hash}</span>
              <span className="min-w-0 flex-1 truncate text-[var(--text-secondary)]">{c.message}</span>
              <span className="shrink-0 text-[var(--text-tertiary)]">{c.author}</span>
              <span className="shrink-0 text-[var(--text-tertiary)]">{relTime(c.time)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
