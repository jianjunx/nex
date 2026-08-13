import FileIcon from "../../files/FileIcon";
import { fileBasename } from "../../editor/pathUtils";
import { openPathToken } from "./pathToken";
import type { ChangedFile } from "./filesChanged";

export function FilesChangedCard({ files }: { files: ChangedFile[] }) {
  if (files.length === 0) return null;

  const reviewAll = () => {
    void (async () => {
      for (const f of files) await openPathToken(f.path);
      if (files[0]) await openPathToken(files[0].path);
    })();
  };

  return (
    <div className="max-w-[96%] overflow-hidden rounded-[var(--radius-md)] border border-[color:var(--glass-border)] bg-[var(--glass-3-surface)] shadow-[inset_0_1px_0_0_var(--edge-highlight)]">
      <div className="flex items-center justify-between gap-2 px-3 py-2">
        <span className="text-xs text-[var(--text-secondary)]">
          修改了 {files.length} 个文件
        </span>
        <button
          type="button"
          className="shrink-0 cursor-pointer text-xs text-[var(--text-tertiary)] transition-colors hover:text-[var(--text-primary)]"
          onClick={reviewAll}
        >
          查看
        </button>
      </div>
      <ul>
        {files.map((f) => {
          const name = fileBasename(f.path);
          return (
            <li key={f.path}>
              <button
                type="button"
                title={f.path}
                className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-[var(--overlay-hover)]"
                onClick={() => void openPathToken(f.path)}
              >
                <FileIcon filename={name} size={14} className="shrink-0" />
                <span className="min-w-0 flex-1 truncate text-sm text-[var(--text-primary)]">{name}</span>
                <span className="flex shrink-0 items-center gap-1.5 font-mono text-[11px] tabular-nums">
                  {f.additions > 0 && (
                    <span className="text-[var(--success)]">+{f.additions}</span>
                  )}
                  {f.deletions > 0 && (
                    <span className="text-[var(--error)]">−{f.deletions}</span>
                  )}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
