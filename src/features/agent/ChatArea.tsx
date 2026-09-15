import AgentUiChatComposer from "@/components/agent-ui/beautiful-ui/ChatComposer";
import { ThreadView } from "./thread/ThreadView";
import { AgentComposer } from "./AgentComposer";
import { PermissionModal } from "./PermissionModal";
import { ConversationTerminal } from "../terminal/ConversationTerminal";
export function ChatArea() {
  return (
    <AgentUiChatComposer>
      <div className="flex h-full min-h-0 flex-col" data-conversation-area>
        <ThreadView />
        <AgentComposer />
        <ConversationTerminal />
        <PermissionModal />
      </div>
    </AgentUiChatComposer>
  );
}
