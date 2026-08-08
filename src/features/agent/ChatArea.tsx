import { ThreadView } from "./thread/ThreadView";
import { AgentComposer } from "./AgentComposer";
import { PermissionModal } from "./PermissionModal";
import { AskQuestionModal } from "./AskQuestionModal";
import { useAgentStore } from "../../stores/agent.store";

export function ChatArea() {
  const pendingPermission = useAgentStore((s) => s.pendingPermission);

  // Plan approval is an in-thread card; only Permission / Ask stay as modals.
  return (
    <div className="flex flex-col h-full min-h-0" data-conversation-area>
      <ThreadView />
      <AgentComposer />
      <PermissionModal />
      {!pendingPermission && <AskQuestionModal />}
    </div>
  );
}
