import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAgentStore } from "../../stores/agent.store";

interface ComposerStatusNoticeProps {
  conversationId: string | null;
  isStarting: boolean;
}

/** Connection state and a dismissible error for one Composer conversation. */
export function ComposerStatusNotice({
  conversationId,
  isStarting,
}: ComposerStatusNoticeProps) {
  const errorsByConversation = useAgentStore((s) => s.errorsByConversation);
  const clearErrorForConversation = useAgentStore((s) => s.clearErrorForConversation);
  const error = conversationId ? (errorsByConversation[conversationId] ?? null) : null;

  if (!isStarting && !error) return null;

  return (
    <div className="mb-2 px-1 text-xs">
      {isStarting && <p className="text-[var(--text-tertiary)]">正在连接服务…</p>}
      {error && (
        <div role="alert" className="flex items-start gap-1 text-[var(--error)]">
          <p className="min-w-0 flex-1 whitespace-pre-wrap">{error}</p>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="关闭错误提示"
            title="关闭错误提示"
            onClick={() => conversationId && clearErrorForConversation(conversationId)}
            className="nex-interactive-chrome -mt-0.5 -mr-1 shrink-0 rounded-[var(--radius-sm)] text-[var(--error)] hover:bg-[color:color-mix(in_srgb,var(--error)_12%,transparent)] hover:text-[var(--error)]"
          >
            <X size={13} />
          </Button>
        </div>
      )}
    </div>
  );
}
