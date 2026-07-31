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

/** Commit box + split button (提交 / 提交并推送 / 提交并同步). */
export function CommitSection({ projectPath }: { projectPath: string }) {
  const commitMessage = useGitStore((s) => s.commitMessage);
  const setCommitMessage = useGitStore((s) => s.setCommitMessage);
  const commitWith = useGitStore((s) => s.commitWith);
  const opRunning = useGitStore((s) => s.opRunning);

  const busy = opRunning !== null;
  const canCommit = commitMessage.trim().length > 0 && !busy;

  return (
    <div className="border-t border-[color:var(--border-subtle)] p-4">
      <Input
        data-scm-commit-input
        value={commitMessage}
        onChange={(e) => setCommitMessage(e.target.value)}
        placeholder="提交消息（Enter 提交）"
        className="font-normal text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)]"
        onKeyDown={(e) => {
          // Ctrl/Cmd+Enter is owned by the scm.commit command (KeybindingHost);
          // the local handler only takes bare Enter, and never mid-IME.
          if (e.key === "Enter" && !e.ctrlKey && !e.metaKey && !e.nativeEvent.isComposing) {
            void commitWith(projectPath, "commit");
          }
        }}
      />
      <div className="mt-3 flex gap-1">
        <Button
          className="flex-1 h-auto bg-[var(--accent)] py-2.5 text-white hover:bg-[var(--accent-hover)] dark:bg-[var(--accent)] dark:text-white dark:hover:bg-[var(--accent-hover)]"
          disabled={!canCommit}
          onClick={() => void commitWith(projectPath, "commit")}
        >
          {opRunning === "提交" ? (
            <Loader2 size={14} className="mr-2 animate-spin" />
          ) : (
            <Check size={14} className="mr-2" />
          )}
          提交
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              title="更多提交方式"
              className="h-auto bg-[var(--accent)] px-2 py-2.5 text-white hover:bg-[var(--accent-hover)] dark:bg-[var(--accent)] dark:text-white dark:hover:bg-[var(--accent-hover)]"
              disabled={!canCommit}
            >
              <ChevronDown size={14} />
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
    </div>
  );
}
