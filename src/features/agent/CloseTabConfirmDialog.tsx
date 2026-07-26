import { Button, Modal, ModalContent, ModalHeader, ModalTitle } from "@glinui/ui";

const ACCENT_CTA =
  "bg-[var(--accent)] text-white hover:bg-[var(--accent-hover)] dark:bg-[var(--accent)] dark:text-white dark:hover:bg-[var(--accent-hover)]";

const DANGER_CTA =
  "bg-[var(--error)] text-white hover:opacity-90 dark:bg-[var(--error)] dark:text-white";

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
    <Modal open={open} onOpenChange={(o) => { if (!o && !busy) onCancel(); }}>
      <ModalContent size="sm">
        <ModalHeader>
          <ModalTitle>关闭对话？</ModalTitle>
        </ModalHeader>
        <p className="text-sm text-[var(--text-secondary)] px-1">
          {interrupting
            ? "该对话的 Agent 仍在运行或等待权限，关闭将中断任务且不可恢复。"
            : "确定关闭此对话页签吗？"}
        </p>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" size="sm" disabled={busy} onClick={onCancel}>
            取消
          </Button>
          <Button
            size="sm"
            disabled={busy}
            className={interrupting ? DANGER_CTA : ACCENT_CTA}
            onClick={onConfirm}
          >
            {busy ? "关闭中…" : interrupting ? "关闭并中断" : "关闭"}
          </Button>
        </div>
      </ModalContent>
    </Modal>
  );
}
