import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
} from "@/components/ui/dropdown-menu";
import {
  FilePlus,
  FolderPlus,
  Copy,
  Scissors,
  ClipboardPaste,
  Link,
  Pencil,
  Trash2,
} from "lucide-react";
import { useClipboardStore } from "@/stores/clipboard.store";
import { useFsStore } from "@/stores/fs.store";
import { useProjectStore } from "@/stores/project.store";
import { detectPlatform } from "@/commands/types";
import { isSameOrDescendant } from "@/features/editor/pathUtils";

interface TreeContextMenuProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  position: { x: number; y: number };
  node: { name: string; path: string; is_dir: boolean };
  onClose: () => void;
  onRename: () => void;
  onNewFile?: () => void;
  onNewFolder?: () => void;
}

const platform = detectPlatform();
const isMac = platform === "mac";

export function TreeContextMenu({
  open,
  onOpenChange,
  position,
  node,
  onClose,
  onRename,
  onNewFile,
  onNewFolder,
}: TreeContextMenuProps) {
  const clipboard = useClipboardStore();
  const fs = useFsStore();
  const canPaste = clipboard.hasEntries();

  const handleCopy = () => {
    clipboard.setEntries([{ path: node.path, isCut: false }]);
    onClose();
  };

  const handleCut = () => {
    clipboard.setEntries([{ path: node.path, isCut: true }]);
    onClose();
  };

  const handlePaste = () => {
    if (!canPaste) return;
    const entries = clipboard.entries;
    // Paste into this directory — refuse copying/moving a folder into itself
    // or a descendant (otherwise backend would nest `src/src/src/...`).
    const sources = entries.map((e) => e.path);
    if (sources.some((src) => isSameOrDescendant(node.path, src))) {
      onClose();
      return;
    }
    if (entries.some((e) => e.isCut)) {
      // Move: cut entries
      void fs.moveEntries(sources, node.path);
      clipboard.clear();
    } else {
      // Copy
      void fs.copyEntries(sources, node.path);
    }
    onClose();
  };

  const handleCopyPath = () => {
    navigator.clipboard.writeText(node.path).catch(() => {});
    onClose();
  };

  const handleCopyRelativePath = async () => {
    try {
      // Prefer path relative to the active project root.
      const projects = useProjectStore.getState().projects;
      const activeId = useProjectStore.getState().activeProjectId;
      const root = projects.find((p) => p.id === activeId)?.path;
      let text = node.name;
      if (root && node.path.startsWith(root)) {
        const rel = node.path.slice(root.length).replace(/^[/\\]/, "");
        if (rel) text = rel;
      }
      await navigator.clipboard.writeText(text);
    } catch {
      navigator.clipboard.writeText(node.path).catch(() => {});
    }
    onClose();
  };

  const handleDelete = () => {
    fs.requestDeleteEntry(node.path);
    onClose();
  };

  // File node context menu
  if (!node.is_dir) {
    return (
      <DropdownMenu open={open} onOpenChange={onOpenChange} modal={false}>
        <DropdownMenuContent
          className="w-52"
          style={{ position: "fixed", left: position.x, top: position.y }}
          onCloseAutoFocus={(e) => e.preventDefault()}
        >
          <DropdownMenuGroup>
            <DropdownMenuItem onClick={handleCopy}>
              <Copy className="size-4" />
              <span>复制</span>
              <DropdownMenuShortcut>{isMac ? "⌘C" : "Ctrl+C"}</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem onClick={handleCut}>
              <Scissors className="size-4" />
              <span>剪切</span>
              <DropdownMenuShortcut>{isMac ? "⌘X" : "Ctrl+X"}</DropdownMenuShortcut>
            </DropdownMenuItem>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuItem onClick={handleCopyPath}>
              <Link className="size-4" />
              <span>复制路径</span>
            </DropdownMenuItem>
            <DropdownMenuItem onClick={handleCopyRelativePath}>
              <Link className="size-4" />
              <span>复制相对路径</span>
            </DropdownMenuItem>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuItem onClick={onRename}>
              <Pencil className="size-4" />
              <span>重命名</span>
              <DropdownMenuShortcut>{isMac ? "⏎" : "F2"}</DropdownMenuShortcut>
            </DropdownMenuItem>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={handleDelete} variant="destructive">
            <Trash2 className="size-4" />
            <span>删除</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  // Directory node context menu
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange} modal={false}>
      <DropdownMenuContent
        className="w-52"
        style={{ position: "fixed", left: position.x, top: position.y }}
        onCloseAutoFocus={(e) => e.preventDefault()}
      >
        <DropdownMenuGroup>
          {onNewFile && (
            <DropdownMenuItem onClick={onNewFile}>
              <FilePlus className="size-4" />
              <span>新建文件</span>
            </DropdownMenuItem>
          )}
          {onNewFolder && (
            <DropdownMenuItem onClick={onNewFolder}>
              <FolderPlus className="size-4" />
              <span>新建文件夹</span>
            </DropdownMenuItem>
          )}
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem onClick={handleCopy}>
            <Copy className="size-4" />
            <span>复制</span>
            <DropdownMenuShortcut>{isMac ? "⌘C" : "Ctrl+C"}</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={handleCut}>
            <Scissors className="size-4" />
            <span>剪切</span>
            <DropdownMenuShortcut>{isMac ? "⌘X" : "Ctrl+X"}</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={handlePaste} disabled={!canPaste}>
            <ClipboardPaste className="size-4" />
            <span>粘贴</span>
            <DropdownMenuShortcut>{isMac ? "⌘V" : "Ctrl+V"}</DropdownMenuShortcut>
          </DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem onClick={handleCopyPath}>
            <Link className="size-4" />
            <span>复制路径</span>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={handleCopyRelativePath}>
            <Link className="size-4" />
            <span>复制相对路径</span>
          </DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem onClick={onRename}>
            <Pencil className="size-4" />
            <span>重命名</span>
            <DropdownMenuShortcut>{isMac ? "⏎" : "F2"}</DropdownMenuShortcut>
          </DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={handleDelete} variant="destructive">
          <Trash2 className="size-4" />
          <span>删除</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
