import { ChevronRight, FilePlus, FolderPlus, RefreshCw, ChevronsDownUp } from "lucide-react";
import { useFsStore } from "../../stores/fs.store";
import { useProjectStore } from "../../stores/project.store";
import { useDragDropStore, type TreeNodeDragSession } from "../../stores/dragDrop.store";
import { useEffect, useState, useRef, useCallback, memo, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import FileIcon from "./FileIcon";
import { TreeContextMenu } from "./TreeContextMenu";
import { GitConfirmDialog } from "../git/GitConfirmDialog";
import { useOsDragDrop } from "../../lib/osDragDrop";
import { parentDirOf, resolveDirDropTarget } from "../../lib/dropTargets";
import { usePointerDrag } from "../../lib/usePointerDrag";
import { attachToComposer } from "../../lib/composerAttach";

function uniqueByPath<T extends { path: string }>(nodes: T[] | undefined): T[] {
  if (!nodes || nodes.length === 0) return [];
  const seen = new Set<string>();
  return nodes.filter((n) => (seen.has(n.path) ? false : (seen.add(n.path), true)));
}

// Stable action references (zustand actions never change identity): passing
// these down instead of re-created closures lets memo() actually skip work.
const fsActions = {
  expandDir: (p: string) => useFsStore.getState().expandDir(p),
  collapseDir: (p: string) => useFsStore.getState().collapseDir(p),
  openFile: (p: string, pin?: boolean) => useFsStore.getState().openFile(p, pin),
  setSelectedPath: (p: string | null) => useFsStore.getState().setSelectedPath(p),
  moveEntries: (s: string[], t: string) => useFsStore.getState().moveEntries(s, t),
  importFiles: (s: string[], t: string) => useFsStore.getState().importFiles(s, t),
};

function CreatingInput({ type, depth, onDone }: {
  type: 'file' | 'dir';
  depth: number;
  onDone: (name: string) => void;
}) {
  const [name, setName] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      onDone(name.trim());
    } else if (e.key === 'Escape') {
      onDone('');
    }
  };

  return (
    <div
      className="flex items-center gap-1 px-1.5 py-0.5 text-sm rounded-[var(--radius-sm)]"
      style={{ paddingLeft: depth * 10 + 6 }}
    >
      <span className="w-3" />
      <FileIcon filename="" isFolder={type === "dir"} size={14} className="shrink-0" />
      <input
        ref={inputRef}
        data-filetree-edit-input
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={() => onDone(name.trim())}
        className="bg-[var(--glass-2-surface)] border border-[var(--border-subtle)] rounded-[var(--radius-sm)] px-1 py-px text-sm text-[var(--text-primary)] outline-none flex-1 min-w-0"
        placeholder={type === 'file' ? 'new file' : 'new folder'}
      />
    </div>
  );
}

/** Inline rename input — replaces the filename span while renaming */
function RenameInput({ name, depth, isFolder, onDone }: {
  name: string;
  depth: number;
  isFolder: boolean;
  onDone: (name: string) => void;
}) {
  const [value, setValue] = useState(name);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      // Select name part without extension for files
      if (!isFolder) {
        const dotIdx = name.lastIndexOf('.');
        if (dotIdx > 0) {
          inputRef.current?.setSelectionRange(0, dotIdx);
        } else {
          inputRef.current?.select();
        }
      } else {
        inputRef.current?.select();
      }
    });
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const trimmed = value.trim();
      if (trimmed && trimmed !== name) onDone(trimmed);
      else onDone('');
    } else if (e.key === 'Escape') {
      onDone('');
    }
  };

  return (
    <div
      className="flex items-center gap-1 px-1.5 py-0.5 text-sm rounded-[var(--radius-sm)]"
      style={{ paddingLeft: depth * 10 + 6 }}
    >
      <span className="w-3" />
      <FileIcon filename={isFolder ? "" : name} isFolder={isFolder} size={14} className="shrink-0" />
      <input
        ref={inputRef}
        data-filetree-edit-input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={() => {
          const trimmed = value.trim();
          if (trimmed && trimmed !== name) onDone(trimmed);
          else onDone('');
        }}
        className="bg-[var(--glass-2-surface)] border border-[var(--accent)] rounded-[var(--radius-sm)] px-1 py-px text-sm text-[var(--text-primary)] outline-none flex-1 min-w-0"
      />
    </div>
  );
}

// --- Context menu state (module-level to avoid resetting on re-renders) ---
interface ContextMenuState {
  node: { name: string; path: string; is_dir: boolean };
  position: { x: number; y: number };
}

function TreeNode({
  node, depth, isRoot,
  creatingIn, creatingType, onCreatingDone,
  renamingPath, onRenameStart, onRenameDone,
  onContextMenu,
  onNodePointerDown,
  rootActions
}: {
  node: { name: string; path: string; is_dir: boolean };
  depth: number;
  isRoot?: boolean;
  creatingIn: string | null;
  creatingType: 'file' | 'dir' | null;
  onCreatingDone: (name: string, parentPath: string) => void;
  renamingPath: string | null;
  onRenameStart: (path: string) => void;
  onRenameDone: (path: string, newName: string) => void;
  onContextMenu: (e: React.MouseEvent, node: { name: string; path: string; is_dir: boolean }) => void;
  onNodePointerDown: (e: ReactPointerEvent, node: { name: string; path: string; is_dir: boolean }) => void;
  rootActions?: {
    projectName: string;
    onNewFile: () => void;
    onNewFolder: () => void;
    onRefresh: () => void;
    onCollapseAll: () => void;
  };
}) {
  // Fine-grained selectors: this node only re-renders when ITS expansion
  // state, children list, or selection changes — not on every store write
  // (typing in the editor, search results, other nodes' selection…).
  const isExpanded = useFsStore((s) => s.expandedDirs.has(node.path));
  const children = useFsStore((s) => s.nodesByDir[node.path]);
  const isSelected = useFsStore((s) => s.selectedPath === node.path);
  // OS/pointer drag hover highlight — only the hovered row re-renders.
  const isDropTarget = useDragDropStore((s) => s.overDir === node.path);
  const isDragSource = useDragDropStore((s) => s.session?.path === node.path);
  const { expandDir, collapseDir, openFile, setSelectedPath } = fsActions;
  const isCreatingHere = creatingIn === node.path;
  const isRenaming = renamingPath === node.path;

  const rowRef = useRef<HTMLDivElement>(null);

  const handleClick = () => {
    setSelectedPath(node.path);
    // Keep keyboard focus on the row so explorer shortcuts (F2 / Enter rename) stay armed.
    rowRef.current?.focus();
    if (isRoot || node.is_dir) {
      if (isExpanded) collapseDir(node.path);
      else expandDir(node.path);
    } else {
      openFile(node.path);
    }
  };

  const handleDoubleClick = () => {
    if (!node.is_dir) {
      openFile(node.path, true);
    }
  };

  // --- Keyboard handler ---
  const handleKeyDown = (e: React.KeyboardEvent) => {
    const isMac =
      typeof navigator !== "undefined" &&
      (navigator.platform.startsWith("Mac") || /Macintosh/.test(navigator.userAgent));
    const macDeleteShortcut =
      isMac &&
      e.metaKey &&
      !e.ctrlKey &&
      !e.altKey &&
      !e.shiftKey &&
      (e.key === "Backspace" || e.key === "ArrowLeft");
    if (macDeleteShortcut) {
      if (isRoot) return;
      e.preventDefault();
      fsActions.setSelectedPath(node.path);
      useFsStore.getState().requestDeleteEntry(node.path);
      return;
    }
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      if ((isRoot || node.is_dir) && !isExpanded) {
        expandDir(node.path);
      }
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      if ((isRoot || node.is_dir) && isExpanded) {
        collapseDir(node.path);
      }
    } else if (e.key === 'Enter') {
      // macOS: Enter renames (Finder-style). KeybindingHost usually handles it in
      // capture phase; local path is a fallback if the global binding is unbound.
      if (isMac) {
        if (isRoot) return;
        e.preventDefault();
        onRenameStart(node.path);
        return;
      }
      e.preventDefault();
      if (!node.is_dir) {
        openFile(node.path);
      } else if (isExpanded) {
        collapseDir(node.path);
      } else {
        expandDir(node.path);
      }
    } else if (e.key === 'F2') {
      // Local fallback when the row is focused (covers hosts that miss the global binding).
      if (isRoot) return;
      e.preventDefault();
      onRenameStart(node.path);
    }
  };

  const displayName = isRoot ? (rootActions?.projectName ?? node.name) : node.name;

  return (
    <div>
      {isRenaming ? (
        <RenameInput
          name={node.name}
          depth={depth}
          isFolder={node.is_dir}
          onDone={(newName) => onRenameDone(node.path, newName)}
        />
      ) : (
        <div
          ref={rowRef}
          tabIndex={0}
          role="treeitem"
          aria-expanded={isRoot || node.is_dir ? isExpanded : undefined}
          aria-selected={isSelected}
          {...(isRoot || node.is_dir
            ? { "data-dir-path": node.path }
            : { "data-file-path": node.path })}
          onClick={handleClick}
          onDoubleClick={handleDoubleClick}
          onKeyDown={handleKeyDown}
          onContextMenu={(e) => {
            if (!isRoot) {
              e.preventDefault();
              e.stopPropagation();
              setSelectedPath(node.path);
              onContextMenu(e, node);
            }
          }}
          // Pointer drag (move / attach to composer); 5px threshold keeps
          // plain clicks intact. Root rows are not draggable.
          onPointerDown={isRoot ? undefined : (e) => onNodePointerDown(e, node)}
          className={`flex items-center gap-1.5 px-2 py-[3px] text-sm cursor-pointer rounded-[var(--radius-sm)] transition-colors duration-100 outline-none group ${
            isDropTarget
              ? "bg-[var(--accent)]/30 ring-1 ring-[var(--accent)]"
              : isSelected
              ? "bg-[var(--overlay-active)] text-[var(--text-primary)]"
              : "hover:bg-[var(--overlay-hover)]"
          }${isDragSource ? " opacity-50" : ""}`}
          style={{ paddingLeft: depth * 10 + 6 }}
        >
          {isRoot || node.is_dir ? (
            <ChevronRight size={12} className={`shrink-0 transition-transform duration-150 ease-out ${isExpanded ? "rotate-90" : ""}`} />
          ) : (
            <span className="w-3" />
          )}
          <FileIcon
            filename={isRoot ? "" : node.name}
            isFolder={isRoot || node.is_dir}
            isOpen={isRoot || node.is_dir ? isExpanded : false}
            isRoot={!!isRoot}
            size={14}
            className="shrink-0"
          />
          <span className={`truncate ${isRoot ? "text-[var(--text-primary)] font-medium" : "text-[var(--text-secondary)]"}`}>
            {displayName}
          </span>
          {isRoot && rootActions && (
            <>
              <div className="flex-1" />
              <div className="flex items-center gap-0.5">
                <span role="button" title="新建文件" className="p-0.5 rounded-[var(--radius-sm)] transition-colors duration-100 hover:bg-[var(--overlay-hover)] text-[var(--text-tertiary)] hover:text-[var(--text-primary)]" onClick={(e) => { e.stopPropagation(); rootActions.onNewFile(); }}>
                  <FilePlus size={14} />
                </span>
                <span role="button" title="新建目录" className="p-0.5 rounded-[var(--radius-sm)] transition-colors duration-100 hover:bg-[var(--overlay-hover)] text-[var(--text-tertiary)] hover:text-[var(--text-primary)]" onClick={(e) => { e.stopPropagation(); rootActions.onNewFolder(); }}>
                  <FolderPlus size={14} />
                </span>
                <span role="button" title="刷新" className="p-0.5 rounded-[var(--radius-sm)] transition-colors duration-100 hover:bg-[var(--overlay-hover)] text-[var(--text-tertiary)] hover:text-[var(--text-primary)]" onClick={(e) => { e.stopPropagation(); rootActions.onRefresh(); }}>
                  <RefreshCw size={14} />
                </span>
                <span role="button" title="全部折叠" className="p-0.5 rounded-[var(--radius-sm)] transition-colors duration-100 hover:bg-[var(--overlay-hover)] text-[var(--text-tertiary)] hover:text-[var(--text-primary)]" onClick={(e) => { e.stopPropagation(); rootActions.onCollapseAll(); }}>
                  <ChevronsDownUp size={14} />
                </span>
              </div>
            </>
          )}
        </div>
      )}
      {isExpanded && (
        <>
          {isCreatingHere && creatingType && (
            <CreatingInput
              type={creatingType}
              depth={depth + 1}
              onDone={(name) => onCreatingDone(name, node.path)}
            />
          )}
          {uniqueByPath(children).map((child) => (
            <MemoTreeNode
              key={child.path}
              node={child}
              depth={depth + 1}
              creatingIn={creatingIn}
              creatingType={creatingType}
              onCreatingDone={onCreatingDone}
              renamingPath={renamingPath}
              onRenameStart={onRenameStart}
              onRenameDone={onRenameDone}
              onContextMenu={onContextMenu}
              onNodePointerDown={onNodePointerDown}
            />
          ))}
        </>
      )}
    </div>
  );
}

// memo(): with stable action refs and fine-grained selectors above, a
// store write (selection, editor draft, search…) now skips every node
// whose own inputs didn't change — previously the whole tree re-rendered.
const MemoTreeNode = memo(TreeNode);

export function FileTree() {
  const { loadRoot, nodesByDir, expandDir, createFile, createDir, renameEntry, refreshDir, collapseAll, selectedPath, pendingRenamePath, consumePendingRename, pendingDeletePath, cancelPendingDelete, confirmPendingDelete, openFiles } = useFsStore();
  const activeProjectId = useProjectStore((s) => s.activeProjectId);
  const projects = useProjectStore((s) => s.projects);
  const project = projects.find((p) => p.id === activeProjectId);

  const [creatingIn, setCreatingIn] = useState<string | null>(null);
  const [creatingType, setCreatingType] = useState<'file' | 'dir' | null>(null);
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);

  const treeContainerRef = useRef<HTMLDivElement>(null);

  // Consume pending rename from keyboard shortcut
  useEffect(() => {
    if (pendingRenamePath) {
      // Expand parent dir if needed
      const parent = pendingRenamePath.replace(/[/\\][^/\\]*$/, "");
      if (parent && parent !== project?.path && !(parent in nodesByDir)) {
        expandDir(parent);
      }
      setRenamingPath(pendingRenamePath);
      consumePendingRename();
    }
  }, [pendingRenamePath]);

  const closeContextMenu = useCallback(() => setContextMenu(null), []);

  const handleContextMenu = useCallback((e: React.MouseEvent, node: { name: string; path: string; is_dir: boolean }) => {
    setContextMenu({ node, position: { x: e.clientX, y: e.clientY } });
  }, []);

  const getTargetDir = useCallback((): string => {
    const sel = selectedPath;
    if (!sel || !project || sel === project.path) return project?.path ?? '';
    if (sel in nodesByDir) return sel;
    const lastBackslash = sel.lastIndexOf('\\');
    const lastSlash = sel.lastIndexOf('/');
    const idx = Math.max(lastBackslash, lastSlash);
    if (idx > 0) return sel.substring(0, idx);
    return project.path;
  }, [selectedPath, project, nodesByDir]);

  const handleNewFile = useCallback((targetDir?: string) => {
    const dir = targetDir ?? getTargetDir();
    if (dir && dir !== project?.path) expandDir(dir);
    setCreatingIn(dir);
    setCreatingType('file');
  }, [getTargetDir, project, expandDir]);

  const handleNewFolder = useCallback((targetDir?: string) => {
    const dir = targetDir ?? getTargetDir();
    if (dir && dir !== project?.path) expandDir(dir);
    setCreatingIn(dir);
    setCreatingType('dir');
  }, [getTargetDir, project, expandDir]);

  const handleCreatingDone = useCallback((name: string, parentPath: string) => {
    setCreatingIn(null);
    setCreatingType(null);
    if (!name) return;
    if (creatingType === 'file') {
      void createFile(parentPath, name);
    } else if (creatingType === 'dir') {
      void createDir(parentPath, name);
    }
  }, [creatingType, createFile, createDir]);

  const handleRenameStart = useCallback((path: string) => {
    setRenamingPath(path);
    setContextMenu(null);
  }, []);

  const handleRenameDone = useCallback((path: string, newName: string) => {
    setRenamingPath(null);
    if (newName) {
      void renameEntry(path, newName);
    }
  }, [renameEntry]);

  const handleRefresh = useCallback(async () => {
    if (!project) return;
    await refreshDir(project.path);
    for (const dir of Object.keys(nodesByDir)) {
      if (dir !== project.path) await refreshDir(dir);
    }
  }, [project, refreshDir, nodesByDir]);

  const handleCollapseAll = useCallback(() => {
    if (!project) return;
    collapseAll(project.path);
    setCreatingIn(null);
    setCreatingType(null);
  }, [project, collapseAll]);

  // --- OS file drop (Tauri onDragDropEvent) ---
  // With `dragDropEnabled: true`, HTML5 file drops never reach the webview
  // (and on Windows that setting disables HTML5 DnD altogether), so imports
  // from Explorer/Finder are driven entirely by the native event stream.
  const lastDropPosRef = useRef({ x: -1, y: -1 });
  useOsDragDrop((e) => {
    if (!project) return;
    if (e.type === "leave") {
      lastDropPosRef.current = { x: -1, y: -1 };
      useDragDropStore.getState().clearHover();
      return;
    }
    if (e.type === "drop") {
      lastDropPosRef.current = { x: -1, y: -1 };
      useDragDropStore.getState().clearHover();
      if (e.paths && e.paths.length > 0) {
        const dir = resolveDirDropTarget(e, treeContainerRef.current, project.path) ?? project.path;
        void fsActions.importFiles(e.paths, dir);
      }
      return;
    }
    // enter/over — hit-test at most once per >2px of pointer movement;
    // setOsHoverDir itself only writes the store when the target changed.
    const last = lastDropPosRef.current;
    if (Math.abs(e.x - last.x) < 2 && Math.abs(e.y - last.y) < 2) return;
    lastDropPosRef.current = { x: e.x, y: e.y };
    useDragDropStore.getState().setOsHoverDir(
      resolveDirDropTarget(e, treeContainerRef.current, project.path),
    );
  });

  // --- Pointer drag: move tree nodes / attach files to the composer ---
  const autoscrollTree = useCallback((_x: number, y: number) => {
    const el = treeContainerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const EDGE = 28;
    const MAX_STEP = 14;
    if (y < r.top + EDGE) {
      el.scrollTop -= Math.min(MAX_STEP, ((r.top + EDGE - y) / EDGE) * MAX_STEP);
    } else if (y > r.bottom - EDGE) {
      el.scrollTop += Math.min(MAX_STEP, ((y - (r.bottom - EDGE)) / EDGE) * MAX_STEP);
    }
  }, []);

  const { payload: dragPayload, start: startDrag, ghostRef } = usePointerDrag<TreeNodeDragSession>({
    onBegin: (p) => useDragDropStore.getState().begin(p),
    onMove: (_p, x, y) => useDragDropStore.getState().updateHover({ x, y }),
    onDrop: (p) => {
      const { overDir, overComposer } = useDragDropStore.getState();
      if (!p.isDir && overComposer) {
        attachToComposer([p.path]);
        return;
      }
      if (!overDir || overDir === p.path || overDir === parentDirOf(p.path)) return;
      // Reject dropping a directory into its own descendant (backend also
      // guards this, but skipping the round-trip keeps it snappy).
      if (overDir.startsWith(p.path + "/") || overDir.startsWith(p.path + "\\")) return;
      void fsActions.moveEntries([p.path], overDir);
    },
    onEnd: () => useDragDropStore.getState().finish(),
    autoscroll: autoscrollTree,
  });

  const handleNodePointerDown = useCallback(
    (e: ReactPointerEvent, node: { name: string; path: string; is_dir: boolean }) => {
      startDrag({ kind: "tree-node", path: node.path, name: node.name, isDir: node.is_dir })(e);
    },
    [startDrag],
  );

  useEffect(() => {
    if (project) loadRoot(project.path);
  }, [project?.path]);

  if (!project) return <div className="px-3 py-4 text-sm text-[var(--text-tertiary)]">还没有打开项目</div>;

  const rootActions = {
    projectName: project.name,
    onNewFile: () => handleNewFile(),
    onNewFolder: () => handleNewFolder(),
    onRefresh: handleRefresh,
    onCollapseAll: handleCollapseAll,
  };

  const rootNode = { name: project.name, path: project.path, is_dir: true };

  return (
    <>
      <div
        ref={treeContainerRef}
        data-file-tree
        className="py-0.5 overflow-y-auto h-full pr-1"
      >
        <MemoTreeNode
          node={rootNode}
          depth={0}
          isRoot={true}
          creatingIn={creatingIn}
          creatingType={creatingType}
          onCreatingDone={handleCreatingDone}
          renamingPath={renamingPath}
          onRenameStart={handleRenameStart}
          onRenameDone={handleRenameDone}
          onContextMenu={handleContextMenu}
          onNodePointerDown={handleNodePointerDown}
          rootActions={rootActions}
        />
      </div>
      {createPortal(
        <div
          ref={ghostRef}
          style={{ display: "none" }}
          className="fixed left-0 top-0 z-[100] pointer-events-none items-center gap-1.5 rounded-[var(--radius-sm)] border border-[var(--border-subtle)] bg-[var(--glass-2-surface)] px-2 py-1 text-sm text-[var(--text-primary)] shadow-lg"
        >
          {dragPayload && (
            <>
              <FileIcon
                filename={dragPayload.isDir ? "" : dragPayload.name}
                isFolder={dragPayload.isDir}
                size={14}
                className="shrink-0"
              />
              <span className="max-w-[220px] truncate">{dragPayload.name}</span>
            </>
          )}
        </div>,
        document.body,
      )}
      {contextMenu && (
        <TreeContextMenu
          open={true}
          onOpenChange={(open) => { if (!open) closeContextMenu(); }}
          position={contextMenu.position}
          node={contextMenu.node}
          onClose={closeContextMenu}
          onRename={() => handleRenameStart(contextMenu.node.path)}
          onNewFile={contextMenu.node.is_dir ? () => {
            handleNewFile(contextMenu.node.path);
            closeContextMenu();
          } : undefined}
          onNewFolder={contextMenu.node.is_dir ? () => {
            handleNewFolder(contextMenu.node.path);
            closeContextMenu();
          } : undefined}
        />
      )}
      {pendingDeletePath && (
        <GitConfirmDialog
          open
          title="确认删除"
          description={
            openFiles.some((f) => f.path === pendingDeletePath && f.dirty)
              ? `「${pendingDeletePath.split(/[/\\]/).pop() ?? pendingDeletePath}」有未保存修改，删除后草稿将丢失且无法恢复。`
              : `确定删除「${pendingDeletePath.split(/[/\\]/).pop() ?? pendingDeletePath}」？此操作无法撤销。`
          }
          confirmLabel="删除"
          onConfirm={() => void confirmPendingDelete()}
          onCancel={cancelPendingDelete}
        />
      )}
    </>
  );
}
