import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface GitErrorDialogProps {
  open: boolean;
  error: string | null;
  onClose: () => void;
}

/** First meaningful line as summary; full text shown when expanded. */
export function summarizeGitError(error: string): { summary: string; detail: string } {
  const trimmed = error.trim();
  const lines = trimmed.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const preferred =
    lines.find((l) => l.startsWith("fatal:") || l.startsWith("error:")) ??
    lines.find((l) => l.startsWith("hint:")) ??
    lines[0] ??
    "Git 操作失败";
  return { summary: preferred, detail: trimmed };
}

export function GitErrorDialog({ open, error, onClose }: GitErrorDialogProps) {
  const [expanded, setExpanded] = useState(false);
  const { summary, detail } = useMemo(
    () => (error ? summarizeGitError(error) : { summary: "", detail: "" }),
    [error],
  );
  const hasDetail = detail.length > 0 && detail !== summary;

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          setExpanded(false);
          onClose();
        }
      }}
    >
      <DialogContent className="sm:max-w-md" data-testid="git-error-dialog">
        <DialogHeader>
          <DialogTitle>操作失败</DialogTitle>
          <DialogDescription className="break-words text-[var(--error)]">
            {summary}
          </DialogDescription>
        </DialogHeader>
        {hasDetail && (
          <div className="space-y-1.5">
            <button
              type="button"
              data-testid="git-error-toggle-detail"
              className="inline-flex items-center gap-1 text-xs text-[var(--text-tertiary)] transition-colors hover:text-[var(--text-primary)]"
              onClick={() => setExpanded((v) => !v)}
            >
              {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              {expanded ? "收起详情" : "查看错误详情"}
            </button>
            {expanded && (
              <pre
                data-testid="git-error-detail"
                className="max-h-48 overflow-auto rounded-md border border-[color:var(--border-subtle)] bg-[var(--overlay-hover)] p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-[var(--text-secondary)]"
              >
                {detail}
              </pre>
            )}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            关闭
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
