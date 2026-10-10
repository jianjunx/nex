import { useAgentStore } from "@/stores/agent.store";
import { useConversationStore } from "@/stores/conversation.store";

/**
 * True once a conversation has started (thread, persisted history, queued
 * prompt or a busy turn). A session that is merely pre-initializing
 * ("starting" with nothing sent) does NOT count: the new-task bar must stay
 * usable while the agent warms up.
 */
export function useConversationLocked(conversationId: string): boolean {
  const hasEntries = useAgentStore(
    (s) => (s.entriesByConversation[conversationId]?.length ?? 0) > 0,
  );
  const hasQueued = useAgentStore(
    (s) => (s.pendingMessagesByConversation[conversationId]?.length ?? 0) > 0,
  );
  const busy = useAgentStore((s) => {
    const status = s.sessions[conversationId]?.status;
    return status === "running" || status === "waiting";
  });
  const hasMessages = useConversationStore(
    (s) => (s.messagesByConversation[conversationId]?.length ?? 0) > 0,
  );
  return hasEntries || hasQueued || busy || hasMessages;
}
