import { useConversationStore } from "../../stores/conversation.store";
import { useAgentStore } from "../../stores/agent.store";
import { messagesToThreadEntries } from "../agent/thread/messagesToThreadEntries";
import { conversationGetThreadEntries, type ThreadEntryPayloadDto } from "../../bridge/tauri";
import type { ThreadEntry } from "../agent/thread/types";

/** Bumped on every restore call so stale async work can bail out. */
let restoreGeneration = 0;

export function currentRestoreGeneration(): number {
  return restoreGeneration;
}

async function hydrateTab(tabId: string): Promise<void> {
  const agentStore = useAgentStore.getState();
  let payloads: ThreadEntryPayloadDto[] = [];
  try {
    payloads = await conversationGetThreadEntries(tabId);
  } catch {
    payloads = [];
  }
  if (payloads.length > 0) {
    const entries = payloads.map((p) => p.payload as ThreadEntry);
    agentStore.hydrateEntries(tabId, entries);
    return;
  }
  const convStore = useConversationStore.getState();
  const msgs = await convStore.loadMessages(tabId);
  // null = load failed/aborted — hydrating with [] would blank the thread.
  if (msgs === null) return;
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
 * Hydrates the active tab first; remaining tabs load in idle batches and abort if
 * a newer restore (generation) has started.
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
    await hydrateTab(first);
    if (gen !== restoreGeneration) return gen;
  }

  if (rest.length === 0) return gen;

  await new Promise<void>((resolve) => {
    let i = 0;
    const step = () => {
      if (gen !== restoreGeneration) {
        resolve();
        return;
      }
      const batch = rest.slice(i, i + 2);
      i += batch.length;
      void Promise.all(batch.map((id) => hydrateTab(id))).then(() => {
        if (gen !== restoreGeneration || i >= rest.length) {
          resolve();
          return;
        }
        scheduleIdle(step);
      });
    };
    scheduleIdle(step);
  });

  return gen;
}
