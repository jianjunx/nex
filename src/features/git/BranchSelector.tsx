import { useEffect, useState } from "react";
import { Check, GitBranch, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useGitStore } from "../../stores/git.store";
import { GitConfirmDialog } from "./GitConfirmDialog";

interface BranchSelectorProps {
  projectPath: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Branch switcher/creator/deleter dialog opened from the Git panel header. */
export function BranchSelector({ projectPath, open, onOpenChange }: BranchSelectorProps) {
  const branches = useGitStore((s) => s.branches);
  const opRunning = useGitStore((s) => s.opRunning);
  const loadBranches = useGitStore((s) => s.loadBranches);
  const checkout = useGitStore((s) => s.checkout);
  const createBranch = useGitStore((s) => s.createBranch);
  const deleteBranch = useGitStore((s) => s.deleteBranch);
  // R1：store error 被对话框遮罩盖住 GitPanel 错误条——对话框内自行回显
  const error = useGitStore((s) => s.error);

  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [toDelete, setToDelete] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setQuery("");
      setCreating(false);
      setNewName("");
      setToDelete(null);
      void loadBranches(projectPath);
    }
  }, [open, projectPath, loadBranches]);

  const busy = !!opRunning;
  const q = query.trim().toLowerCase();
  const match = (name: string) => name.toLowerCase().includes(q);
  const locals = branches.filter((b) => !b.isRemote && match(b.name));
  const remotes = branches.filter((b) => b.isRemote && match(b.name));

  const doCheckout = async (name: string) => {
    if (busy) return;
    const ok = await checkout(projectPath, name);
    if (ok) onOpenChange(false);
  };

  const doCreate = async () => {
    const name = newName.trim();
    if (!name || busy) return;
    const ok = await createBranch(projectPath, name);
    if (!ok) return;
    setCreating(false);
    setNewName("");
    const switched = await checkout(projectPath, name);
    if (switched) onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>切换分支</DialogTitle>
        </DialogHeader>
        <Input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索分支…"
        />
        <div className="max-h-72 -mx-1 overflow-y-auto">
          <div className="px-2 py-1 text-xs text-[var(--text-tertiary)]">本地</div>
          {locals.map((b) => (
            <div
              key={b.name}
              data-testid={`branch-${b.name}`}
              className="group flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 hover:bg-[var(--overlay-hover)]"
              onClick={() => void doCheckout(b.name)}
            >
              <GitBranch size={13} className="shrink-0 text-[var(--text-tertiary)]" />
              <span className="flex-1 truncate text-sm">{b.name}</span>
              {b.isHead ? (
                <Check size={13} className="shrink-0 text-[var(--accent)]" />
              ) : (
                <button
                  data-testid={`delete-${b.name}`}
                  className="shrink-0 text-[var(--text-tertiary)] opacity-0 transition-opacity hover:text-[var(--error)] group-hover:opacity-100"
                  title="删除分支"
                  onClick={(e) => {
                    e.stopPropagation();
                    setToDelete(b.name);
                  }}
                >
                  <Trash2 size={13} />
                </button>
              )}
            </div>
          ))}
          {locals.length === 0 && (
            <div className="px-2 py-1.5 text-xs text-[var(--text-tertiary)]">无匹配分支</div>
          )}
          {remotes.length > 0 && (
            <>
              <div className="mt-1 border-t border-[var(--border-subtle)] px-2 py-1 pt-2 text-xs text-[var(--text-tertiary)]">
                远程
              </div>
              {remotes.map((b) => (
                <div
                  key={b.name}
                  data-testid={`branch-${b.name}`}
                  className="group flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 hover:bg-[var(--overlay-hover)]"
                  onClick={() => void doCheckout(b.name)}
                >
                  <GitBranch size={13} className="shrink-0 text-[var(--text-tertiary)]" />
                  <span className="flex-1 truncate text-sm">{b.name}</span>
                </div>
              ))}
              <div className="px-2 py-1 text-xs text-[var(--text-tertiary)]">
                签出远程分支将进入分离 HEAD 状态
              </div>
            </>
          )}
        </div>
        {error && (
          <p className="px-1 text-xs text-[var(--error)]">{error}</p>
        )}
        <div className="border-t border-[var(--border-subtle)] pt-3">
          {creating ? (
            <div className="flex gap-2">
              <Input
                autoFocus
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="新分支名"
                onKeyDown={(e) => {
                  if (e.key === "Enter") void doCreate();
                }}
              />
              <Button size="sm" disabled={!newName.trim() || busy} onClick={() => void doCreate()}>
                <Plus size={13} /> 创建
              </Button>
            </div>
          ) : (
            <Button variant="outline" size="sm" className="w-full" onClick={() => setCreating(true)}>
              <Plus size={13} /> 新建分支…
            </Button>
          )}
        </div>
        <GitConfirmDialog
          open={toDelete !== null}
          title="删除分支"
          description={`确定删除分支「${toDelete ?? ""}」？未合并的提交将无法找回。`}
          confirmLabel="删除"
          busy={busy}
          onCancel={() => setToDelete(null)}
          onConfirm={async () => {
            // R2：await 期间保持对话框打开让 busy 禁用态可渲染，成功后再关
            const name = toDelete;
            if (!name) return;
            const ok = await deleteBranch(projectPath, name);
            if (ok) setToDelete(null);
          }}
        />
      </DialogContent>
    </Dialog>
  );
}
