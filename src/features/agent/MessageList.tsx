import ReactMarkdown from "react-markdown";
import { Wrench } from "lucide-react";
import { useConversationStore } from "../../stores/conversation.store";

export function MessageList() {
  const activeTabId = useConversationStore((s) => s.activeTabId);
  const messagesByConversation = useConversationStore((s) => s.messagesByConversation);
  const messages = activeTabId ? (messagesByConversation[activeTabId] || []) : [];

  return (
    <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
      {messages.length === 0 && (
        <div className="flex items-center justify-center h-full text-[var(--text-tertiary)] text-sm">
          Start a conversation
        </div>
      )}
      {messages.map((msg) =>
        msg.tool_summary ? (
          <div key={msg.id} className="flex justify-start">
            <div className="flex items-center gap-2 rounded-[var(--radius-sm)] px-3 py-1.5 text-xs text-[var(--text-tertiary)] bg-[var(--overlay-soft)] border border-[color:var(--border-subtle)]">
              <Wrench size={12} />
              <span className="font-mono">{msg.tool_summary}</span>
            </div>
          </div>
        ) : (
          <div key={msg.id} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
            <div className={`max-w-[80%] rounded-[var(--radius-md)] px-4 py-2 text-sm ${
              msg.role === "user"
                ? "bg-[var(--accent)]/20 text-[var(--text-primary)]"
                : "bg-[var(--glass-interactive-bg)] text-[var(--text-primary)]"
            }`}>
              {msg.role === "assistant" ? (
                <div className="[&_pre]:overflow-x-auto [&_code]:text-[0.85em] [&_p]:my-1">
                  <ReactMarkdown>{msg.content}</ReactMarkdown>
                </div>
              ) : (
                <p className="whitespace-pre-wrap">{msg.content}</p>
              )}
            </div>
          </div>
        )
      )}
    </div>
  );
}
