import { useConversationStore } from "../../stores/conversation.store";
import { useAgentStore } from "../../stores/agent.store";
import { messagesToThreadEntries } from "../agent/thread/messagesToThreadEntries";
import { conversationGetThreadEntries, type ThreadEntryPayloadDto } from "../../bridge/tauri";
import type { ThreadEntry } from "../agent/thread/types";

/** Bumped on every restore call so stale async work can bail out. */
let restoreGeneration = 0;

async function hydrateTab(tabId: string, isCurrent: () => boolean): Promise<void> {
  const agentStore = useAgentStore.getState();
  let payloads: ThreadEntryPayloadDto[] = [];
  try {
    payloads = await conversationGetThreadEntries(tabId);
  } catch {
    payloads = [];
  }
  if (!isCurrent()) return;
  if (payloads.length > 0) {
    const entries = payloads.map((p) => p.payload as ThreadEntry);
    agentStore.hydrateEntries(tabId, entries);
    return;
  }
  const convStore = useConversationStore.getState();
  const msgs = await convStore.loadMessages(tabId);
  // null = load failed/aborted — hydrating with [] would blank the thread.
  if (msgs === null || !isCurrent()) return;
  agentStore.hydrateEntries(tabId, messagesToThreadEntries(msgs));
}

function scheduleIdle(cb: () => void): void {
  const ric = (globalThis as unknown as { requestIdleCallback?: (fn: () => void) => number })
    .requestIdleCallback;
  if (typeof ric === "function") {
    ric(cb);
  } else {
    setTimeout(cb, 32);
  }
}

/**
 * Load, validate, and hydrate conversation tabs for a project (startup / switch).
 * Resolves once the active tab is hydrated. Remaining tabs load in idle batches
 * and abort if a newer restore (generation) has started.
 */
export async function restoreProjectConversationTabs(projectId: string): Promise<number> {
  const gen = ++restoreGeneration;
  const convStore = useConversationStore.getState();
  const convs = await convStore.loadConversations(projectId);
  if (gen !== restoreGeneration) return gen;
  // List failure must not overwrite persisted tabs with empty validIds.
  if (convs === null) return gen;

  const validIds = new Set(convs.map((c) => c.id));

  const legacy = useConversationStore.getState().legacyTabsMigration;
  if (legacy) {
    const existing = useConversationStore.getState().tabsByProject[projectId] ?? [];
    if (existing.length === 0) {
      convStore.restoreTabs(projectId, legacy.tabs, legacy.activeId, validIds);
    }
    convStore.clearLegacyTabsMigration();
  } else {
    const tabs = useConversationStore.getState().tabsByProject[projectId] ?? [];
    const active = useConversationStore.getState().activeTabByProject[projectId] ?? null;
    convStore.restoreTabs(projectId, tabs, active, validIds);
  }

  if (gen !== restoreGeneration) return gen;

  const restored = useConversationStore.getState().tabsByProject[projectId] ?? [];
  const activeId = useConversationStore.getState().activeTabByProject[projectId] ?? null;

  // Active tab first for snappy switch, then idle-hydrate the rest.
  const ordered = activeId
    ? [activeId, ...restored.filter((id) => id !== activeId)]
    : restored;

  if (ordered.length === 0) return gen;

  const [first, ...rest] = ordered;
  if (first) {
    await hydrateTab(first, () => gen === restoreGeneration);
    if (gen !== restoreGeneration) return gen;
  }

  if (rest.length > 0) void hydrateRemainingTabs(gen, rest);
  return gen;
}

/**
 * 立刻 hydrate 一个会话页签。
 *
 * `restoreProjectConversationTabs` 现在只保证活动页签 hydrate 完就返回，其余
 * 页签走惰性队列。用户直接点某个会话行时，那个页签可能还没排到——不先 hydrate
 * 就切过去会看到一段空白线程。调用方应只在"这个页签还没有条目"时调用，避免
 * 无谓的 IPC。
 */
export async function hydrateConversationTab(tabId: string): Promise<void> {
  // 用户的点击就是最新意图，不做代次守卫；真被更新的恢复覆盖也有 restoreTabs
  // 的兜底（重新激活该项目会再 hydrate 一遍）。
  await hydrateTab(tabId, () => true);
}

/** Idle-hydrate tabs the user is not looking at. Never blocks the switch. */
function hydrateRemainingTabs(gen: number, rest: string[]): void {
  let i = 0;
  const step = () => {
    if (gen !== restoreGeneration) return;
    const batch = rest.slice(i, i + 2);
    i += batch.length;
    void Promise.all(batch.map((id) => hydrateTab(id, () => gen === restoreGeneration)))
      .then(() => {
        if (gen !== restoreGeneration || i >= rest.length) return;
        scheduleIdle(step);
      })
      .catch((err) => {
        // 单个批次失败不该掐掉整条链，也别变成 unhandled rejection。
        console.warn("[restoreTabs] idle hydrate batch failed:", err);
      });
  };
  scheduleIdle(step);
}
