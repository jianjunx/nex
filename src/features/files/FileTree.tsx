import { ChevronRight, ChevronDown, File, Folder } from "lucide-react";
import { useFsStore } from "../../stores/fs.store";
import { useProjectStore } from "../../stores/project.store";
import { useEffect } from "react";

function TreeNode({ node, depth }: { node: { name: string; path: string; is_dir: boolean }; depth: number }) {
  const { expandedDirs, expandDir, collapseDir, nodesByDir, openFile } = useFsStore();
  const isExpanded = expandedDirs.has(node.path);
  const children = nodesByDir[node.path];

  const handleClick = () => {
    if (node.is_dir) {
      if (isExpanded) collapseDir(node.path);
      else expandDir(node.path);
    } else {
      openFile(node.path);
    }
  };

  return (
    <div>
      <div
        onClick={handleClick}
        className="flex items-center gap-2 px-2.5 py-1.5 text-sm cursor-pointer hover:bg-[var(--overlay-hover)] rounded-[var(--radius-sm)]"
        style={{ paddingLeft: depth * 12 + 8 }}
      >
        {node.is_dir ? (
          isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />
        ) : (
          <span className="w-3" />
        )}
        {node.is_dir ? <Folder size={14} className="text-[var(--accent)]" /> : <File size={14} className="text-[var(--text-tertiary)]" />}
        <span className="text-[var(--text-secondary)] truncate">{node.name}</span>
      </div>
      {node.is_dir && isExpanded && children?.map((child) => (
        <TreeNode key={child.path} node={child} depth={depth + 1} />
      ))}
    </div>
  );
}

export function FileTree() {
  const { loadRoot, nodesByDir } = useFsStore();
  const activeProjectId = useProjectStore((s) => s.activeProjectId);
  const projects = useProjectStore((s) => s.projects);
  const project = projects.find((p) => p.id === activeProjectId);

  useEffect(() => {
    if (project) loadRoot(project.path);
  }, [project?.path]);

  if (!project) return <div className="p-4 text-sm text-[var(--text-tertiary)]">No project open</div>;

  const rootNodes = nodesByDir[project.path] || [];

  return (
    <div className="py-2 overflow-y-auto h-full pr-1">
      {rootNodes.map((node) => (
        <TreeNode key={node.path} node={node} depth={0} />
      ))}
    </div>
  );
}
