import { useConversationStore } from "../../stores/conversation.store";
import { useAgentStore } from "../../stores/agent.store";
import { messagesToThreadEntries } from "../agent/thread/messagesToThreadEntries";
import { conversationGetThreadEntries, type ThreadEntryPayloadDto } from "../../bridge/tauri";
import type { ThreadEntry } from "../agent/thread/types";

/** Load, validate, and hydrate conversation tabs for a project (startup / switch). */
export async function restoreProjectConversationTabs(projectId: string) {
  const convStore = useConversationStore.getState();
  const convs = await convStore.loadConversations(projectId);
  // List failure must not overwrite persisted tabs with empty validIds.
  if (convs === null) return;

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

  const restored = useConversationStore.getState().tabsByProject[projectId] ?? [];

  // Prefer full thread entries (thought/tool_call/etc). Fall back to legacy
  // user/assistant message table for older conversations.
  const threadEntriesPayloads: ThreadEntryPayloadDto[][] = await Promise.all(
    restored.map(async (tabId) => {
      try {
        return await conversationGetThreadEntries(tabId);
      } catch {
        return [];
      }
    }),
  );

  const agentStore = useAgentStore.getState();
  const emptyTabIds: string[] = [];

  for (let i = 0; i < restored.length; i++) {
    const tabId = restored[i]!;
    const payloads = threadEntriesPayloads[i] ?? [];
    if (payloads.length > 0) {
      // payload is the full ThreadEntry object serialized from the client.
      const entries = payloads.map((p) => p.payload as ThreadEntry);
      agentStore.hydrateEntries(tabId, entries);
    } else {
      emptyTabIds.push(tabId);
    }
  }

  if (emptyTabIds.length > 0) {
    await Promise.all(emptyTabIds.map((tabId) => convStore.loadMessages(tabId)));
    const messagesByConversation = useConversationStore.getState().messagesByConversation;
    for (const tabId of emptyTabIds) {
      const msgs = messagesByConversation[tabId] ?? [];
      agentStore.hydrateEntries(tabId, messagesToThreadEntries(msgs));
    }
  }
}
