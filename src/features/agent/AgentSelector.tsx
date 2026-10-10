import { useEffect, useState } from "react";
import { useAgentStore } from "@/stores/agent.store";
import { useConversationStore } from "@/stores/conversation.store";
import { conversationUpdateAgent } from "@/bridge/tauri";
import { errorMessage } from "@/lib/errors";
import { ComposerOptionMenu } from "./ComposerOptionMenu";
import { AgentIcon } from "./AgentIcon";
import { useConversationLocked } from "./useConversationLocked";

const REGISTRY_RETRY_MS = 30_000;
let lastRegistryAttempt = 0;

export function AgentSelector({
  conversationId,
  agentType,
  projectPath,
  bordered,
  onBusyChange,
}: {
  conversationId: string;
  agentType: string;
  /** cwd used to pre-initialize the chosen agent. */
  projectPath: string;
  bordered?: boolean;
  onBusyChange: (busy: boolean) => void;
}) {
  const servers = useAgentStore((s) => s.servers);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 1.1.19 重构后没有任何入口拉取 ACP registry；本机无缓存时列表只有 NexAgent，
  // 而 registry 又只在创建 registry 会话时才会刷新，形成死锁。这里在挂载和聚焦
  // 时补拉一次（30s 节流，失败也计时，避免自激重试）。
  const ensureExternalServers = () => {
    const st = useAgentStore.getState();
    if (st.serversLoading) return;
    if (st.servers.some((s) => s.id !== "nex")) return;
    if (Date.now() - lastRegistryAttempt < REGISTRY_RETRY_MS) return;
    lastRegistryAttempt = Date.now();
    void st.refreshRegistry();
  };
  useEffect(ensureExternalServers, []);
  const locked = useConversationLocked(conversationId);
  const options = [
    { id: "nex", name: "NexAgent" },
    ...servers.filter((s) => s.id !== "nex"),
  ];
  if (!options.some((s) => s.id === agentType))
    options.push({ id: agentType, name: agentType });
  return (
    <div className="flex min-w-0 items-center gap-1">
      <ComposerOptionMenu
        ariaLabel="智能体"
        bordered={bordered}
        title={locked ? "已有对话，不能切换智能体" : "选择智能体"}
        value={agentType}
        options={options}
        disabled={locked || busy}
        renderIcon={(id) => <AgentIcon agentType={id} status={null} size={12} />}
        onOpenChange={(open) => {
          if (!open) return;
          if (!servers.length) void useAgentStore.getState().loadServers();
          ensureExternalServers();
        }}
        onSelect={(target) => {
          if (target === agentType) return;
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
              // Warm the new agent now; repeated switches are debounced and
              // superseded starts are discarded inside the store.
              useAgentStore
                .getState()
                .prewarmSession(conversationId, target, projectPath);
            } catch (err) {
              setError(errorMessage(err));
            } finally {
              setBusy(false);
              onBusyChange(false);
            }
          })();
        }}
      />
      {error && (
        <span role="alert" className="text-xs text-[var(--text-secondary)]">
          {error}
        </span>
      )}
    </div>
  );
}
