import { open } from "@tauri-apps/plugin-dialog";
import { useProjectStore } from "@/stores/project.store";
import { useFsStore } from "@/stores/fs.store";
import { resetFsSelectionForProjectSwitch } from "./activateProject";
import { restoreProjectConversationTabs } from "./restoreProjectConversationTabs";
import { startNewTask } from "./startTask";
import { fsWatchStart } from "@/bridge/tauri";

export interface OpenProjectFolderOptions {
  /**
   * 打开后是否直接在该项目下新建任务。默认开：打开文件夹的目的就是去干活，
   * 不该再让用户回到侧栏找到这个项目点一次「新建任务」。
   *
   * NewTaskBar 传 false——它要把当前这份草稿搬到新项目，那本身就是"在新项目
   * 下建任务"，再自动建一条会凭空多出一个空会话。
   */
  startTask?: boolean;
}

export async function openProjectFolder(opts: OpenProjectFolderOptions = {}) {
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
  if (opts.startTask !== false) await startNewTask(project);
}
