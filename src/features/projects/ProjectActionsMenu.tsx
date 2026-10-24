import { useState } from "react";
import { Ellipsis, FolderOpen, Pin, PinOff, Trash2 } from "lucide-react";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { fsRevealEntry, fsWatchStop, type Project } from "@/bridge/tauri";
import { useProjectStore } from "@/stores/project.store";
import { useConversationStore } from "@/stores/conversation.store";
import { useAgentStore } from "@/stores/agent.store";
import { clearAllAutoSaveTimers, useFsStore } from "@/stores/fs.store";
import { useClipboardStore } from "@/stores/clipboard.store";
import { useUiStore } from "@/stores/ui.store";
import { nextActivationEpoch } from "@/stores/activationEpoch";
import { activateProject } from "./activateProject";
import { projectHasActiveConversation } from "./projectHasActiveConversation";
import { errorMessage } from "@/lib/errors";

export function ProjectActionsMenu({ project, onError }: {
  project: Project;
  onError: (message: string | null) => void;
}) {
  const pinned = useProjectStore((s) => s.pinnedProjectIds.includes(project.id));
  // Subscribe to status and membership changes, including background projects.
  useAgentStore((s) => s.sessions);
  useAgentStore((s) => s.pendingMessagesByConversation);
  useConversationStore((s) => s.conversationsByProject[project.id]);
  const busy = projectHasActiveConversation(project.id);
  const [confirming, setConfirming] = useState(false);
  const [removing, setRemoving] = useState(false);
  const remove = async () => {
    if (removing) return;
    setRemoving(true);
    onError(null);
    try {
      if (projectHasActiveConversation(project.id)) {
        throw new Error("项目下有进行中的会话，暂时不能移除");
      }
      if (useProjectStore.getState().activeProjectId === project.id) {
        await useFsStore.getState().saveCurrentEditorState(project.id);
      }
      await useProjectStore.getState().removeProject(project.id);
      void fsWatchStop(project.path).catch(() => {});
      if (useProjectStore.getState().activeProjectId === null) {
        nextActivationEpoch();
        const next = useProjectStore.getState().projects[0];
        if (next) {
          await activateProject(next);
        } else {
          clearAllAutoSaveTimers();
          useFsStore.setState({ openFiles: [], activePath: null, nodesByDir: {}, selectedPath: null });
          useFsStore.getState().switchSearchProject(null);
          useClipboardStore.getState().clear();
          useUiStore.getState().setEditorVisible(false);
        }
      }
      setConfirming(false);
    } catch (err) {
      onError(errorMessage(err));
      setConfirming(false);
    } finally {
      setRemoving(false);
    }
  };
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button className="nex-icon-btn" aria-label={`更多项目操作：${project.name}`} title="更多">
            <Ellipsis size={15} />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-44">
          <DropdownMenuItem onSelect={() => useProjectStore.getState().toggleProjectPin(project.id)}>
            {pinned ? <PinOff /> : <Pin />}{pinned ? "取消置顶" : "置顶"}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => {
            onError(null);
            void fsRevealEntry(project.path).catch((err) => onError(errorMessage(err)));
          }}>
            <FolderOpen />在 Finder 中显示
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" disabled={busy}
            title={busy ? "项目下有进行中的会话，暂时不能移除" : undefined}
            onSelect={() => setConfirming(true)}>
            <Trash2 />移除项目
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog open={confirming} onOpenChange={(open) => { if (!removing) setConfirming(open); }}>
        <DialogContent showCloseButton={false} className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>移除项目？</DialogTitle>
            <DialogDescription>
              将移除「{project.name}」及其全部本地会话记录。此操作不可恢复，磁盘中的项目文件会保留。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" size="sm" disabled={removing} onClick={() => setConfirming(false)}>取消</Button>
            <Button variant="destructive" size="sm" disabled={removing || busy} onClick={() => void remove()}>
              {removing ? "移除中…" : "移除项目"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
