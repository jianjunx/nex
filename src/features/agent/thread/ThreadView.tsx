import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import ReactMarkdown from "react-markdown";
import { ListChecks } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { useAgentStore } from "../../../stores/agent.store";
import { useProjectStore } from "../../../stores/project.store";
import { selectProjectActiveTabId, useConversationStore } from "../../../stores/conversation.store";
import { ThinkingBlock } from "./ThinkingBlock";
import { ToolCallCard } from "./ToolCallCard";
import type { AssistantChunk, ThreadEntry } from "./types";

/** 距底部小于此阈值视为「仍在底部」，恢复自动跟随。 */
const NEAR_BOTTOM_PX = 80;

function lastUserMessageId(entries: ThreadEntry[]): string | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].kind === "user_message") return entries[i].id;
  }
  return null;
}

export function ThreadView() {
  const activeProjectId = useProjectStore((s) => s.activeProjectId);
  const activeTabId = useConversationStore((s) => selectProjectActiveTabId(s, activeProjectId));
  const entriesByConversation = useAgentStore((s) => s.entriesByConversation);
  const entries = activeTabId ? (entriesByConversation[activeTabId] ?? []) : [];

  const scrollerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const lastUserMsgIdRef = useRef<string | null>(null);

  const scrollToBottom = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, []);

  const onScroll = () => {
    const el = scrollerRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottomRef.current = distance <= NEAR_BOTTOM_PX;
  };

  // 切换对话：回到底部并开启跟随。
  useLayoutEffect(() => {
    stickToBottomRef.current = true;
    lastUserMsgIdRef.current = lastUserMessageId(entries);
    scrollToBottom();
    // 仅在切 tab 时重置；entries 内容变化由下方 effect / ResizeObserver 处理
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTabId, scrollToBottom]);

  // 用户发送新消息：强制贴底并跟随后续 AI 流式更新。
  useLayoutEffect(() => {
    const userId = lastUserMessageId(entries);
    if (userId && userId !== lastUserMsgIdRef.current) {
      lastUserMsgIdRef.current = userId;
      stickToBottomRef.current = true;
      scrollToBottom();
      return;
    }
    if (stickToBottomRef.current) scrollToBottom();
  }, [entries, scrollToBottom]);

  // 流式内容增高时，若仍处于跟随态则继续贴底。
  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    const ro = new ResizeObserver(() => {
      if (stickToBottomRef.current) scrollToBottom();
    });
    ro.observe(content);
    return () => ro.disconnect();
  }, [scrollToBottom]);

  return (
    <div
      ref={scrollerRef}
      onScroll={onScroll}
      className="flex-1 min-h-0 overflow-y-auto px-6 py-4"
    >
      <div ref={contentRef} className="space-y-4">
        {entries.length === 0 && (
          <div className="flex items-center justify-center h-full text-[var(--text-tertiary)] text-sm">
            Start a conversation
          </div>
        )}
        {entries.map((entry) => (
          <EntryView key={entry.id} entry={entry} />
        ))}
      </div>
    </div>
  );
}

function EntryView({ entry }: { entry: ThreadEntry }) {
  switch (entry.kind) {
    case "user_message":
      return (
        <div className="flex justify-end">
          <Card
            className="max-w-[80%] gap-0 px-4 py-2 text-sm shadow-none bg-[var(--accent)]/15 border-[color:var(--accent)]/25"
          >
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
        </div>
      );
    case "assistant_message":
      return (
        <div className="flex flex-col gap-2 max-w-[90%]">
          {groupChunks(entry.chunks).map((g, i) =>
            g.type === "thought" ? (
              <ThinkingBlock key={i} text={g.text} />
            ) : (
              <Card key={i} className="gap-0 px-4 py-2 text-sm shadow-none bg-[var(--glass-2-surface)] border-[color:var(--border-subtle)]">
                <CardContent className="px-0">
                  <div className="[&_pre]:overflow-x-auto [&_code]:text-[0.85em] [&_p]:my-1">
                    <ReactMarkdown>{g.text}</ReactMarkdown>
                  </div>
                </CardContent>
              </Card>
            ),
          )}
        </div>
      );
    case "tool_call":
      return (
        <div className="max-w-[90%]">
          <ToolCallCard entry={entry} />
        </div>
      );
    case "completed_plan":
      return (
        <div className="max-w-[90%] rounded-[var(--radius-md)] border border-[color:var(--border-subtle)] bg-[var(--glass-2-surface)] px-3 py-2">
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
}

function groupChunks(chunks: AssistantChunk[]): AssistantChunk[] {
  const out: AssistantChunk[] = [];
  for (const c of chunks) {
    const last = out[out.length - 1];
    if (last && last.type === c.type) last.text += c.text;
    else out.push({ ...c });
  }
  return out;
}
