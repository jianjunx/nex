import { useCallback } from "react";
import { useAgentStore } from "../../stores/agent.store";
import { useErrorToast } from "@/hooks/useErrorToast";

interface ComposerStatusNoticeProps {
  conversationId: string | null;
  isStarting: boolean;
}

/** Connection state; failures use the shared message popup. */
export function ComposerStatusNotice({
  conversationId,
  isStarting,
}: ComposerStatusNoticeProps) {
  const error = useAgentStore((s) => conversationId ? (s.errorsByConversation[conversationId] ?? null) : null);
  const clearErrorForConversation = useAgentStore((s) => s.clearErrorForConversation);
  const clearError = useCallback(() => {
    if (conversationId) clearErrorForConversation(conversationId);
  }, [conversationId, clearErrorForConversation]);
  useErrorToast(error, "智能体操作失败", clearError);

  if (!isStarting) return null;
  return (
    <div className="mb-2 px-1 text-xs">
      <p className="text-[var(--text-tertiary)]">正在连接服务…</p>
    </div>
  );
}
