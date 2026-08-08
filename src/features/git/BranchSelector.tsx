import { useEffect, useState } from "react";
import { Check, ChevronDown, GitBranch, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
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

/** 分支切换下拉面板（含搜索/删除）+「新建分支…」小弹窗。 */
export function BranchSelector({ projectPath, open, onOpenChange }: BranchSelectorProps) {
  const status = useGitStore((s) => s.status);
  const branches = useGitStore((s) => s.branches);
  const opRunning = useGitStore((s) => s.opRunning);
  const loadBranches = useGitStore((s) => s.loadBranches);
  const checkout = useGitStore((s) => s.checkout);
  const createBranch = useGitStore((s) => s.createBranch);
  const deleteBranch = useGitStore((s) => s.deleteBranch);
  // R1：store error 被对话框遮罩盖住 GitPanel 错误条——下拉面板内自行回显
  const error = useGitStore((s) => s.error);

  const [query, setQuery] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [toDelete, setToDelete] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setQuery("");
      setToDelete(null);
      void loadBranches(projectPath);
    }
  }, [open, projectPath, loadBranches]);

  const busy = !!opRunning;
  const q = query.trim().toLowerCase();
  const match = (name: string) => name.toLowerCase().includes(q);
  const byRecency = <T extends { tipTime?: number | null; name: string }>(a: T, b: T) => {
    const ta = a.tipTime ?? Number.NEGATIVE_INFINITY;
    const tb = b.tipTime ?? Number.NEGATIVE_INFINITY;
    if (tb !== ta) return tb - ta;
    return a.name.localeCompare(b.name);
  };
  const locals = branches.filter((b) => !b.isRemote && match(b.name)).slice().sort(byRecency);
  const remotes = branches.filter((b) => b.isRemote && match(b.name)).slice().sort(byRecency);

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
    setCreateOpen(false);
    setNewName("");
    const switched = await checkout(projectPath, name);
    if (switched) onOpenChange(false);
  };

  return (
    <>
      <DropdownMenu open={open} onOpenChange={onOpenChange}>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="xs"
            data-testid="branch-trigger"
            className="max-w-[55%] gap-1.5"
          >
            <GitBranch size={13} className="shrink-0 text-[var(--accent)]" />
            <span className="truncate">{status?.branch || "—"}</span>
            <ChevronDown size={12} className="shrink-0 text-[var(--text-tertiary)]" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          className="flex w-64 max-h-[350px] flex-col overflow-hidden p-0"
        >
          <div className="shrink-0 p-1.5 pb-1">
            <Input
              autoFocus
              data-testid="branch-search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索分支…"
              className="h-7 font-normal"
              // Radix 菜单内容会拦截方向键导航菜单项——输入框内按键不冒泡给菜单
              onKeyDown={(e) => e.stopPropagation()}
            />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-1 pt-0">
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
                  将创建本地同名分支并跟踪远程（已存在则直接签出）
                </div>
              </>
            )}
            {error && <p className="px-2 py-1 text-xs text-[var(--error)]">{error.split(/\r?\n/)[0]}</p>}
          </div>
          <div className="shrink-0 border-t border-[var(--border-subtle)] p-1">
            {/* 选中后菜单自动关闭，弹新建分支小窗 */}
            <DropdownMenuItem data-testid="new-branch-item" onSelect={() => setCreateOpen(true)}>
              <Plus size={13} /> 新建分支…
            </DropdownMenuItem>
          </div>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* 新建分支弹窗：创建成功后直接签出新分支 */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>新建分支</DialogTitle>
            <DialogDescription>基于当前 HEAD 创建分支并签出。</DialogDescription>
          </DialogHeader>
          <Input
            autoFocus
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="新分支名"
            onKeyDown={(e) => {
              if (e.key === "Enter") void doCreate();
            }}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              取消
            </Button>
            <Button disabled={!newName.trim() || busy} onClick={() => void doCreate()}>
              <Plus size={13} /> 创建
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
    </>
  );
}
