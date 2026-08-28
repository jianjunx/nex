import { memo, useMemo } from "react";
import { ListChecks } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { ThinkingBlock } from "./ThinkingBlock";
import { ToolCallCard } from "./ToolCallCard";
import { PlanApprovalCard } from "./PlanApprovalCard";
import { AskQuestionCard } from "./AskQuestionCard";
import { MessageContextMenu } from "./MessageContextMenu";
import { Markdown } from "./Markdown";
import { groupChunks } from "./groupChunks";
import { UserMessageBubble } from "./UserMessageBubble";
import type { ThreadEntry } from "./types";

/**
 * 单条线程条目渲染。memo 化依赖 entry 引用稳定(immer 结构共享):
 * 流式更新只改末尾 entry,历史条目不重渲染。
 */
export const EntryView = memo(function EntryView({
  entry,
  userExpanded = false,
  onToggleUserExpand,
  floating = false,
}: {
  entry: ThreadEntry;
  userExpanded?: boolean;
  onToggleUserExpand?: (id: string) => void;
  floating?: boolean;
}) {
  const groupedChunks = useMemo(
    () => (entry.kind === "assistant_message" ? groupChunks(entry.chunks) : []),
    [entry],
  );

  switch (entry.kind) {
    case "user_message":
      return (
        <UserMessageBubble
          entry={entry}
          expanded={userExpanded}
          onToggleExpand={() => onToggleUserExpand?.(entry.id)}
          floating={floating}
        />
      );
    case "assistant_message":
      return (
        <div className="flex flex-col gap-1.5 max-w-[96%]">
          {groupedChunks.map((g, i) =>
            g.type === "thought" ? (
              <ThinkingBlock key={i} text={g.text} />
            ) : (
              <MessageContextMenu key={i} textContent={g.text}>
                <Card className="gap-0 rounded-[calc(var(--radius-md)+2px)] border-[color:var(--hairline-soft)] bg-[var(--material-floating)] px-3 py-1.5 shadow-[inset_0_1px_0_0_var(--edge-highlight-soft)]">
                  <CardContent className="px-0">
                    <Markdown>{g.text}</Markdown>
                  </CardContent>
                </Card>
              </MessageContextMenu>
            ),
          )}
        </div>
      );
    case "tool_call":
      return (
        <div className="max-w-[96%]">
          <ToolCallCard entry={entry} />
        </div>
      );
    case "completed_plan": {
      const allCompleted = entry.allCompleted !== false;
      return (
        <div className="max-w-[96%] rounded-[calc(var(--radius-md)+2px)] border border-[color:var(--hairline-soft)] bg-[var(--material-floating)] px-2.5 py-1.5 shadow-[inset_0_1px_0_0_var(--edge-highlight-soft)]">
          <div className="flex items-center gap-2 text-xs text-[var(--text-secondary)] mb-1">
            <ListChecks size={14} />
            <span>{allCompleted ? "Completed Plan" : "Plan Snapshot"} — {entry.entries.length} steps</span>
          </div>
          <ul className="text-xs space-y-1 text-[var(--text-primary)]">
            {entry.entries.map((e, i) => (
              <li
                key={i}
                className={e.status === "completed" ? "opacity-70 line-through" : e.status === "in_progress" ? "text-[var(--accent)]" : ""}
              >
                {e.content}
              </li>
            ))}
          </ul>
        </div>
      );
    }
    case "plan_approval":
      return (
        <div className="max-w-[96%]">
          <PlanApprovalCard entry={entry} />
        </div>
      );
    case "ask_question":
      return (
        <div className="max-w-[96%]">
          <AskQuestionCard entry={entry} />
        </div>
      );
  }
});
