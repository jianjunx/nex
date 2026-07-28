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
  status: "idle" | "running" | "waiting" | null;
  onCancel: () => void;
  onConfirm: () => void;
}

export function CloseTabConfirmDialog({ open, busy, status, onCancel, onConfirm }: Props) {
  const interrupting = status === "running" || status === "waiting";
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o && !busy) onCancel(); }}>
      <DialogContent showCloseButton={false} className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>关闭对话？</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-[var(--text-secondary)]">
          {interrupting
            ? "该对话的 Agent 仍在运行或等待权限，关闭将中断任务且不可恢复。"
            : "确定关闭此对话页签吗？"}
        </p>
        <DialogFooter>
          <Button variant="ghost" size="sm" disabled={busy} onClick={onCancel}>
            取消
          </Button>
          <Button
            variant={interrupting ? "destructive" : "default"}
            size="sm"
            disabled={busy}
            onClick={onConfirm}
          >
            {busy ? "关闭中…" : interrupting ? "关闭并中断" : "关闭"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
