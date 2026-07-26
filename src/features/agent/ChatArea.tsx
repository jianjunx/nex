import { ThreadView } from "./thread/ThreadView";
import { AgentComposer } from "./AgentComposer";
import { PermissionModal } from "./PermissionModal";

export function ChatArea() {
  return (
    <div className="flex flex-col h-full">
      <ThreadView />
      <AgentComposer />
      <PermissionModal />
    </div>
  );
}
