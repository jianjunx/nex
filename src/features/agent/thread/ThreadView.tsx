import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { Loader2 } from "lucide-react";
import { useAgentStore } from "../../../stores/agent.store";
import { useProjectStore } from "../../../stores/project.store";
import { selectProjectActiveTabId, useConversationStore } from "../../../stores/conversation.store";
import { EntryView } from "./EntryView";
import { ToolCallGroup } from "./ToolCallCard";
import { groupThreadEntries } from "./groupThreadEntries";
import type { ThreadEntry } from "./types";

/** 距底部小于此阈值视为「仍在底部」，恢复自动跟随。 */
const NEAR_BOTTOM_PX = 80;

/** 稳定空数组,避免 useSyncExternalStore 因内联 [] 每次新引用而抖动。 */
const EMPTY_ENTRIES: ThreadEntry[] = [];

function lastUserMessageId(entries: ThreadEntry[]): string | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].kind === "user_message") return entries[i].id;
  }
  return null;
}

/**
 * Show a thread-level waiting indicator while the agent is busy but has not
 * yet produced the next visible turn item (message / thought / in-flight tool).
 */
function shouldShowAgentLoading(
  status: "starting" | "idle" | "running" | "waiting" | undefined,
  entries: ThreadEntry[],
): boolean {
  if (status !== "running" && status !== "starting") return false;
  if (entries.length === 0) return false;
  const last = entries[entries.length - 1];
  if (last.kind === "user_message" || last.kind === "completed_plan") return true;
  if (last.kind === "tool_call") {
    // Tool card already animates in-flight / permission states.
    return last.status === "completed" || last.status === "failed";
  }
  return false;
}

export function ThreadView() {
  const activeProjectId = useProjectStore((s) => s.activeProjectId);
  const activeTabId = useConversationStore((s) => selectProjectActiveTabId(s, activeProjectId));
  const entries = useAgentStore((s) =>
    activeTabId ? (s.entriesByConversation[activeTabId] ?? EMPTY_ENTRIES) : EMPTY_ENTRIES,
  );
  const sessionStatus = useAgentStore((s) =>
    activeTabId ? s.sessions[activeTabId]?.status : undefined,
  );
  const showLoading = shouldShowAgentLoading(sessionStatus, entries);
  const renderItems = useMemo(() => groupThreadEntries(entries), [entries]);
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
  }, [entries, showLoading, scrollToBottom]);

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
      className="flex-1 min-h-0 overflow-y-auto px-4 py-3"
    >
      <div ref={contentRef} className="space-y-3">
        {entries.length === 0 && (
          <div className="flex items-center justify-center h-full text-[var(--text-tertiary)] text-sm">
            Start a conversation
          </div>
        )}
        {renderItems.map((item) =>
          item.type === "tool_group" ? (
            <ToolCallGroup key={item.key} entries={item.entries} />
          ) : (
            <EntryView key={item.entry.id} entry={item.entry} />
          ),
        )}
        {showLoading && <AgentLoadingIndicator />}
      </div>
    </div>
  );
}

function AgentLoadingIndicator() {
  return (
    <div
      className="flex items-center gap-2 max-w-[96%] text-sm text-[var(--text-tertiary)]"
      role="status"
      aria-live="polite"
    >
      <Loader2 size={14} className="animate-spin text-[var(--accent)] shrink-0" />
      <span>正在思考…</span>
    </div>
  );
}

