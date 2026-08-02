import { Check, ChevronDown, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
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

  const busy = opRunning !== null;
  const canCommit = commitMessage.trim().length > 0 && !busy;

  return (
    <div className="flex items-center gap-1.5 py-2">
      <Input
        data-scm-commit-input
        value={commitMessage}
        onChange={(e) => setCommitMessage(e.target.value)}
        placeholder="提交消息（Enter 提交）"
        className="h-7 flex-1 font-normal text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)]"
        onKeyDown={(e) => {
          // Ctrl/Cmd+Enter is owned by the scm.commit command (KeybindingHost);
          // the local handler only takes bare Enter, and never mid-IME.
          if (e.key === "Enter" && !e.ctrlKey && !e.metaKey && !e.nativeEvent.isComposing) {
            void commitWith(projectPath, "commit");
          }
        }}
      />
      <Button
        size="xs"
        className="h-7 shrink-0 gap-1 bg-[var(--accent)] px-2.5 text-xs text-white hover:bg-[var(--accent-hover)] dark:bg-[var(--accent)] dark:text-white dark:hover:bg-[var(--accent-hover)]"
        disabled={!canCommit}
        onClick={() => void commitWith(projectPath, "commit")}
      >
        {opRunning === "提交" ? (
          <Loader2 size={12} className="animate-spin" />
        ) : (
          <Check size={12} />
        )}
        提交
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            size="xs"
            title="更多提交方式"
            className="h-7 shrink-0 bg-[var(--accent)] px-1.5 text-white hover:bg-[var(--accent-hover)] dark:bg-[var(--accent)] dark:text-white dark:hover:bg-[var(--accent-hover)]"
            disabled={!canCommit}
          >
            <ChevronDown size={12} />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          <DropdownMenuItem onSelect={() => void commitWith(projectPath, "push")}>
            提交并推送
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => void commitWith(projectPath, "sync")}>
            提交并同步（拉取后推送）
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
