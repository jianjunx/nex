import { memo, useMemo } from "react";
import { ListChecks } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { ThinkingBlock } from "./ThinkingBlock";
import { ToolCallCard } from "./ToolCallCard";
import { PlanApprovalCard } from "./PlanApprovalCard";
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
                <Card className="gap-0 px-3 py-1.5 text-sm shadow-none bg-[var(--glass-2-surface)] border-[color:var(--border-subtle)]">
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
    case "completed_plan":
      return (
        <div className="max-w-[96%] rounded-[var(--radius-md)] border border-[color:var(--border-subtle)] bg-[var(--glass-2-surface)] px-2.5 py-1.5">
          <div className="flex items-center gap-2 text-xs text-[var(--text-secondary)] mb-1">
            <ListChecks size={14} />
            <span>Completed Plan — {entry.entries.length} steps</span>
          </div>
          <ul className="text-xs space-y-1 text-[var(--text-primary)]">
            {entry.entries.map((e, i) => (
              <li key={i} className="opacity-70">
                {e.content}
              </li>
            ))}
          </ul>
        </div>
      );
    case "plan_approval":
      return (
        <div className="max-w-[96%]">
          <PlanApprovalCard entry={entry} />
        </div>
      );
  }
});
