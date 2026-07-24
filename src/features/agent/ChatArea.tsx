import { MessageList } from "./MessageList";
import { ChatInput } from "./ChatInput";
import { PermissionModal } from "./PermissionModal";

export function ChatArea() {
  return (
    <div className="flex flex-col h-full">
      <MessageList />
      <ChatInput />
      <PermissionModal />
    </div>
  );
}
