import { useCallback, useLayoutEffect, useMemo, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Loader2 } from "lucide-react";
import { useAgentStore } from "../../../stores/agent.store";
import { useProjectStore } from "../../../stores/project.store";
import { selectProjectActiveTabId, useConversationStore } from "../../../stores/conversation.store";
import { EntryView } from "./EntryView";
import { ToolCallGroup } from "./ToolCallCard";
import { groupThreadEntries, type ThreadRenderItem } from "./groupThreadEntries";
import { isEditTool } from "./toolCallUtils";
import type { ThreadEntry } from "./types";

const EMPTY_ENTRIES: ThreadEntry[] = [];

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
  const e = item.entry;
  // edit 卡行高估值贴近「内容区封顶 350 + 头/边距」实测(~386),首帧布局即准,减小上滚首测 delta。
  if (e.kind === "tool_call") return isEditTool(e) ? 386 : 48;
  // 64:贴近单行气泡实测(用户/助手消息行多在 40~80px),降低「首次上滚未见行」的首滚 delta。
  return 64;
}

function rowKey(item: ThreadRenderItem | undefined): string {
  if (!item) return "agent-loading";
  return item.type === "tool_group" ? `g:${item.key}` : item.entry.id;
}

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
  const stickToBottomRef = useRef(true);
  const lastUserMsgIdRef = useRef<string | null>(null);

  const count = renderItems.length + (showLoading ? 1 : 0);

  const virtualizer = useVirtualizer({
    count,
    getScrollElement: () => scrollerRef.current,
    estimateSize: (i) => {
      const item = renderItems[i];
      // 命中实测缓存用真实高度,否则回退估值。
      return measuredHeights.get(rowKey(item)) ?? estimateRowHeight(item);
    },
    overscan: 5,
    // 显式用 getBoundingClientRect:兼容小数高度,且是测试 mock 的确定接缝。
    // 测量后把高度写入模块级缓存:卸载再滚回的行可复现真实高度,不再估值跳变。
    measureElement: (el) => {
      const h = el.getBoundingClientRect().height;
      const item = renderItems[Number(el.dataset.index)];
      const key = rowKey(item);
      if (key && h > 0) measuredHeights.set(key, h);
      return h;
    },
  });

  const totalSize = virtualizer.getTotalSize();
  const virtualItems = virtualizer.getVirtualItems();

  const onScroll = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottomRef.current = distance <= NEAR_BOTTOM_PX;
  }, []);

  // 跟随态下:条目数/总高度变化(含流式撑高末尾条目)→ 贴底。
  useLayoutEffect(() => {
    if (stickToBottomRef.current && count > 0) {
      virtualizer.scrollToIndex(count - 1, { align: "end" });
    }
  }, [count, totalSize, virtualizer]);

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
      if (count > 0) virtualizer.scrollToIndex(count - 1, { align: "end" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries]);

  // 切换对话:恢复跟随并直接滚到底(两个会话 count 可能相同,不能只靠 count 依赖)。
  useLayoutEffect(() => {
    stickToBottomRef.current = true;
    lastUserMsgIdRef.current = lastUserMessageId(entries);
    if (count > 0) virtualizer.scrollToIndex(count - 1, { align: "end" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTabId]);

  return (
    <div
      ref={scrollerRef}
      onScroll={onScroll}
      className="flex-1 min-h-0 overflow-y-auto px-4 py-3"
    >
      {entries.length === 0 ? (
        <div className="flex items-center justify-center h-full text-[var(--text-tertiary)] text-sm">
          Start a conversation
        </div>
      ) : (
        <div style={{ height: totalSize, position: "relative" }}>
          {virtualItems.map((vi) => {
            const item = renderItems[vi.index];
            return (
              <div
                key={rowKey(item)}
                data-index={vi.index}
                ref={virtualizer.measureElement}
                className="pb-3"
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
                  ) : (
                    <EntryView entry={item.entry} />
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
