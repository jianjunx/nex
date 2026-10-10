import type { Conversation, Project } from "@/bridge/tauri";
import { useAgentStore } from "@/stores/agent.store";
import { useConversationStore } from "@/stores/conversation.store";
import { DEFAULT_CONVERSATION_TITLE } from "../agent/deriveConversationTitle";
import { activateProject } from "./activateProject";

/** A conversation that was never used: default title and nothing in flight. */
function isPristine(conv: Conversation): boolean {
  if (conv.title !== DEFAULT_CONVERSATION_TITLE) return false;
  const agent = useAgentStore.getState();
  const status = agent.sessions[conv.id]?.status;
  return (
    !agent.entriesByConversation[conv.id]?.length &&
    !agent.pendingMessagesByConversation[conv.id]?.length &&
    !useConversationStore.getState().messagesByConversation[conv.id]?.length &&
    status !== "running" &&
    status !== "waiting"
  );
}

/**
 * Open a fresh task in `project`. If the project's active tab is still an
 * untouched draft it is reused instead of piling up empty "New Chat" rows,
 * each of which would otherwise keep a pre-initialized agent alive.
 */
export async function startNewTask(project: Project): Promise<void> {
  await activateProject(project);
  const conv = useConversationStore.getState();
  const activeId = conv.activeTabByProject[project.id];
  const active = activeId
    ? (conv.conversationsByProject[project.id] ?? []).find((c) => c.id === activeId)
    : undefined;
  if (active && isPristine(active)) return;
  const created = await conv.createConversation(project.id, "nex");
  useAgentStore.getState().prewarmSession(created.id, "nex", project.path);
}

/**
 * Move an untouched draft to another project: the conversation row belongs
 * to a project, so create the replacement first (no blank flash), then drop
 * the old draft together with its pre-initialized session.
 */
export async function moveDraftToProject(
  draft: Conversation,
  target: Project,
): Promise<void> {
  if (draft.project_id === target.id) return;
  await activateProject(target);
  const created = await useConversationStore
    .getState()
    .createConversation(target.id, draft.agent_type);
  useAgentStore.getState().prewarmSession(created.id, draft.agent_type, target.path);
  try {
    await useAgentStore.getState().removeSession(draft.id);
    await useConversationStore.getState().removeConversation(draft.id);
  } catch (err) {
    console.warn("[moveDraftToProject] failed to drop old draft:", err);
  }
}
