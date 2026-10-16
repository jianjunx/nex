import { Check, ChevronDown, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { usePendingOption } from "../agent/usePendingOption";
import { useGitStore } from "../../stores/git.store";

/**
 * Commit box + split button (提交 / 提交并推送 / 提交并同步).
 * 由 ChangesSection 渲染在「更改」标题下方；紧凑单行布局。
 */
export function CommitSection({ projectPath }: { projectPath: string }) {
  const commitMessage = useGitStore((s) => s.commitMessage);
  const setCommitMessage = useGitStore((s) => s.setCommitMessage);
  const commitWith = useGitStore((s) => s.commitWith);
  const opRunning = useGitStore((s) => s.opRunning);

  const { open, setOpen, pendingId, select } = usePendingOption(async (mode) => {
    await commitWith(projectPath, mode as "commit" | "push" | "sync");
  }, undefined, "提交失败");
  const busy = opRunning !== null || pendingId !== null;
  const canCommit = commitMessage.trim().length > 0 && !busy;

  return (
    <div className="flex items-center gap-1.5 py-1">
      <Input
        data-scm-commit-input
        value={commitMessage}
        onChange={(e) => setCommitMessage(e.target.value)}
        placeholder="提交消息（Enter 提交）"
        className="h-7 flex-1 font-normal text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)]"
        onKeyDown={(e) => {
          // Ctrl/Cmd+Enter is owned by the scm.commit command (KeybindingHost);
          // the local handler only takes bare Enter, and never mid-IME.
          if (canCommit && e.key === "Enter" && !e.ctrlKey && !e.metaKey && !e.nativeEvent.isComposing) {
            void select("commit");
          }
        }}
      />
      <Button
        size="xs"
        className="h-7 shrink-0 gap-1 bg-[var(--accent)] px-2.5 text-xs text-white hover:bg-[var(--accent-hover)] dark:bg-[var(--accent)] dark:text-white dark:hover:bg-[var(--accent-hover)]"
        disabled={!canCommit}
        onClick={() => void select("commit")}
      >
        <Check size={12} />
        提交
        {(opRunning === "提交" || pendingId !== null) && (
          <Loader2 size={12} className="animate-spin" aria-label="提交中" />
        )}
      </Button>
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger asChild>
          <Button
            size="xs"
            title="更多提交方式"
            className="h-7 shrink-0 bg-[var(--accent)] px-1.5 text-white hover:bg-[var(--accent-hover)] dark:bg-[var(--accent)] dark:text-white dark:hover:bg-[var(--accent-hover)]"
            disabled={!canCommit}
          >
            {pendingId !== null ? <Loader2 size={12} className="animate-spin" aria-label="提交中" /> : <ChevronDown size={12} />}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          <DropdownMenuItem disabled={busy} aria-busy={pendingId === "push"} onSelect={(event) => { event.preventDefault(); void select("push"); }}>
            提交并推送
            {pendingId === "push" && <Loader2 size={13} className="ml-auto shrink-0 animate-spin" aria-label="提交中" />}
          </DropdownMenuItem>
          <DropdownMenuItem disabled={busy} aria-busy={pendingId === "sync"} onSelect={(event) => { event.preventDefault(); void select("sync"); }}>
            提交并同步（拉取后推送）
            {pendingId === "sync" && <Loader2 size={13} className="ml-auto shrink-0 animate-spin" aria-label="提交中" />}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
