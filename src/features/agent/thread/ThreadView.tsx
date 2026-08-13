import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual";
import { Loader2 } from "lucide-react";
import { useAgentStore } from "../../../stores/agent.store";
import { useProjectStore } from "../../../stores/project.store";
import { selectProjectActiveTabId, useConversationStore } from "../../../stores/conversation.store";
import { EntryView } from "./EntryView";
import { ToolCallGroup } from "./ToolCallCard";
import { FilesChangedCard } from "./FilesChangedCard";
import { groupThreadEntries, type ThreadRenderItem } from "./groupThreadEntries";
import {
  pickStickyUserMessage,
  type StickyUserMessage,
  type UserStickyCandidate,
} from "./stickyUserMessage";
import type { ThreadEntry } from "./types";

const EMPTY_ENTRIES: ThreadEntry[] = [];
const EMPTY_EXPANDED = new Set<string>();

/** 距底部小于此阈值视为「仍在底部」,恢复自动跟随。 */
const NEAR_BOTTOM_PX = 80;

/**
 * 行级实测高缓存(模块级,随会话累积;每行仅一个 number,量级极小)。
 * 键为 rowKey,不含会话 id:跨会话同 id 碰撞仅影响估值精度,measureElement 实测即自纠(接受)。
 * 作用:已见过但被虚拟化卸载、再次滚回的行不再用固定估值定位,直接复现真实高度,
 * 消除「估值→实测纠正」引起的 totalSize/位置突变(抖动)。
 */
const measuredHeights = new Map<string, number>();

/** 行高估值:只影响滚动条精度,measureElement 实测持续校正。 */
function estimateRowHeight(item: ThreadRenderItem | undefined): number {
  if (!item) return 40; // 加载指示器行
  if (item.type === "tool_group") return 40;
  if (item.type === "files_changed") return 44 + item.files.length * 28;
  const e = item.entry;
  if (e.kind === "user_message") return 48;
  if (e.kind === "tool_call") {
    return e.status === "waiting_for_confirmation" ? 96 : 48;
  }
  if (e.kind === "plan_approval") return 220;
  // 120: 贴近含代码块/表格/Mermaid 的助手消息实测高度（多在 80~500px）。
  // 上调首帧估值以减小「首次上滚未见行」的首滚 delta；measureElement
  // 仍持续校正（流式消息尾行常大幅超出，依赖实时测量）。
  return 120;
}

function rowKey(item: ThreadRenderItem | undefined): string {
  if (!item) return "agent-loading";
  if (item.type === "tool_group") return `g:${item.key}`;
  if (item.type === "files_changed") return `fc:${item.key}`;
  return item.entry.id;
}

function lastUserMessageId(entries: ThreadEntry[]): string | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].kind === "user_message") return entries[i].id;
  }
  return null;
}

function collectUserStickyCandidates(items: ThreadRenderItem[]): UserStickyCandidate[] {
  const out: UserStickyCandidate[] = [];
  let y = 0;
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const h = measuredHeights.get(rowKey(item)) ?? estimateRowHeight(item);
    if (item.type === "entry" && item.entry.kind === "user_message") {
      out.push({ index: i, id: item.entry.id, start: y, height: h });
    }
    y += h;
  }
  return out;
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
  if (last.kind === "plan_approval") {
    // Pending card has its own CTA; after accept the agent should resume.
    return last.status === "accepted";
  }
  if (last.kind === "tool_call") {
    // Tool card already animates in-flight / permission states.
    return last.status === "completed" || last.status === "failed";
  }
  return false;
}

function followThreadEnd(
  virtualizer: { getTotalSize: () => number; scrollToIndex: (index: number, opts: { align: "end" }) => void },
  scroller: HTMLDivElement | null,
  itemCount: number,
) {
  if (itemCount <= 0) return;
  const viewport = scroller?.clientHeight ?? 0;
  // 内容不足一屏:钉在顶部,不要用 padding 把消息推下去,也不要滚出空白滚动条。
  if (viewport > 0 && virtualizer.getTotalSize() <= viewport) {
    if (scroller && scroller.scrollTop !== 0) scroller.scrollTop = 0;
    return;
  }
  virtualizer.scrollToIndex(itemCount - 1, { align: "end" });
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
  const lastTurnComplete = sessionStatus !== "running" && sessionStatus !== "starting" && sessionStatus !== "waiting";
  const renderItems = useMemo(
    () => groupThreadEntries(entries, { lastTurnComplete }),
    [entries, lastTurnComplete],
  );

  const scrollerRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const lastUserMsgIdRef = useRef<string | null>(null);
  const stickyIndexRef = useRef<number | null>(null);
  const [sticky, setSticky] = useState<StickyUserMessage | null>(null);
  const [expandedUserIds, setExpandedUserIds] = useState<Set<string>>(EMPTY_EXPANDED);

  const count = renderItems.length + (showLoading ? 1 : 0);

  const virtualizer = useVirtualizer({
    count,
    getScrollElement: () => scrollerRef.current,
    getItemKey: (i) => rowKey(renderItems[i]),
    estimateSize: (i) => {
      const item = renderItems[i];
      // 命中实测缓存用真实高度,否则回退估值。
      return measuredHeights.get(rowKey(item)) ?? estimateRowHeight(item);
    },
    overscan: 5,
    rangeExtractor: (range) => {
      const indexes = defaultRangeExtractor(range);
      const pinned = stickyIndexRef.current;
      if (pinned != null && (pinned < range.startIndex || pinned > range.endIndex)) {
        return [pinned, ...indexes];
      }
      return indexes;
    },
    // 显式用 getBoundingClientRect:兼容小数高度,且是测试 mock 的确定接缝。
    // 测量后把高度写入模块级缓存:卸载再滚回的行可复现真实高度,不再估值跳变。
    measureElement: (el) => {
      const h = el.getBoundingClientRect().height;
      // 行元素为 div(HTMLElement);dataset.index 即行 div 上的 data-index。
      const item = renderItems[Number((el as HTMLElement).dataset.index)];
      const key = rowKey(item);
      if (key && h > 0) measuredHeights.set(key, h);
      return h;
    },
  });

  const totalSize = virtualizer.getTotalSize();
  const virtualItems = virtualizer.getVirtualItems();

  const syncSticky = useCallback(
    (scrollTop: number) => {
      const next = pickStickyUserMessage(collectUserStickyCandidates(renderItems), scrollTop);
      stickyIndexRef.current = next?.index ?? null;
      setSticky((prev) => {
        if (prev?.id === next?.id && prev?.translateY === next?.translateY && prev?.index === next?.index) {
          return prev;
        }
        return next;
      });
    },
    [renderItems],
  );

  const onScroll = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottomRef.current = distance <= NEAR_BOTTOM_PX;
    syncSticky(el.scrollTop);
  }, [syncSticky]);

  const toggleUserExpand = useCallback((id: string) => {
    setExpandedUserIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // 跟随态下:条目数/总高度变化(含流式撑高末尾条目)→ 贴底。
  useLayoutEffect(() => {
    if (stickToBottomRef.current) {
      followThreadEnd(virtualizer, scrollerRef.current, count);
    }
    syncSticky(scrollerRef.current?.scrollTop ?? 0);
  }, [count, totalSize, virtualizer, syncSticky]);

  // 用户发送新消息:强制恢复跟随,并在本 effect 内同步回底。
  // 不能只置 stickToBottomRef 再等上方 follow effect:同一提交里 follow effect 先跑
  // (此刻 stick 仍 false → 不滚),本 effect 才置 true;若此后无流式追加,count/totalSize
  // 不再变化 → follow effect 不再触发 → 永不回底。故此处直接 scrollToIndex。
  // count/virtualizer 取自本渲染闭包,无需进 deps(deps 仍为 [entries] 以检测新 user id)。
  useLayoutEffect(() => {
    const userId = lastUserMessageId(entries);
    if (userId && userId !== lastUserMsgIdRef.current) {
      lastUserMsgIdRef.current = userId;
      stickToBottomRef.current = true;
      followThreadEnd(virtualizer, scrollerRef.current, count);
      syncSticky(scrollerRef.current?.scrollTop ?? 0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries]);

  // 切换对话:清行高缓存、恢复跟随并滚到底(两个会话 count 可能相同,不能只靠 count 依赖)。
  useLayoutEffect(() => {
    measuredHeights.clear();
    virtualizer.measure();
    stickToBottomRef.current = true;
    lastUserMsgIdRef.current = lastUserMessageId(entries);
    setExpandedUserIds(EMPTY_EXPANDED);
    setSticky(null);
    stickyIndexRef.current = null;
    followThreadEnd(virtualizer, scrollerRef.current, count);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTabId]);

  const stickyEntry = useMemo(() => {
    if (!sticky) return null;
    const item = renderItems[sticky.index];
    if (item?.type === "entry" && item.entry.kind === "user_message") return item.entry;
    return null;
  }, [sticky, renderItems]);

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scrollerRef}
        onScroll={onScroll}
        className="min-h-0 flex-1 overflow-y-auto px-4 py-3"
      >
        {entries.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-1.5 px-6 text-center">
            <p className="text-sm text-[var(--text-secondary)]">工作台已就绪</p>
            <p className="text-xs text-[var(--text-tertiary)]">
              描述任务，<span className="font-mono text-[var(--text-secondary)]">@</span> 引用文件，
              <span className="font-mono text-[var(--text-secondary)]">/</span> 使用命令
            </p>
          </div>
        ) : (
          <div style={{ height: totalSize, position: "relative" }}>
            {virtualItems.map((vi) => {
              const item = renderItems[vi.index];
              const isPinnedOriginal = sticky != null && sticky.id === rowKey(item);
              return (
                <div
                  key={rowKey(item)}
                  data-index={vi.index}
                  ref={virtualizer.measureElement}
                  className={`pb-3${isPinnedOriginal ? " invisible" : ""}`}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    transform: `translateY(${vi.start}px)`,
                  }}
                >
                  {item ? (
                    item.type === "tool_group" ? (
                      <ToolCallGroup entries={item.entries} />
                    ) : item.type === "files_changed" ? (
                      <FilesChangedCard files={item.files} />
                    ) : (
                      <EntryView
                        entry={item.entry}
                        userExpanded={expandedUserIds.has(item.entry.id)}
                        onToggleUserExpand={toggleUserExpand}
                      />
                    )
                  ) : (
                    <AgentLoadingIndicator />
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
      {stickyEntry && sticky && (
        <div
          data-sticky-user-message={stickyEntry.id}
          className="pointer-events-none absolute inset-x-0 top-0 z-20 px-4 pt-3"
          style={{ transform: `translateY(${sticky.translateY}px)` }}
        >
          <div className="pointer-events-auto">
            <EntryView
              entry={stickyEntry}
              userExpanded={expandedUserIds.has(stickyEntry.id)}
              onToggleUserExpand={toggleUserExpand}
              floating
            />
          </div>
        </div>
      )}
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
