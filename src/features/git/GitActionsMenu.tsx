import { useEffect, useState } from "react";
import { Check, ChevronDown, Loader2, MoreHorizontal } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { useGitStore } from "../../stores/git.store";
import type { StashEntry } from "../../bridge/tauri";
import { GitConfirmDialog } from "./GitConfirmDialog";

interface GitActionsMenuProps {
  projectPath: string;
  /** 复用 T9 落在 GitPanel 的 BranchSelector（检出远端分支项）。 */
  onOpenBranchSelector: () => void;
}

/** GitPanel 头部 ··· 菜单：远端操作 / 检出 / 存储子菜单 / 操作日志开关。 */
export function GitActionsMenu({ projectPath, onOpenBranchSelector }: GitActionsMenuProps) {
  const opRunning = useGitStore((s) => s.opRunning);
  const stashes = useGitStore((s) => s.stashes);
  const opLogOpen = useGitStore((s) => s.opLogOpen);
  const setOpLogOpen = useGitStore((s) => s.setOpLogOpen);
  const loadStashes = useGitStore((s) => s.loadStashes);
  const gitFetchOp = useGitStore((s) => s.fetch);
  const gitPullOp = useGitStore((s) => s.pull);
  const gitPushOp = useGitStore((s) => s.push);
  const gitCloneOp = useGitStore((s) => s.clone);
  const stashSave = useGitStore((s) => s.stashSave);
  const stashApply = useGitStore((s) => s.stashApply);
  const stashPop = useGitStore((s) => s.stashPop);
  const stashDrop = useGitStore((s) => s.stashDrop);

  const [cloneOpen, setCloneOpen] = useState(false);
  const [cloneUrl, setCloneUrl] = useState("");
  const [cloneDest, setCloneDest] = useState("");
  const [stashDialogOpen, setStashDialogOpen] = useState(false);
  const [stashMsg, setStashMsg] = useState("");
  const [stashSubOpen, setStashSubOpen] = useState(false);
  const [selectedStash, setSelectedStash] = useState<string | null>(null);
  const [toDrop, setToDrop] = useState<StashEntry | null>(null);

  const busy = opRunning !== null;
  // 进行中的项显示 spinner 但不禁用自身（store runOp 有 opRunning 重入守卫）；
  // 其余网络项在任一操作进行时禁用。
  const isRunning = (op: string) => opRunning === op;
  const othersDisabled = (op: string) => busy && opRunning !== op;

  // 列表刷新后自动选中首条，让弹出/应用/删除开箱即用。
  useEffect(() => {
    if (selectedStash === null && stashes.length > 0) setSelectedStash(stashes[0].id);
  }, [stashes, selectedStash]);

  // 照抄 ProjectSelector.tsx:85 模式：先尽力前台再开原生目录对话框，
  // 否则 Windows 上系统对话框可能落到应用窗口后方。
  const pickCloneDest = async () => {
    await getCurrentWindow().setFocus().catch(() => {});
    const selected = await open({ directory: true, multiple: false, title: "选择克隆目标目录" });
    if (selected && typeof selected === "string") setCloneDest(selected);
  };

  const confirmClone = async () => {
    const url = cloneUrl.trim();
    if (!url || !cloneDest || busy) return;
    const ok = await gitCloneOp(url, cloneDest);
    if (ok) {
      setCloneOpen(false);
      setCloneUrl("");
      setCloneDest("");
    }
  };

  const confirmStashSave = async () => {
    const ok = await stashSave(projectPath, stashMsg.trim());
    if (ok) {
      setStashDialogOpen(false);
      setStashMsg("");
    }
  };

  const spinner = (op: string) => (isRunning(op) ? <Loader2 size={13} className="mr-2 animate-spin" /> : null);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-xs" title="更多操作">
            <MoreHorizontal size={13} />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuItem disabled={othersDisabled("拉取")} onSelect={() => void gitPullOp(projectPath)}>
            {spinner("拉取")}拉取
          </DropdownMenuItem>
          <DropdownMenuItem disabled={othersDisabled("推送")} onSelect={() => void gitPushOp(projectPath)}>
            {spinner("推送")}推送
          </DropdownMenuItem>
          <DropdownMenuItem disabled={othersDisabled("获取")} onSelect={() => void gitFetchOp(projectPath)}>
            {spinner("获取")}获取
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={othersDisabled("克隆")}
            onSelect={() => setCloneOpen(true)}
          >
            {spinner("克隆")}克隆…
          </DropdownMenuItem>
          <DropdownMenuItem disabled={busy} onSelect={onOpenBranchSelector}>
            检出远端分支…
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuSub
            open={stashSubOpen}
            onOpenChange={(o) => {
              setStashSubOpen(o);
              if (o) void loadStashes(projectPath);
            }}
          >
            <DropdownMenuSubTrigger data-testid="stash-subtrigger" onClick={() => setStashSubOpen(true)}>
              存储
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-64">
              <DropdownMenuItem data-testid="stash-new" onSelect={() => setStashDialogOpen(true)}>
                新建存储…
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>存储列表（点选后下方三项作用于选中条目）</DropdownMenuLabel>
              {stashes.map((s) => (
                <DropdownMenuItem key={s.id} data-testid={`stash-${s.index}`} onSelect={(e) => { e.preventDefault(); setSelectedStash(s.id); }}>
                  <span className="mr-1 inline-flex w-3 justify-center">
                    {selectedStash === s.id ? <Check size={12} /> : ""}
                  </span>
                  {`stash@{${s.index}}: ${s.message || "（无消息）"}`}
                </DropdownMenuItem>
              ))}
              {stashes.length === 0 && <DropdownMenuItem disabled>暂无存储条目</DropdownMenuItem>}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                disabled={selectedStash === null || busy}
                onSelect={() => {
                  if (selectedStash !== null) {
                    const id = selectedStash;
                    // R2：pop 成功后 stash 索引整体前移——清选中让自动选首项接管
                    void stashPop(projectPath, id).then((ok) => {
                      if (ok) setSelectedStash(null);
                    });
                  }
                }}
              >
                弹出存储
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={selectedStash === null || busy}
                onSelect={() => {
                  if (selectedStash !== null) void stashApply(projectPath, selectedStash);
                }}
              >
                应用存储
              </DropdownMenuItem>
              <DropdownMenuItem
                data-testid="stash-drop"
                disabled={selectedStash === null || busy}
                onSelect={() => {
                  const entry = stashes.find((x) => x.id === selectedStash);
                  if (entry) setToDrop(entry);
                }}
              >
                删除存储
              </DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSeparator />
          <DropdownMenuCheckboxItem checked={opLogOpen} onCheckedChange={(v) => setOpLogOpen(!!v)}>
            显示操作日志
          </DropdownMenuCheckboxItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* 克隆对话框：URL 输入 + 原生目录选择（父目录，后端在其下建同名子目录） */}
      <Dialog open={cloneOpen} onOpenChange={setCloneOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>克隆仓库</DialogTitle>
            <DialogDescription>输入仓库 URL（https / ssh / file），并选择存放的父目录。</DialogDescription>
          </DialogHeader>
          <Input
            autoFocus
            value={cloneUrl}
            onChange={(e) => setCloneUrl(e.target.value)}
            placeholder="https://github.com/user/repo.git"
          />
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-xs text-[var(--text-tertiary)]">
              {cloneDest || "尚未选择目标目录"}
            </span>
            <Button variant="outline" size="sm" onClick={() => void pickCloneDest()}>
              选择目录…
            </Button>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCloneOpen(false)}>
              取消
            </Button>
            <Button disabled={!cloneUrl.trim() || !cloneDest || busy} onClick={() => void confirmClone()}>
              {isRunning("克隆") && <Loader2 size={13} className="mr-2 animate-spin" />}
              克隆
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 新建存储对话框：消息可空，空则后端合成「WIP on <分支>」 */}
      <Dialog open={stashDialogOpen} onOpenChange={setStashDialogOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>新建存储</DialogTitle>
            <DialogDescription>把工作区改动（含未跟踪文件）存入 stash。</DialogDescription>
          </DialogHeader>
          <Input
            autoFocus
            value={stashMsg}
            onChange={(e) => setStashMsg(e.target.value)}
            placeholder="存储消息（可空）"
            onKeyDown={(e) => {
              if (e.key === "Enter") void confirmStashSave();
            }}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setStashDialogOpen(false)}>
              取消
            </Button>
            <Button disabled={busy} onClick={() => void confirmStashSave()}>
              {isRunning("存储") && <Loader2 size={13} className="mr-2 animate-spin" />}
              存储
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <GitConfirmDialog
        open={toDrop !== null}
        title="删除存储"
        description={`永久删除存储条目 stash@{${toDrop?.index ?? ""}}「${toDrop?.message ?? ""}」？此操作不可撤销。`}
        confirmLabel="删除"
        busy={busy}
        onCancel={() => setToDrop(null)}
        onConfirm={async () => {
          // R2：await 期间保持确认框打开渲染 busy；成功后关框并清选中（索引前移）
          const entry = toDrop;
          if (!entry) return;
          const ok = await stashDrop(projectPath, entry.id);
          if (ok) {
            setToDrop(null);
            setSelectedStash(null);
          }
        }}
      />
    </>
  );
}

/** 底部操作日志折叠面板：由菜单「显示操作日志」切换；100 条上限由 T7 store 裁剪。 */
export function OpLogPanel() {
  const opLog = useGitStore((s) => s.opLog);
  const opLogOpen = useGitStore((s) => s.opLogOpen);
  const setOpLogOpen = useGitStore((s) => s.setOpLogOpen);
  const clearLog = useGitStore((s) => s.clearLog);

  if (!opLogOpen) return null;
  return (
    <div className="border-t border-[color:var(--border-subtle)]">
      <div className="flex items-center gap-2 px-3 py-1.5 text-xs text-[var(--text-tertiary)]">
        <span>操作日志 ({opLog.length})</span>
        <div className="flex-1" />
        <button
          title="清空日志"
          className="rounded px-1 py-0.5 transition-colors duration-100 hover:bg-[var(--overlay-hover)] hover:text-[var(--text-primary)]"
          onClick={clearLog}
        >
          清空
        </button>
        <button
          title="收起"
          className="rounded p-0.5 transition-colors duration-100 hover:bg-[var(--overlay-hover)] hover:text-[var(--text-primary)]"
          onClick={() => setOpLogOpen(false)}
        >
          <ChevronDown size={12} />
        </button>
      </div>
      <div className="max-h-40 overflow-y-auto">
        <div className="space-y-0.5 px-3 pb-2 font-mono text-[11px] leading-relaxed text-[var(--text-secondary)]">
          {opLog.length === 0 ? (
            <div className="text-[var(--text-tertiary)]">暂无操作记录</div>
          ) : (
            opLog.map((line, i) => <div key={`${i}-${line}`}>{line}</div>)
          )}
        </div>
      </div>
    </div>
  );
}
