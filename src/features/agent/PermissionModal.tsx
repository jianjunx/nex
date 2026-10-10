import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import { useAgentStore } from "../../stores/agent.store";
import { useConversationStore } from "../../stores/conversation.store";
import { formatToolRawInput } from "./thread/applySessionUpdate";
import { PermissionApproval } from "./PermissionApproval";

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
  const title = pendingPermission.toolTitle?.trim() || "需要你的确认";
  const detail =
    formatToolRawInput(pendingPermission.toolRawInput) ??
    (typeof pendingPermission.toolContent === "string"
      ? pendingPermission.toolContent
      : null);

  return (
    <Dialog open={true} onOpenChange={(o) => { if (!o) dismiss(); }}>
      <DialogContent
        showCloseButton={false}
        className="nex-approval-dialog w-fit border-0 bg-transparent p-0 shadow-none sm:max-w-none"
      >
        <DialogTitle className="sr-only">{title}</DialogTitle>
        <PermissionApproval
          title={title}
          detail={detail ?? (pendingPermission.toolKind ? null : "智能体正在请求权限。")}
          note={
            [
              pendingPermission.toolKind,
              conversationLabel ? `会话 ${conversationLabel}` : null,
            ]
              .filter(Boolean)
              .join(" · ") || null
          }
          options={pendingPermission.options}
          onRespond={(optionId) =>
            void respondPermission(pendingPermission.requestId, optionId)
          }
        />
      </DialogContent>
    </Dialog>
  );
}
