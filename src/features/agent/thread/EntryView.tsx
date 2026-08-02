import { memo, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import { ListChecks } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { ThinkingBlock } from "./ThinkingBlock";
import { ToolCallCard } from "./ToolCallCard";
import { MessageContextMenu } from "./MessageContextMenu";
import { groupChunks } from "./groupChunks";
import type { ThreadEntry } from "./types";

/**
 * 单条线程条目渲染。memo 化依赖 entry 引用稳定(immer 结构共享):
 * 流式更新只改末尾 entry,历史条目不重渲染。
 */
export const EntryView = memo(function EntryView({ entry }: { entry: ThreadEntry }) {
  const groupedChunks = useMemo(
    () => (entry.kind === "assistant_message" ? groupChunks(entry.chunks) : []),
    [entry],
  );

  switch (entry.kind) {
    case "user_message":
      return (
        // max-w 必须在外层 div 上（与 assistant 一致）：放 Card 上时
        // 百分比相对「内容撑开的外层 div」而非面板，中等长度消息会在
        // 80%×自身宽度处意外折行（气泡右侧留空）。
        // ml-auto 把气泡推到面板右侧（block 子元素默认靠左）。
        <div className="ml-auto flex max-w-[80%] justify-end">
          <MessageContextMenu textContent={entry.text ?? ""}>
            <Card className="gap-0 px-3 py-1.5 text-sm shadow-none bg-[var(--accent)]/15 border-[color:var(--accent)]/25">
              <CardContent className="px-0 space-y-2">
                {entry.images && entry.images.length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {entry.images.map((img, i) => (
                      <img
                        key={i}
                        src={`data:${img.mimeType};base64,${img.data}`}
                        alt=""
                        className="max-h-48 max-w-full rounded-[var(--radius-sm)] object-contain"
                      />
                    ))}
                  </div>
                )}
                {entry.text ? <p className="whitespace-pre-wrap">{entry.text}</p> : null}
              </CardContent>
            </Card>
          </MessageContextMenu>
        </div>
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
                    <div className="[&_pre]:overflow-x-auto [&_code]:text-[0.85em] [&_p]:my-1">
                      <ReactMarkdown>{g.text}</ReactMarkdown>
                    </div>
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
  }
});
