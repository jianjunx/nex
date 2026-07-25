import { useState, useRef, useEffect, useCallback, type KeyboardEvent } from "react";
import { Send, Square } from "lucide-react";
import { GlassButton } from "../../ui";
import { useAgentStore } from "../../stores/agent.store";
import { useConversationStore } from "../../stores/conversation.store";
import type { Message } from "../../bridge/tauri";

// Min ~5 visible lines, max before scrolling kicks in (text-sm ~21px line-height).
const MIN_HEIGHT = 105;
const MAX_HEIGHT = 320;

export function ChatInput() {
  const [text, setText] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const activeTabId = useConversationStore((s) => s.activeTabId);
  const sessions = useAgentStore((s) => s.sessions);
  const sendPrompt = useAgentStore((s) => s.sendPrompt);
  const cancel = useAgentStore((s) => s.cancel);

  const session = activeTabId ? sessions[activeTabId] : null;
  const isRunning = session?.status === "running";

  // Auto-resize: reset to content height, clamped to [MIN, MAX]. Called on
  // every keystroke so the box grows with the text instead of scrolling.
  const adjustHeight = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(Math.max(el.scrollHeight, MIN_HEIGHT), MAX_HEIGHT)}px`;
  }, []);

  // Set the min height on mount so the box is tall even before any input.
  useEffect(() => {
    adjustHeight();
  }, [adjustHeight]);

  const handleSend = async () => {
    if (!text.trim() || !session || !activeTabId) return;
    const content = text;
    setText("");
    // Reset to min height after clearing.
    requestAnimationFrame(adjustHeight);

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
    <div className="px-5 py-3 border-t border-[color:var(--border-subtle)]">
      <div className="flex items-end gap-2 rounded-[var(--radius-lg)] bg-[var(--glass-interactive-bg)] border border-[color:var(--border-strong)] px-4 py-2">
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => { setText(e.target.value); adjustHeight(); }}
          onKeyDown={handleKeyDown}
          placeholder={session ? "Send a message..." : "Start an agent session to chat"}
          className="flex-1 bg-transparent text-sm leading-[21px] text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] outline-none resize-none overflow-y-auto"
          style={{ minHeight: MIN_HEIGHT, maxHeight: MAX_HEIGHT }}
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
