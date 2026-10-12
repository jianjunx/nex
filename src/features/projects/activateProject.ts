import { fsWatchStart, type Project } from "../../bridge/tauri";
import { useAgentStore } from "../../stores/agent.store";
import { useClipboardStore } from "../../stores/clipboard.store";
import { useConversationStore } from "../../stores/conversation.store";
import { useFsStore } from "../../stores/fs.store";
import { useProjectStore } from "../../stores/project.store";
import { isCurrentActivation, nextActivationEpoch } from "../../stores/activationEpoch";
import { restoreProjectConversationTabs } from "./restoreProjectConversationTabs";

/** Clear selection and clipboard state that belongs to the previous project. */
export function resetFsSelectionForProjectSwitch(projectPath: string): void {
  useFsStore.getState().clearTreeExcept(projectPath);
  useClipboardStore.getState().clear();
}

/**
 * Switch projects from any project picker.
 *
 * The active project changes immediately. Editor flush, cold file restore,
 * thread hydration and the file watcher keep running in the background; a
 * newer switch abandons their results.
 */
export async function activateProject(project: Project): Promise<void> {
  const oldId = useProjectStore.getState().activeProjectId;
  if (oldId === project.id) return;

  const epoch = nextActivationEpoch();
  const stillCurrent = () => isCurrentActivation(epoch);

  if (oldId) {
    // Snapshot is synchronous; dirty files flush after this returns.
    void useFsStore.getState().saveCurrentEditorState(oldId);
  }

  useProjectStore.getState().switchProject(project.id);
  resetFsSelectionForProjectSwitch(project.path);
  useFsStore.getState().switchSearchProject(project.id);

  // Keep only the destination project's session data hydrated; its tabs and
  // thread entries are restored below. Live ACP sessions (any project) stay
  // connected so switching back does not pay another handshake.
  const keep = new Set(useConversationStore.getState().tabsByProject[project.id] ?? []);
  useAgentStore.getState().pruneEntriesExcept(keep);

  void useFsStore.getState().loadEditorState(project.id, stillCurrent);
  void fsWatchStart(project.path).catch(() => {});

  await restoreProjectConversationTabs(project.id);
  if (!stillCurrent()) return;

  const convState = useConversationStore.getState();
  const openTabs = convState.tabsByProject[project.id] ?? [];
  const activeTabId = convState.activeTabByProject[project.id] ?? null;
  if (activeTabId && openTabs.includes(activeTabId)) {
    return;
  }

  const convs = convState.conversationsByProject[project.id] ?? [];
  const latestId = [...convs]
    .filter((c) => openTabs.includes(c.id))
    .sort((a, b) => b.updated_at - a.updated_at)[0]?.id;
  if (latestId && stillCurrent()) {
    convState.switchTab(latestId);
  }
}
