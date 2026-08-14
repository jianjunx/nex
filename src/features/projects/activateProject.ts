import { fsWatchStart, type Project } from "../../bridge/tauri";
import { useAgentStore } from "../../stores/agent.store";
import { useClipboardStore } from "../../stores/clipboard.store";
import { useConversationStore } from "../../stores/conversation.store";
import { useFsStore } from "../../stores/fs.store";
import { useProjectStore } from "../../stores/project.store";
import { restoreProjectConversationTabs } from "./restoreProjectConversationTabs";

/** Clear selection and clipboard state that belongs to the previous project. */
export function resetFsSelectionForProjectSwitch(projectPath: string): void {
  useFsStore.getState().clearTreeExcept(projectPath);
  useClipboardStore.getState().clear();
}

/**
 * Switch projects from any project picker while preserving the same state
 * restoration behavior as the top-bar project menu.
 */
export async function activateProject(project: Project): Promise<void> {
  const oldId = useProjectStore.getState().activeProjectId;
  if (oldId === project.id) return;

  if (oldId) {
    await useFsStore.getState().saveCurrentEditorState(oldId);
  }

  useProjectStore.getState().switchProject(project.id);
  resetFsSelectionForProjectSwitch(project.path);
  useFsStore.getState().switchSearchProject(project.id);

  // Keep only the destination project's session data hydrated; its tabs and
  // thread entries are restored below.
  const keep = new Set(useConversationStore.getState().tabsByProject[project.id] ?? []);
  useAgentStore.getState().pruneEntriesExcept(keep);

  await Promise.all([
    useFsStore.getState().loadEditorState(project.id),
    restoreProjectConversationTabs(project.id),
    fsWatchStart(project.path).catch(() => {}),
  ]);

  // Match the project selector: make its most recently active open tab active.
  const convs = useConversationStore.getState().conversationsByProject[project.id] ?? [];
  const latestId = [...convs].sort((a, b) => b.updated_at - a.updated_at)[0]?.id;
  if (
    latestId &&
    (useConversationStore.getState().tabsByProject[project.id] ?? []).includes(latestId)
  ) {
    useConversationStore.getState().switchTab(latestId);
  }
}
