import type { ServerDescriptor, SessionTarget } from "@/bridge/tauri";

/** Map a conversation's `agent_type` to the backend launch target. */
export function resolveSessionTarget(
  agentType: string,
  servers: readonly ServerDescriptor[],
): SessionTarget {
  const descriptor = servers.find((s) => s.id === agentType) ?? null;
  if (descriptor?.kind === "custom") return { type: "custom", id: agentType };
  if (descriptor?.kind === "native" || agentType === "nex") return { type: "native" };
  return { type: "registry", id: agentType };
}
