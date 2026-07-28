import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
    // `open` stays constant true while a request is pending; Radix emits
    // onOpenChange(false) for Esc, outside click, and the X button — all
    // route here: dismissal means deny.
    <Dialog open={true} onOpenChange={(o) => { if (!o) dismiss(); }}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Permission Required</DialogTitle>
        </DialogHeader>
        <div>
          <p className="text-sm text-[var(--text-secondary)]">
            The agent is requesting permission:
          </p>
          {conversationLabel && (
            <p className="text-xs text-[var(--text-tertiary)] mt-1">Conversation: {conversationLabel}</p>
          )}
        </div>
        <div className="space-y-2">
          {pendingPermission.options.map((opt) => (
            <Button
              key={opt.optionId}
              variant="outline"
              className="w-full justify-start"
              onClick={() => void respondPermission(pendingPermission.requestId, opt.optionId)}
            >
              {opt.label}
            </Button>
          ))}
          <Button variant="ghost" className="w-full" onClick={dismiss}>
            Deny
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
