import { ChevronRight, ChevronDown, File, Folder, FilePlus, FolderPlus, RefreshCw, ChevronsDownUp } from "lucide-react";
import { useFsStore } from "../../stores/fs.store";
import { useProjectStore } from "../../stores/project.store";
import { useEffect, useState, useRef, useCallback } from "react";

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
      className="flex items-center gap-2 px-2.5 py-1.5 text-sm rounded-[var(--radius-sm)]"
      style={{ paddingLeft: depth * 12 + 8 }}
    >
      <span className="w-3" />
      {type === 'file' ? (
        <File size={14} className="text-[var(--text-tertiary)] shrink-0" />
      ) : (
        <Folder size={14} className="text-[var(--accent)] shrink-0" />
      )}
      <input
        ref={inputRef}
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={() => onDone(name.trim())}
        className="bg-[var(--glass-2-surface)] border border-[var(--border-subtle)] rounded-[var(--radius-sm)] px-1.5 py-0.5 text-sm text-[var(--text-primary)] outline-none flex-1 min-w-0"
        placeholder={type === 'file' ? 'new file' : 'new folder'}
      />
    </div>
  );
}

function TreeNode({ node, depth, isRoot, creatingIn, creatingType, onCreatingDone, rootActions }: {
  node: { name: string; path: string; is_dir: boolean };
  depth: number;
  isRoot?: boolean;
  creatingIn: string | null;
  creatingType: 'file' | 'dir' | null;
  onCreatingDone: (name: string, parentPath: string) => void;
  rootActions?: {
    projectName: string;
    onNewFile: () => void;
    onNewFolder: () => void;
    onRefresh: () => void;
    onCollapseAll: () => void;
  };
}) {
  const { expandedDirs, expandDir, collapseDir, nodesByDir, openFile, selectedPath, setSelectedPath } = useFsStore();
  const isExpanded = expandedDirs.has(node.path);
  const children = nodesByDir[node.path];
  const isSelected = selectedPath === node.path;
  const isCreatingHere = creatingIn === node.path;

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

  const displayName = isRoot ? (rootActions?.projectName ?? node.name) : node.name;

  return (
    <div>
      <div
        onClick={handleClick}
        onDoubleClick={handleDoubleClick}
        className={`flex items-center gap-2 px-2.5 py-1.5 text-sm cursor-pointer rounded-[var(--radius-sm)] ${
          isSelected ? "bg-[var(--overlay-active)]" : "hover:bg-[var(--overlay-hover)]"
        }`}
        style={{ paddingLeft: depth * 12 + 8 }}
      >
        {isRoot || node.is_dir ? (
          isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />
        ) : (
          <span className="w-3" />
        )}
        {(isRoot || node.is_dir) ? (
          <Folder size={14} className="text-[var(--accent)] shrink-0" />
        ) : (
          <File size={14} className="text-[var(--text-tertiary)] shrink-0" />
        )}
        <span className={`truncate ${isRoot ? "text-[var(--text-primary)] font-medium" : "text-[var(--text-secondary)]"}`}>
          {displayName}
        </span>
        {isRoot && rootActions && (
          <>
            <div className="flex-1" />
            <div className="flex items-center gap-0.5">
              <span role="button" title="新建文件" className="p-0.5 rounded hover:bg-[var(--overlay-hover)] text-[var(--text-tertiary)] hover:text-[var(--text-primary)]" onClick={(e) => { e.stopPropagation(); rootActions.onNewFile(); }}>
                <FilePlus size={14} />
              </span>
              <span role="button" title="新建目录" className="p-0.5 rounded hover:bg-[var(--overlay-hover)] text-[var(--text-tertiary)] hover:text-[var(--text-primary)]" onClick={(e) => { e.stopPropagation(); rootActions.onNewFolder(); }}>
                <FolderPlus size={14} />
              </span>
              <span role="button" title="刷新" className="p-0.5 rounded hover:bg-[var(--overlay-hover)] text-[var(--text-tertiary)] hover:text-[var(--text-primary)]" onClick={(e) => { e.stopPropagation(); rootActions.onRefresh(); }}>
                <RefreshCw size={14} />
              </span>
              <span role="button" title="全部折叠" className="p-0.5 rounded hover:bg-[var(--overlay-hover)] text-[var(--text-tertiary)] hover:text-[var(--text-primary)]" onClick={(e) => { e.stopPropagation(); rootActions.onCollapseAll(); }}>
                <ChevronsDownUp size={14} />
              </span>
            </div>
          </>
        )}
      </div>
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
            <TreeNode
              key={child.path}
              node={child}
              depth={depth + 1}
              creatingIn={creatingIn}
              creatingType={creatingType}
              onCreatingDone={onCreatingDone}
            />
          ))}
        </>
      )}
    </div>
  );
}

export function FileTree() {
  const { loadRoot, nodesByDir, expandDir, createFile, createDir, refreshDir, collapseAll, selectedPath } = useFsStore();
  const activeProjectId = useProjectStore((s) => s.activeProjectId);
  const projects = useProjectStore((s) => s.projects);
  const project = projects.find((p) => p.id === activeProjectId);

  const [creatingIn, setCreatingIn] = useState<string | null>(null);
  const [creatingType, setCreatingType] = useState<'file' | 'dir' | null>(null);

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

  const handleNewFile = useCallback(() => {
    const targetDir = getTargetDir();
    if (targetDir && targetDir !== project?.path) expandDir(targetDir);
    setCreatingIn(targetDir);
    setCreatingType('file');
  }, [getTargetDir, project, expandDir]);

  const handleNewFolder = useCallback(() => {
    const targetDir = getTargetDir();
    if (targetDir && targetDir !== project?.path) expandDir(targetDir);
    setCreatingIn(targetDir);
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

  useEffect(() => {
    if (project) loadRoot(project.path);
  }, [project?.path]);

  if (!project) return <div className="p-4 text-sm text-[var(--text-tertiary)]">No project open</div>;

  const rootActions = {
    projectName: project.name,
    onNewFile: handleNewFile,
    onNewFolder: handleNewFolder,
    onRefresh: handleRefresh,
    onCollapseAll: handleCollapseAll,
  };

  const rootNode = { name: project.name, path: project.path, is_dir: true };

  return (
    <div className="py-2 overflow-y-auto h-full pr-1">
      <TreeNode
        node={rootNode}
        depth={0}
        isRoot={true}
        creatingIn={creatingIn}
        creatingType={creatingType}
        onCreatingDone={handleCreatingDone}
        rootActions={rootActions}
      />
    </div>
  );
}
