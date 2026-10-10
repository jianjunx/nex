import { open } from "@tauri-apps/plugin-dialog";
import { useProjectStore } from "@/stores/project.store";
import { useFsStore } from "@/stores/fs.store";
import { resetFsSelectionForProjectSwitch } from "./activateProject";
import { restoreProjectConversationTabs } from "./restoreProjectConversationTabs";
import { fsWatchStart } from "@/bridge/tauri";

export async function openProjectFolder() {
  const path = await open({
    directory: true,
    multiple: false,
    title: "打开文件夹新增项目",
  });
  if (typeof path !== "string") return;
  const old = useProjectStore.getState().activeProjectId;
  if (old) await useFsStore.getState().saveCurrentEditorState(old);
  await useProjectStore.getState().openProject(path);
  const state = useProjectStore.getState();
  if (state.error) throw new Error(state.error);
  const project = state.projects.find((p) => p.id === state.activeProjectId);
  if (!project) return;
  resetFsSelectionForProjectSwitch(project.path);
  useFsStore.getState().switchSearchProject(project.id);
  await Promise.all([
    useFsStore.getState().loadEditorState(project.id),
    restoreProjectConversationTabs(project.id),
    fsWatchStart(project.path).catch(() => {}),
  ]);
}
