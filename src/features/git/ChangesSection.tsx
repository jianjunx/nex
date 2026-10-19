import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Collapse } from "@/components/ui/Collapse";
import { ChevronRight, File, Loader2, Minus, Plus, Undo2 } from "lucide-react";
import FileIcon from "../files/FileIcon";
import { useGitStore } from "../../stores/git.store";
import { useFsStore } from "../../stores/fs.store";
import type { GitFileChange } from "../../bridge/tauri";
import { usePendingOption } from "../agent/usePendingOption";
import { CommitSection } from "./CommitSection";
import { GitConfirmDialog } from "./GitConfirmDialog";

/** VSCode 状态色惯例：modified 黄 / added 绿 / deleted 红 / untracked 绿。 */
const EMPTY_FILES: GitFileChange[] = [];

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
  const { pendingId, select } = usePendingOption(async (op) => {
    if (op === "stage") await stage(projectPath, [file.path]);
    else await unstage(projectPath, [file.path]);
  }, undefined, "暂存操作失败");

  return (
    <div
      data-testid={`row-${file.path}`}
      className="nex-hoverable group flex h-7 cursor-pointer items-center gap-1.5 rounded-[var(--radius-sm)] px-2 py-1 hover:bg-[var(--overlay-hover)]"
      onClick={() => void openDiffInEditor(projectPath, file.path, file.staged)}
    >
      {/* 与文件树同款类型图标 */}
      <FileIcon filename={basename(file.path)} size={14} className="shrink-0" />
      <span className="min-w-0 flex-1 truncate text-[var(--text-secondary)]">{display}</span>
      <span className={`flex shrink-0 items-center gap-0.5 transition-opacity ${pendingId !== null ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}>
        <button
          data-testid={`open-${file.path}`}
          title="打开文件"
          disabled={busy || pendingId !== null}
          className={ICON_BUTTON}
          onClick={(e) => {
            e.stopPropagation();
            void useFsStore.getState().openFile(absPath(projectPath, file.path));
          }}
        >
          <File size={13} />
        </button>
        {file.staged ? (
          <button
            data-testid={`unstage-${file.path}`}
            title="取消暂存"
            disabled={busy || pendingId !== null}
            className={ICON_BUTTON}
            onClick={(e) => {
              e.stopPropagation();
              void select("unstage");
            }}
          >
            {pendingId === "unstage" ? <Loader2 size={13} className="animate-spin" aria-label="取消暂存中" /> : <Minus size={13} />}
          </button>
        ) : (
          <button
            data-testid={`stage-${file.path}`}
            title="暂存"
            disabled={busy || pendingId !== null}
            className={ICON_BUTTON}
            onClick={(e) => {
              e.stopPropagation();
              void select("stage");
            }}
          >
            {pendingId === "stage" ? <Loader2 size={13} className="animate-spin" aria-label="暂存中" /> : <Plus size={13} />}
          </button>
        )}
        <button
          data-testid={`discard-${file.path}`}
          title={file.staged ? "还原暂存更改" : "丢弃更改"}
          disabled={busy || pendingId !== null}
          className={`${ICON_BUTTON} hover:!text-[var(--error)]`}
          onClick={(e) => {
            e.stopPropagation();
            onDiscard({ files: [file.path], staged: file.staged });
          }}
        >
          <Undo2 size={13} />
        </button>
      </span>
      {/* git 状态字母（M/A/D/U）置于最右侧，常显 */}
      <span
        data-testid={`status-${file.path}`}
        className="w-3 shrink-0 text-center text-xs"
        style={{ color: STATUS_COLORS[file.status] }}
      >
        {file.status[0].toUpperCase()}
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

type ChangeRow =
  | { type: "file"; file: GitFileChange; depth: number }
  | { type: "dir"; dir: TreeDir; depth: number };

function VirtualChangeRows({ rows, scrollRef, renderRow }: {
  rows: ChangeRow[];
  scrollRef: RefObject<HTMLDivElement | null>;
  renderRow: (row: ChangeRow) => ReactNode;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const [margin, setMargin] = useState(0);
  useLayoutEffect(() => { setMargin(listRef.current?.offsetTop ?? 0); }, [rows]);
  // Parent refs are attached after child layout effects; observe after the whole commit.
  useEffect(() => {
    const measure = () => setMargin(listRef.current?.offsetTop ?? 0);
    const parent = scrollRef.current;
    if (!parent || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(parent);
    // Commit input and preceding groups can move this list without resizing its viewport.
    for (const child of parent.children) observer.observe(child);
    return () => observer.disconnect();
  }, [rows, scrollRef]);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    getItemKey: (i) => rows[i].type === "dir" ? `dir:${rows[i].dir.path}` : `file:${rows[i].file.path}`,
    estimateSize: () => 28,
    overscan: 8,
    scrollMargin: margin,
    initialRect: { width: 300, height: 600 },
  });
  return <div ref={listRef} data-testid="virtual-git-files" style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
    {virtualizer.getVirtualItems().map((item) => <div key={item.key} style={{
      position: "absolute", top: 0, left: 0, width: "100%", height: 28,
      transform: `translateY(${item.start - margin}px)`,
    }}>{renderRow(rows[item.index])}</div>)}
  </div>;
}

function ChangeFileList({ projectPath, files, busy, onDiscard, treeView, scrollRef }: {
  projectPath: string; files: GitFileChange[]; busy: boolean;
  onDiscard: (pending: PendingDiscard) => void; treeView: boolean;
  scrollRef: RefObject<HTMLDivElement | null>;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const tree = useMemo(() => treeView ? buildTree(files) : null, [files, treeView]);
  const rows = useMemo(() => {
    if (!tree) return files.map((file): ChangeRow => ({ type: "file", file, depth: 0 }));
    const result: ChangeRow[] = [];
    const visit = (node: TreeDir, depth: number) => {
      for (const dir of node.dirs) {
        result.push({ type: "dir", dir, depth });
        if (!collapsed.has(dir.path)) visit(dir, depth + 1);
      }
      for (const file of node.files) result.push({ type: "file", file, depth });
    };
    visit(tree, 0);
    return result;
  }, [tree, files, collapsed]);
  const renderRow = (row: ChangeRow) => row.type === "file" ? (
    <div style={{ paddingLeft: row.depth * 12 }}>
      <FileRow projectPath={projectPath} file={row.file} display={treeView ? basename(row.file.path) : row.file.path} busy={busy} onDiscard={onDiscard} />
    </div>
  ) : (
    <button type="button" data-testid={`dir-${row.dir.path}`} aria-expanded={!collapsed.has(row.dir.path)}
      className="nex-hoverable flex h-7 w-full cursor-pointer items-center gap-1.5 rounded-[var(--radius-sm)] px-2 text-left hover:bg-[var(--overlay-hover)]"
      style={{ paddingLeft: row.depth * 12 + 10 }} onClick={() => setCollapsed((prev) => {
        const next = new Set(prev);
        if (next.has(row.dir.path)) next.delete(row.dir.path); else next.add(row.dir.path);
        return next;
      })}>
      <ChevronRight size={12} className={`shrink-0 text-[var(--text-tertiary)] ${collapsed.has(row.dir.path) ? "" : "rotate-90"}`} />
      <FileIcon filename={row.dir.name} isFolder size={13} className="shrink-0" />
      <span className="truncate text-[var(--text-secondary)]">{row.dir.name}</span>
    </button>
  );
  if (rows.length > 100) return <VirtualChangeRows rows={rows} scrollRef={scrollRef} renderRow={renderRow} />;
  return <div>{rows.map((row) => <div key={row.type === "dir" ? `dir:${row.dir.path}` : `file:${row.file.path}`}>{renderRow(row)}</div>)}</div>;
}

interface FileGroupProps {
  projectPath: string;
  title: string;
  files: GitFileChange[];
  staged: boolean;
  busy: boolean;
  treeView: boolean;
  onDiscard: (pending: PendingDiscard) => void;
  scrollRef: RefObject<HTMLDivElement | null>;
}

/** 折叠分组头：标题 + 计数 + 组动作（全部暂存/取消暂存 + 整组破坏性动作）。 */
function FileGroup({ projectPath, title, files, staged, busy, treeView, onDiscard, scrollRef }: FileGroupProps) {
  const stage = useGitStore((s) => s.stage);
  const unstage = useGitStore((s) => s.unstage);
  const [collapsed, setCollapsed] = useState(false);
  const paths = useMemo(() => files.map((f) => f.path), [files]);
  const { pendingId, select } = usePendingOption(async (op) => {
    if (op === "stage") await stage(projectPath, paths);
    else await unstage(projectPath, paths);
  }, undefined, "暂存操作失败");

  return (
    <div className="mb-2">
      <div
        data-testid={staged ? "group-staged" : "group-unstaged"}
        className="nex-hoverable flex cursor-pointer items-center gap-1.5 px-2 py-1.5 text-xs text-[var(--text-tertiary)] hover:bg-[var(--overlay-hover)]"
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
              disabled={busy || pendingId !== null}
              className={ICON_BUTTON}
              onClick={(e) => {
                e.stopPropagation();
                void select("unstage");
              }}
            >
              {pendingId === "unstage" ? <Loader2 size={13} className="animate-spin" aria-label="取消暂存中" /> : <Minus size={13} />}
            </button>
            <button
              data-testid="revert-all"
              title="还原暂存更改"
              disabled={busy || pendingId !== null}
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
              disabled={busy || pendingId !== null}
              className={ICON_BUTTON}
              onClick={(e) => {
                e.stopPropagation();
                void select("stage");
              }}
            >
              {pendingId === "stage" ? <Loader2 size={13} className="animate-spin" aria-label="暂存中" /> : <Plus size={13} />}
            </button>
            <button
              data-testid="discard-all"
              title="丢弃全部更改"
              disabled={busy || pendingId !== null}
              className={`${ICON_BUTTON} hover:!text-[var(--error)]`}
              onClick={(e) => {
                e.stopPropagation();
                onDiscard({ files: paths, staged: false });
              }}
            >
              <Undo2 size={13} />
            </button>
          </>
        )}
      </div>
      <Collapse open={!collapsed}>
        <ChangeFileList projectPath={projectPath} files={files} busy={busy} onDiscard={onDiscard} treeView={treeView} scrollRef={scrollRef} />
      </Collapse>
    </div>
  );
}

/** 更改 / 暂存的更改 两组。列表/树视图切换在 GitPanel 顶栏。提交区（T10）在「更改」标题下方、文件上方。 */
export function ChangesSection({ projectPath }: { projectPath: string }) {
  const status = useGitStore((s) => s.status);
  const statusLoading = useGitStore((s) => s.statusLoading);
  const opRunning = useGitStore((s) => s.opRunning);
  const treeView = useGitStore((s) => s.treeView);
  const discard = useGitStore((s) => s.discard);
  const revertStaged = useGitStore((s) => s.revertStaged);

  const [pendingDiscard, setPendingDiscard] = useState<PendingDiscard | null>(null);

  const files = status?.files ?? EMPTY_FILES;
  const unstaged = useMemo(() => files.filter((f) => !f.staged), [files]);
  const staged = useMemo(() => files.filter((f) => f.staged), [files]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const busy = statusLoading || opRunning !== null;

  return (
    <div ref={scrollRef} className="relative min-h-0 flex-1 overflow-y-auto px-2 py-1">
      {/* 提交框：位于「更改」标题下方、更改文件上方；工作区干净时也常驻可见 */}
      <CommitSection projectPath={projectPath} />
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
          scrollRef={scrollRef}
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
          scrollRef={scrollRef}
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
