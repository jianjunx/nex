import { useAgentStore } from "@/stores/agent.store";
import { useConversationStore } from "@/stores/conversation.store";

export function projectHasActiveConversation(projectId: string): boolean {
  const conversations = useConversationStore.getState().conversationsByProject[projectId] ?? [];
  const { sessions, pendingMessagesByConversation } = useAgentStore.getState();
  return conversations.some(({ id }) => {
    const session = sessions[id];
    return (session !== undefined && (session.status !== "idle" || session.reclaiming === true))
      || (pendingMessagesByConversation[id]?.length ?? 0) > 0;
  });
}
