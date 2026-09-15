import { useState } from "react";
import { useAgentStore } from "@/stores/agent.store";
import { useConversationStore } from "@/stores/conversation.store";
import { conversationUpdateAgent } from "@/bridge/tauri";
import { errorMessage } from "@/lib/errors";

export function AgentSelector({
  conversationId,
  agentType,
  onBusyChange,
}: {
  conversationId: string;
  agentType: string;
  onBusyChange: (busy: boolean) => void;
}) {
  const servers = useAgentStore((s) => s.servers);
  const entries = useAgentStore((s) => s.entriesByConversation[conversationId]);
  const queued = useAgentStore(
    (s) => s.pendingMessagesByConversation[conversationId],
  );
  const session = useAgentStore((s) => s.sessions[conversationId]);
  const messages = useConversationStore(
    (s) => s.messagesByConversation[conversationId],
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const locked =
    !!entries?.length ||
    !!messages?.length ||
    !!queued?.length ||
    session?.status === "running" ||
    session?.status === "starting";
  const options = [
    { id: "nex", name: "NexAgent" },
    ...servers.filter((s) => s.id !== "nex"),
  ];
  if (!options.some((s) => s.id === agentType))
    options.push({ id: agentType, name: agentType });
  return (
    <div className="flex min-w-0 items-center gap-1">
      <select
        aria-label="智能体"
        title={locked ? "已有对话，不能切换智能体" : "选择智能体"}
        value={agentType}
        disabled={locked || busy}
        className="max-w-36 rounded-md bg-transparent px-1 py-1 text-xs text-[var(--text-secondary)] disabled:opacity-60"
        onFocus={() => {
          if (!servers.length) void useAgentStore.getState().loadServers();
        }}
        onChange={(e) => {
          const target = e.target.value;
          setBusy(true);
          onBusyChange(true);
          setError(null);
          void (async () => {
            try {
              await conversationUpdateAgent(conversationId, target);
              await useAgentStore.getState().removeSession(conversationId);
              useConversationStore.setState((s) => {
                for (const list of Object.values(s.conversationsByProject)) {
                  const c = list.find((c) => c.id === conversationId);
                  if (c) c.agent_type = target;
                }
              });
            } catch (err) {
              setError(errorMessage(err));
            } finally {
              setBusy(false);
              onBusyChange(false);
            }
          })();
        }}
      >
        {options.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </select>
      {error && (
        <span role="alert" className="text-xs text-[var(--text-secondary)]">
          {error}
        </span>
      )}
    </div>
  );
}
