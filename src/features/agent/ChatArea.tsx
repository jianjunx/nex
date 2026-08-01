import { ThreadView } from "./thread/ThreadView";
import { AgentComposer } from "./AgentComposer";
import { PermissionModal } from "./PermissionModal";

export function ChatArea() {
  return (
    <div className="flex flex-col h-full min-h-0">
      <ThreadView />
      <AgentComposer />
      <PermissionModal />
    </div>
  );
}
