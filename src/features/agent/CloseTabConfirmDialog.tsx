import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface Props {
  open: boolean;
  busy: boolean;
  status: "starting" | "idle" | "running" | "waiting" | null;
  onCancel: () => void;
  onConfirm: () => void;
  /** "delete" removes the conversation and its history from the sidebar. */
  mode?: "close" | "delete";
}

export function CloseTabConfirmDialog({ open, busy, status, onCancel, onConfirm, mode = "close" }: Props) {
  const deleting = mode === "delete";
  const interrupting = status === "running" || status === "waiting";
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o && !busy) onCancel(); }}>
      <DialogContent showCloseButton={false} className="sm:max-w-sm border-[color:var(--hairline-soft)] bg-[var(--material-elevated)]">
        <DialogHeader>
          <DialogTitle>{deleting ? "删除对话？" : "关闭对话？"}</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-[var(--text-secondary)]">
          {interrupting
            ? `该对话的 Agent 仍在运行或等待权限，${deleting ? "删除" : "关闭"}将中断任务且不可恢复。`
            : deleting
              ? "确定删除此对话及其历史记录吗？此操作不可恢复。"
              : "确定关闭此对话页签吗？"}
        </p>
        <DialogFooter>
          <Button variant="ghost" size="sm" disabled={busy} onClick={onCancel}>
            取消
          </Button>
          <Button
            variant={interrupting || deleting ? "destructive" : "default"}
            size="sm"
            disabled={busy}
            onClick={onConfirm}
          >
            {busy
              ? deleting ? "删除中…" : "关闭中…"
              : interrupting
                ? deleting ? "删除并中断" : "关闭并中断"
                : deleting ? "删除" : "关闭"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
