import { ThreadView } from "./thread/ThreadView";
import { AgentComposer } from "./AgentComposer";
import { PermissionModal } from "./PermissionModal";

export function ChatArea() {
  // Plan approval and ask-question are in-thread cards; only Permission stays a modal.
  return (
    <div className="flex flex-col h-full min-h-0" data-conversation-area>
      <ThreadView />
      <AgentComposer />
      <PermissionModal />
    </div>
  );
}
