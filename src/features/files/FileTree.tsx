import { ChevronRight, FilePlus, FolderPlus, RefreshCw, ChevronsDownUp } from "lucide-react";
import { useFsStore } from "../../stores/fs.store";
import { useProjectStore } from "../../stores/project.store";
import { useEffect, useState, useRef, useCallback, memo } from "react";
import FileIcon from "./FileIcon";
import { TreeContextMenu } from "./TreeContextMenu";
import { GitConfirmDialog } from "../git/GitConfirmDialog";

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
  const { expandDir, collapseDir, openFile, setSelectedPath, moveEntries, importFiles } = fsActions;
  const isCreatingHere = creatingIn === node.path;
  const isRenaming = renamingPath === node.path;

  // Drag-and-drop state
  const [isDragOver, setIsDragOver] = useState(false);
  const rowRef = useRef<HTMLDivElement>(null);

  const handleClick = () => {
    setSelectedPath(node.path);
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

  // --- Drag-and-drop handlers ---
  const handleDragStart = (e: React.DragEvent) => {
    if (isRoot) return;
    e.dataTransfer.setData('application/nex-tree-node', node.path);
    e.dataTransfer.effectAllowed = 'move';
    (e.currentTarget as HTMLElement).classList.add('opacity-50');
  };

  const handleDragEnd = (e: React.DragEvent) => {
    (e.currentTarget as HTMLElement).classList.remove('opacity-50');
  };

  const handleDragOver = (e: React.DragEvent) => {
    // Only directories (and root) accept drops
    if (!isRoot && !node.is_dir) return;
    e.preventDefault();
    e.stopPropagation();
    // Determine effect based on data type
    const isInternal = e.dataTransfer.types.includes('application/nex-tree-node');
    e.dataTransfer.dropEffect = isInternal ? 'move' : 'copy';
    setIsDragOver(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    // Only reset if we're actually leaving (not entering a child)
    const target = e.currentTarget as HTMLElement;
    const relatedTarget = e.relatedTarget as HTMLElement;
    if (!relatedTarget || !target.contains(relatedTarget)) {
      setIsDragOver(false);
    }
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);

    const internalPath = e.dataTransfer.getData('application/nex-tree-node');
    // Determine target directory
    const targetDir = (isRoot || node.is_dir) ? node.path
      : node.path.replace(/[/\\][^/\\]*$/, '');

    if (internalPath && internalPath !== node.path) {
      // Prevent dropping a directory into itself or a descendant
      if (targetDir.startsWith(internalPath + '\\') || targetDir.startsWith(internalPath + '/') || targetDir === internalPath) return;
      void moveEntries([internalPath], targetDir);
      return;
    }

    // External file drop (from OS) — refuse importing a folder into itself
    // or a descendant (same nesting hazard as copy/paste).
    if (e.dataTransfer.files.length > 0) {
      const paths: string[] = [];
      for (let i = 0; i < e.dataTransfer.files.length; i++) {
        const file = e.dataTransfer.files[i];
        // Tauri v2 extends File with a `path` property
        const fp = (file as any).path as string | undefined;
        if (fp) paths.push(fp);
      }
      const safe = paths.filter(
        (p) => !(targetDir === p || targetDir.startsWith(p + '/') || targetDir.startsWith(p + '\\')),
      );
      if (safe.length > 0) {
        void importFiles(safe, targetDir);
      }
    }
  };

  // --- Keyboard handler ---
  const handleKeyDown = (e: React.KeyboardEvent) => {
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
      e.preventDefault();
      if (!node.is_dir) {
        openFile(node.path);
      } else if (isExpanded) {
        collapseDir(node.path);
      } else {
        expandDir(node.path);
      }
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
          // Drag-and-drop
          draggable={!isRoot}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          className={`flex items-center gap-1.5 px-2 py-px text-sm cursor-pointer rounded-[var(--radius-sm)] transition-colors duration-100 outline-none group ${
            isDragOver
              ? "bg-[var(--accent)]/30 ring-1 ring-[var(--accent)]"
              : isSelected
              ? "bg-[var(--accent)]/20"
              : "hover:bg-[var(--overlay-hover)]"
          }`}
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
                <span role="button" title="新建文件" className="p-0.5 rounded transition-colors duration-100 hover:bg-[var(--overlay-hover)] text-[var(--text-tertiary)] hover:text-[var(--text-primary)]" onClick={(e) => { e.stopPropagation(); rootActions.onNewFile(); }}>
                  <FilePlus size={14} />
                </span>
                <span role="button" title="新建目录" className="p-0.5 rounded transition-colors duration-100 hover:bg-[var(--overlay-hover)] text-[var(--text-tertiary)] hover:text-[var(--text-primary)]" onClick={(e) => { e.stopPropagation(); rootActions.onNewFolder(); }}>
                  <FolderPlus size={14} />
                </span>
                <span role="button" title="刷新" className="p-0.5 rounded transition-colors duration-100 hover:bg-[var(--overlay-hover)] text-[var(--text-tertiary)] hover:text-[var(--text-primary)]" onClick={(e) => { e.stopPropagation(); rootActions.onRefresh(); }}>
                  <RefreshCw size={14} />
                </span>
                <span role="button" title="全部折叠" className="p-0.5 rounded transition-colors duration-100 hover:bg-[var(--overlay-hover)] text-[var(--text-tertiary)] hover:text-[var(--text-primary)]" onClick={(e) => { e.stopPropagation(); rootActions.onCollapseAll(); }}>
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
          {children?.map((child) => (
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
  const { loadRoot, nodesByDir, expandDir, createFile, createDir, renameEntry, refreshDir, collapseAll, selectedPath, pendingRenamePath, consumePendingRename, importFiles, pendingDeletePath, cancelPendingDelete, confirmPendingDelete, openFiles } = useFsStore();
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

  // --- External file drop on entire tree area (fallback) ---
  const handleTreeDragOver = useCallback((e: React.DragEvent) => {
    // Only handle if not already handled by a node
    if (e.dataTransfer.types.includes('application/nex-tree-node')) return;
    // Accept external file drops
    if (e.dataTransfer.types.includes('Files')) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    }
  }, []);

  const handleTreeDrop = useCallback(async (e: React.DragEvent) => {
    // Skip internal drags — handled by TreeNode
    if (e.dataTransfer.getData('application/nex-tree-node')) return;
    // External files dropped onto the tree background → import to project root
    if (e.dataTransfer.files.length > 0 && project) {
      e.preventDefault();
      const paths: string[] = [];
      for (let i = 0; i < e.dataTransfer.files.length; i++) {
        const fp = (e.dataTransfer.files[i] as any).path as string | undefined;
        if (fp) paths.push(fp);
      }
      if (paths.length > 0) {
        void importFiles(paths, project.path);
      }
    }
  }, [project, importFiles]);

  useEffect(() => {
    if (project) loadRoot(project.path);
  }, [project?.path]);

  if (!project) return <div className="p-4 text-sm text-[var(--text-tertiary)]">No project open</div>;

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
        className="py-0.5 overflow-y-auto h-full pr-1"
        onDragOver={handleTreeDragOver}
        onDrop={handleTreeDrop}
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
          rootActions={rootActions}
        />
      </div>
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
