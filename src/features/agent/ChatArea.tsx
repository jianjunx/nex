import { ThreadView } from "./thread/ThreadView";
import { AgentComposer } from "./AgentComposer";
import { PermissionModal } from "./PermissionModal";
import { PlanApprovalModal } from "./PlanApprovalModal";
import { AskQuestionModal } from "./AskQuestionModal";

export function ChatArea() {
  return (
    <div className="flex flex-col h-full min-h-0" data-conversation-area>
      <ThreadView />
      <AgentComposer />
      <PermissionModal />
      <PlanApprovalModal />
      <AskQuestionModal />
    </div>
  );
}
