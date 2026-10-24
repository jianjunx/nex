import { useEffect, useRef, useState } from "react";
import { Folder, FolderPlus } from "lucide-react";
import type { Conversation, Project } from "@/bridge/tauri";
import { toastError } from "@/stores/toast.store";
import { useProjectStore } from "@/stores/project.store";
import { moveDraftToProject } from "../projects/startTask";
import { openProjectFolder } from "../projects/openProjectFolder";
import { AgentSelector } from "./AgentSelector";
import { ComposerOptionMenu } from "./ComposerOptionMenu";
import { useConversationLocked } from "./useConversationLocked";

/**
 * Sub-info bar above the composer for a task that has not started yet:
 * pick the project and the agent here. It disappears as soon as the
 * conversation has content, so neither can change mid-conversation.
 */
export function NewTaskBar({
  conversation,
  project,
  onBusyChange,
}: {
  conversation: Conversation;
  project: Project;
  onBusyChange: (busy: boolean) => void;
}) {
  const locked = useConversationLocked(conversation.id);
  const projects = useProjectStore((s) => s.projects);
  const [moving, setMoving] = useState(false);
  const alive = useRef(true);
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (openTimer.current) clearTimeout(openTimer.current);
    };
  }, []);
  if (locked) return null;

  const run = async (task: () => Promise<void>) => {
    setMoving(true);
    onBusyChange(true);
    try {
      await task();
    } catch (err) {
      toastError("切换项目失败", err);
    } finally {
      if (alive.current) setMoving(false);
      onBusyChange(false);
    }
  };

  const selectProject = (id: string) => {
    const target = projects.find((p) => p.id === id);
    if (!target || target.id === project.id) return;
    return run(() => moveDraftToProject(conversation, target));
  };

  const openFolder = () => {
    // Defer until the menu has closed: opening the OS dialog from onSelect
    // races Radix focus-restore (on Windows the dialog can land behind).
    openTimer.current = setTimeout(() => {
      void run(async () => {
        // 不自动新建任务：下面会把当前这份草稿搬到新项目，效果一样，
        // 但不会凭空多出一个空会话。
        await openProjectFolder({ startTask: false });
        const active = useProjectStore
          .getState()
          .projects.find((p) => p.id === useProjectStore.getState().activeProjectId);
        if (active && active.id !== project.id) {
          await moveDraftToProject(conversation, active);
        }
      });
    }, 80);
  };

  return (
    <div
      className="mb-2 flex min-w-0 flex-wrap items-center gap-1.5"
      data-testid="new-task-bar"
    >
      <ComposerOptionMenu
        ariaLabel="项目"
        bordered
        title="选择项目"
        value={project.id}
        options={projects.map((p) => ({ id: p.id, name: p.name }))}
        disabled={moving}
        renderIcon={() => <Folder size={12} className="shrink-0 opacity-70" />}
        onSelect={selectProject}
        actions={[
          {
            id: "open-folder",
            name: "打开文件夹…",
            icon: <FolderPlus size={12} className="shrink-0" />,
            onSelect: openFolder,
          },
        ]}
      />
      <AgentSelector
        conversationId={conversation.id}
        agentType={conversation.agent_type}
        projectPath={project.path}
        bordered
        onBusyChange={onBusyChange}
      />
    </div>
  );
}
