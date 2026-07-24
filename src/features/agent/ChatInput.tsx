import { useState, useRef, type KeyboardEvent } from "react";
import { Send, Square } from "lucide-react";
import { GlassButton } from "../../ui";
import { useAgentStore } from "../../stores/agent.store";
import { useConversationStore } from "../../stores/conversation.store";
import type { Message } from "../../bridge/tauri";

export function ChatInput() {
  const [text, setText] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const activeTabId = useConversationStore((s) => s.activeTabId);
  const sessions = useAgentStore((s) => s.sessions);
  const sendPrompt = useAgentStore((s) => s.sendPrompt);
  const cancel = useAgentStore((s) => s.cancel);

  const session = activeTabId ? sessions[activeTabId] : null;
  const isRunning = session?.status === "running";

  const handleSend = async () => {
    if (!text.trim() || !session || !activeTabId) return;
    const content = text;
    setText("");

    // Append the user message locally; assistant replies arrive via
    // `acp-notification` events handled in the agent store.
    const msg: Message = {
      id: crypto.randomUUID(),
      conversation_id: activeTabId,
      role: "user",
      content,
      tool_summary: null,
      timestamp: Date.now(),
      sequence: 0,
    };
    useConversationStore.getState().appendMessage(activeTabId, msg);

    await sendPrompt(session.sessionId, content);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  };

  return (
    <div className="px-4 py-3 border-t border-white/[0.06]">
      <div className="flex items-end gap-2 rounded-[var(--radius-lg)] bg-[var(--glass-interactive-bg)] border border-white/[0.12] px-4 py-2">
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={session ? "Send a message..." : "Start an agent session to chat"}
          rows={1}
          className="flex-1 bg-transparent text-sm text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] outline-none resize-none max-h-[200px]"
          style={{ minHeight: 24 }}
        />
        {isRunning ? (
          <GlassButton size="sm" variant="ghost" onClick={() => session && void cancel(session.sessionId)}>
            <Square size={14} className="text-[var(--error)]" />
          </GlassButton>
        ) : (
          <GlassButton size="sm" variant="accent" onClick={() => void handleSend()} disabled={!text.trim() || !session}>
            <Send size={14} />
          </GlassButton>
        )}
      </div>
    </div>
  );
}
