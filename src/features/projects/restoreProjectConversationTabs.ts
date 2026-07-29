import { useConversationStore } from "../../stores/conversation.store";
import { useAgentStore } from "../../stores/agent.store";
import { messagesToThreadEntries } from "../agent/thread/messagesToThreadEntries";

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
  await Promise.all(restored.map((tabId) => convStore.loadMessages(tabId)));

  // ThreadView reads agent.store entries — mirror persisted messages into it.
  const agentStore = useAgentStore.getState();
  const messagesByConversation = useConversationStore.getState().messagesByConversation;
  for (const tabId of restored) {
    const msgs = messagesByConversation[tabId] ?? [];
    agentStore.hydrateEntries(tabId, messagesToThreadEntries(msgs));
  }
}
