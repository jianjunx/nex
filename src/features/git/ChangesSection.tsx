import { useMemo, useState } from "react";
import {
  ChevronRight,
  File,
  FileDiff,
  Folder,
  Minus,
  Plus,
  Trash2,
  Undo2,
} from "lucide-react";
import { useGitStore } from "../../stores/git.store";
import { useFsStore } from "../../stores/fs.store";
import type { GitFileChange } from "../../bridge/tauri";
import { GitConfirmDialog } from "./GitConfirmDialog";

/** VSCode 状态色惯例：modified 黄 / added 绿 / deleted 红 / untracked 绿。 */
const STATUS_COLORS: Record<GitFileChange["status"], string> = {
  modified: "var(--warning)",
  added: "var(--success)",
  deleted: "var(--error)",
  untracked: "var(--success)",
};

// GitFileChange.path 是仓库根相对路径（/ 分隔）；fs store 的 openFile 需要
// 绝对路径。Windows 文件 API 同样接受 "/" 分隔符。
function absPath(projectPath: string, rel: string): string {
  return `${projectPath}/${rel}`;
}

function basename(rel: string): string {
  const i = rel.lastIndexOf("/");
  return i >= 0 ? rel.slice(i + 1) : rel;
}

interface PendingDiscard {
  files: string[];
  staged: boolean;
}

const ICON_BUTTON =
  "rounded p-0.5 text-[var(--text-tertiary)] transition-colors duration-100 hover:bg-[var(--overlay-hover)] hover:text-[var(--text-primary)] disabled:opacity-40";

interface FileRowProps {
  projectPath: string;
  file: GitFileChange;
  /** 列表模式显示完整相对路径，树模式显示 basename。 */
  display: string;
  busy: boolean;
  onDiscard: (pending: PendingDiscard) => void;
}

function FileRow({ projectPath, file, display, busy, onDiscard }: FileRowProps) {
  const stage = useGitStore((s) => s.stage);
  const unstage = useGitStore((s) => s.unstage);
  const openDiffInEditor = useGitStore((s) => s.openDiffInEditor);

  return (
    <div
      data-testid={`row-${file.path}`}
      className="group flex cursor-pointer items-center gap-1.5 rounded-[var(--radius-sm)] px-2 py-1 transition-colors duration-100 hover:bg-[var(--overlay-hover)]"
      onClick={() => void openDiffInEditor(projectPath, file.path, file.staged)}
    >
      <span className="w-3 shrink-0 text-center text-xs" style={{ color: STATUS_COLORS[file.status] }}>
        {file.status[0].toUpperCase()}
      </span>
      <span className="min-w-0 flex-1 truncate text-[var(--text-secondary)]">{display}</span>
      <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
        <button
          data-testid={`open-${file.path}`}
          title="打开文件"
          disabled={busy}
          className={ICON_BUTTON}
          onClick={(e) => {
            e.stopPropagation();
            void useFsStore.getState().openFile(absPath(projectPath, file.path));
          }}
        >
          <File size={13} />
        </button>
        <button
          data-testid={`diff-${file.path}`}
          title="打开 diff"
          disabled={busy}
          className={ICON_BUTTON}
          onClick={(e) => {
            e.stopPropagation();
            void openDiffInEditor(projectPath, file.path, file.staged);
          }}
        >
          <FileDiff size={13} />
        </button>
        {file.staged ? (
          <button
            data-testid={`unstage-${file.path}`}
            title="取消暂存"
            disabled={busy}
            className={ICON_BUTTON}
            onClick={(e) => {
              e.stopPropagation();
              void unstage(projectPath, [file.path]);
            }}
          >
            <Minus size={13} />
          </button>
        ) : (
          <button
            data-testid={`stage-${file.path}`}
            title="暂存"
            disabled={busy}
            className={ICON_BUTTON}
            onClick={(e) => {
              e.stopPropagation();
              void stage(projectPath, [file.path]);
            }}
          >
            <Plus size={13} />
          </button>
        )}
        <button
          data-testid={`discard-${file.path}`}
          title={file.staged ? "还原暂存更改" : "丢弃更改"}
          disabled={busy}
          className={`${ICON_BUTTON} hover:!text-[var(--error)]`}
          onClick={(e) => {
            e.stopPropagation();
            onDiscard({ files: [file.path], staged: file.staged });
          }}
        >
          <Trash2 size={13} />
        </button>
      </span>
    </div>
  );
}

interface TreeDir {
  name: string;
  /** 完整相对目录路径（作为折叠集合的键）。 */
  path: string;
  dirs: TreeDir[];
  files: GitFileChange[];
}

/** 按 "/" 分段把平铺文件列表挂成目录树；根级文件进 root.files。 */
function buildTree(files: GitFileChange[]): TreeDir {
  interface Builder {
    name: string;
    path: string;
    dirs: Map<string, Builder>;
    files: GitFileChange[];
  }
  const root: Builder = { name: "", path: "", dirs: new Map(), files: [] };
  for (const f of files) {
    const parts = f.path.split("/");
    parts.pop(); // 文件名留在 FileRow 里按 basename 显示
    let node = root;
    let acc = "";
    for (const part of parts) {
      acc = acc ? `${acc}/${part}` : part;
      let child = node.dirs.get(part);
      if (!child) {
        child = { name: part, path: acc, dirs: new Map(), files: [] };
        node.dirs.set(part, child);
      }
      node = child;
    }
    node.files.push(f);
  }
  const finalize = (b: Builder): TreeDir => ({
    name: b.name,
    path: b.path,
    dirs: [...b.dirs.values()]
      .sort((x, y) => x.name.localeCompare(y.name))
      .map(finalize),
    files: [...b.files].sort((x, y) => x.path.localeCompare(y.path)),
  });
  return finalize(root);
}

interface ChangeTreeViewProps {
  projectPath: string;
  files: GitFileChange[];
  busy: boolean;
  onDiscard: (pending: PendingDiscard) => void;
}

function ChangeTreeView({ projectPath, files, busy, onDiscard }: ChangeTreeViewProps) {
  const tree = useMemo(() => buildTree(files), [files]);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());

  const toggle = (path: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const renderDir = (dir: TreeDir, depth: number) => {
    const isCollapsed = collapsed.has(dir.path);
    return (
      <div key={`dir-${dir.path}`}>
        <div
          data-testid={`dir-${dir.path}`}
          className="flex cursor-pointer items-center gap-1.5 rounded-[var(--radius-sm)] px-2 py-1 hover:bg-[var(--overlay-hover)]"
          style={{ paddingLeft: depth * 10 + 10 }}
          onClick={() => toggle(dir.path)}
        >
          <ChevronRight
            size={12}
            className={`shrink-0 text-[var(--text-tertiary)] transition-transform duration-150 ${isCollapsed ? "" : "rotate-90"}`}
          />
          <Folder size={13} className="shrink-0 text-[var(--accent)]" />
          <span className="truncate text-[var(--text-secondary)]">{dir.name}</span>
        </div>
        {!isCollapsed && (
          <>
            {dir.dirs.map((d) => renderDir(d, depth + 1))}
            {dir.files.map((f) => (
              <div key={f.path} style={{ paddingLeft: (depth + 1) * 12 }}>
                <FileRow
                  projectPath={projectPath}
                  file={f}
                  display={basename(f.path)}
                  busy={busy}
                  onDiscard={onDiscard}
                />
              </div>
            ))}
          </>
        )}
      </div>
    );
  };

  return (
    <div>
      {tree.dirs.map((d) => renderDir(d, 0))}
      {tree.files.map((f) => (
        <FileRow key={f.path} projectPath={projectPath} file={f} display={f.path} busy={busy} onDiscard={onDiscard} />
      ))}
    </div>
  );
}

interface FileGroupProps {
  projectPath: string;
  title: string;
  files: GitFileChange[];
  staged: boolean;
  busy: boolean;
  treeView: boolean;
  onDiscard: (pending: PendingDiscard) => void;
}

/** 折叠分组头：标题 + 计数 + 组动作（全部暂存/取消暂存 + 整组破坏性动作）。 */
function FileGroup({ projectPath, title, files, staged, busy, treeView, onDiscard }: FileGroupProps) {
  const stage = useGitStore((s) => s.stage);
  const unstage = useGitStore((s) => s.unstage);
  const [collapsed, setCollapsed] = useState(false);
  const paths = files.map((f) => f.path);

  return (
    <div className="mb-2">
      <div
        data-testid={staged ? "group-staged" : "group-unstaged"}
        className="flex cursor-pointer items-center gap-1.5 px-2 py-1.5 text-xs text-[var(--text-tertiary)] hover:bg-[var(--overlay-hover)]"
        onClick={() => setCollapsed((c) => !c)}
      >
        <ChevronRight size={12} className={`transition-transform duration-150 ${collapsed ? "" : "rotate-90"}`} />
        <span>
          {title} ({files.length})
        </span>
        <div className="flex-1" />
        {staged ? (
          <>
            <button
              data-testid="unstage-all"
              title="全部取消暂存"
              disabled={busy}
              className={ICON_BUTTON}
              onClick={(e) => {
                e.stopPropagation();
                void unstage(projectPath, paths);
              }}
            >
              <Minus size={13} />
            </button>
            <button
              data-testid="revert-all"
              title="还原暂存更改"
              disabled={busy}
              className={`${ICON_BUTTON} hover:!text-[var(--error)]`}
              onClick={(e) => {
                e.stopPropagation();
                onDiscard({ files: paths, staged: true });
              }}
            >
              <Undo2 size={13} />
            </button>
          </>
        ) : (
          <>
            <button
              data-testid="stage-all"
              title="全部暂存"
              disabled={busy}
              className={ICON_BUTTON}
              onClick={(e) => {
                e.stopPropagation();
                void stage(projectPath, paths);
              }}
            >
              <Plus size={13} />
            </button>
            <button
              data-testid="discard-all"
              title="丢弃全部更改"
              disabled={busy}
              className={`${ICON_BUTTON} hover:!text-[var(--error)]`}
              onClick={(e) => {
                e.stopPropagation();
                onDiscard({ files: paths, staged: false });
              }}
            >
              <Trash2 size={13} />
            </button>
          </>
        )}
      </div>
      {!collapsed &&
        (treeView ? (
          <ChangeTreeView projectPath={projectPath} files={files} busy={busy} onDiscard={onDiscard} />
        ) : (
          files.map((f) => (
            <FileRow key={f.path} projectPath={projectPath} file={f} display={f.path} busy={busy} onDiscard={onDiscard} />
          ))
        ))}
    </div>
  );
}

/** 更改 / 暂存的更改 两组。列表/树视图切换在 GitPanel 顶栏。提交区（T10）不动。 */
export function ChangesSection({ projectPath }: { projectPath: string }) {
  const status = useGitStore((s) => s.status);
  const statusLoading = useGitStore((s) => s.statusLoading);
  const opRunning = useGitStore((s) => s.opRunning);
  const treeView = useGitStore((s) => s.treeView);
  const discard = useGitStore((s) => s.discard);
  const revertStaged = useGitStore((s) => s.revertStaged);

  const [pendingDiscard, setPendingDiscard] = useState<PendingDiscard | null>(null);

  const files = status?.files ?? [];
  const unstaged = files.filter((f) => !f.staged);
  const staged = files.filter((f) => f.staged);
  const busy = statusLoading || opRunning !== null;

  return (
    <div className="flex-1 overflow-y-auto px-2 py-2">
      {files.length === 0 && (
        <div className="px-2.5 py-2 text-xs text-[var(--text-tertiary)]">无更改，工作区干净</div>
      )}
      {unstaged.length > 0 && (
        <FileGroup
          projectPath={projectPath}
          title="更改"
          files={unstaged}
          staged={false}
          busy={busy}
          treeView={treeView}
          onDiscard={setPendingDiscard}
        />
      )}
      {staged.length > 0 && (
        <FileGroup
          projectPath={projectPath}
          title="暂存的更改"
          files={staged}
          staged
          busy={busy}
          treeView={treeView}
          onDiscard={setPendingDiscard}
        />
      )}
      <GitConfirmDialog
        open={pendingDiscard !== null}
        title={pendingDiscard?.staged ? "还原暂存更改" : "丢弃更改"}
        description={
          pendingDiscard?.staged
            ? `还原 ${pendingDiscard.files.length} 个文件至 HEAD 版本？暂存内容与工作区改动都会被重置，此操作不可撤销。`
            : `丢弃 ${pendingDiscard?.files.length ?? 0} 个文件的更改？未跟踪文件将被删除，已跟踪文件还原到暂存版本，此操作不可撤销。`
        }
        confirmLabel={pendingDiscard?.staged ? "还原" : "丢弃"}
        busy={busy}
        onCancel={() => setPendingDiscard(null)}
        onConfirm={() => {
          const pending = pendingDiscard;
          setPendingDiscard(null);
          if (!pending) return;
          if (pending.staged) void revertStaged(projectPath, pending.files);
          else void discard(projectPath, pending.files);
        }}
      />
    </div>
  );
}
