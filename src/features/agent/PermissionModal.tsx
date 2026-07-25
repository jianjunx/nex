import { GlassButton, GlassModal } from "../../ui";
import { useAgentStore } from "../../stores/agent.store";
import { useConversationStore } from "../../stores/conversation.store";

export function PermissionModal() {
  const pendingPermission = useAgentStore((s) => s.pendingPermission);
  const respondPermission = useAgentStore((s) => s.respondPermission);
  const sessions = useAgentStore((s) => s.sessions);
  const conversationsByProject = useConversationStore((s) => s.conversationsByProject);

  if (!pendingPermission) return null;

  const dismiss = () => void respondPermission(pendingPermission.requestId, null);

  const session = Object.values(sessions).find((ss) => ss.sessionId === pendingPermission.sessionId);
  const conversation = session
    ? Object.values(conversationsByProject).flat().find((c) => c.id === session.conversationId)
    : undefined;
  const conversationLabel = conversation?.title ?? session?.conversationId ?? null;

  return (
    <GlassModal open={true} onClose={dismiss} title="Permission Required">
      <div className="mb-4">
        <p className="text-sm text-[var(--text-secondary)]">
          The agent is requesting permission:
        </p>
        {conversationLabel && (
          <p className="text-xs text-[var(--text-tertiary)] mt-1">Conversation: {conversationLabel}</p>
        )}
      </div>
      <div className="space-y-2">
        {pendingPermission.options.map((opt) => (
          <GlassButton
            key={opt.optionId}
            variant="default"
            className="w-full justify-start"
            onClick={() => void respondPermission(pendingPermission.requestId, opt.optionId)}
          >
            {opt.label}
          </GlassButton>
        ))}
        <GlassButton variant="ghost" className="w-full" onClick={dismiss}>
          Deny
        </GlassButton>
      </div>
    </GlassModal>
  );
}
