import { useConversationStore } from "../../stores/conversation.store";

/** Load, validate, and hydrate conversation tabs for a project (startup / switch). */
export async function restoreProjectConversationTabs(projectId: string) {
  const convStore = useConversationStore.getState();
  await convStore.loadConversations(projectId);
  const convs = useConversationStore.getState().conversationsByProject[projectId] ?? [];
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
}
