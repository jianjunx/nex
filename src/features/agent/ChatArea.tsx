import { ThreadView } from "./thread/ThreadView";
import { AgentComposer } from "./AgentComposer";
import { PermissionModal } from "./PermissionModal";
import { PlanApprovalModal } from "./PlanApprovalModal";
import { AskQuestionModal } from "./AskQuestionModal";
import { useAgentStore } from "../../stores/agent.store";

export function ChatArea() {
  const pendingPermission = useAgentStore((s) => s.pendingPermission);
  const pendingPlan = useAgentStore((s) => s.pendingPlanApproval);

  // One modal at a time: Permission > Plan > Ask (avoid stacked dialogs).
  return (
    <div className="flex flex-col h-full min-h-0" data-conversation-area>
      <ThreadView />
      <AgentComposer />
      <PermissionModal />
      {!pendingPermission && <PlanApprovalModal />}
      {!pendingPermission && !pendingPlan && <AskQuestionModal />}
    </div>
  );
}
