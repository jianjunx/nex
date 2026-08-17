import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useAgentStore } from "../../stores/agent.store";
import { useUiStore } from "../../stores/ui.store";
import {
  selectProjectActiveTabId,
  useConversationStore,
} from "../../stores/conversation.store";
import { useProjectStore } from "../../stores/project.store";
import { CloseTabConfirmDialog } from "../agent/CloseTabConfirmDialog";

function hasBusySessions(): boolean {
  const sessions = useAgentStore.getState().sessions;
  return Object.values(sessions).some(
    (s) => s && (s.status === "running" || s.status === "waiting" || s.status === "starting"),
  );
}

/**
 * Hosts: (1) Cmd/Ctrl+W close-tab confirm via ui.store.requestCloseActiveTab,
 * (2) window close / quit confirm when agent tasks are busy.
 * Mount once at app root.
 */
export function AppLifecycleHost() {
  const closeTabRequest = useUiStore((s) => s.closeTabRequest);
  const consumeCloseTabRequest = useUiStore((s) => s.consumeCloseTabRequest);
  const activeProjectId = useProjectStore((s) => s.activeProjectId);
  const activeTabId = useConversationStore((s) => selectProjectActiveTabId(s, activeProjectId));
  const removeConversation = useConversationStore((s) => s.removeConversation);
  const sessions = useAgentStore((s) => s.sessions);
  const removeSession = useAgentStore((s) => s.removeSession);

  const [pendingCloseId, setPendingCloseId] = useState<string | null>(null);
  const [closingTab, setClosingTab] = useState(false);
  const [quitOpen, setQuitOpen] = useState(false);
  const [quitting, setQuitting] = useState(false);

  // Cmd/Ctrl+W → request close of active conversation tab
  useEffect(() => {
    if (closeTabRequest === 0) return;
    consumeCloseTabRequest();
    if (!activeTabId) return;
    setPendingCloseId(activeTabId);
  }, [closeTabRequest, activeTabId, consumeCloseTabRequest]);

  // Intercept window close; confirm when tasks are running
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void (async () => {
      try {
        const win = getCurrentWindow();
        const fn = await win.onCloseRequested(async (event) => {
          if (hasBusySessions()) {
            event.preventDefault();
            setQuitOpen(true);
          }
        });
        if (cancelled) fn();
        else unlisten = fn;
      } catch {
        /* non-tauri / test env */
      }
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const confirmQuit = async () => {
    setQuitting(true);
    try {
      // destroy() bypasses beforeunload — flush mid-turn thread snapshots
      // here so interrupted conversations keep their history on next launch.
      await useAgentStore.getState().flushThreadSnapshots();
      await getCurrentWindow().destroy();
    } catch {
      window.close();
    } finally {
      setQuitting(false);
      setQuitOpen(false);
    }
  };

  return (
    <>
      <CloseTabConfirmDialog
        open={pendingCloseId !== null}
        busy={closingTab}
        status={pendingCloseId ? (sessions[pendingCloseId]?.status ?? null) : null}
        onCancel={() => {
          if (!closingTab) setPendingCloseId(null);
        }}
        onConfirm={() => {
          if (!pendingCloseId || closingTab) return;
          const id = pendingCloseId;
          setClosingTab(true);
          void (async () => {
            try {
              await removeSession(id);
              await removeConversation(id);
            } finally {
              setClosingTab(false);
              setPendingCloseId(null);
            }
          })();
        }}
      />

      <Dialog
        open={quitOpen}
        onOpenChange={(o) => {
          if (!o && !quitting) setQuitOpen(false);
        }}
      >
        <DialogContent showCloseButton={false} className="sm:max-w-sm border-[color:var(--hairline-soft)] bg-[var(--material-elevated)]" data-testid="quit-confirm-dialog">
          <DialogHeader>
            <DialogTitle>退出应用？</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-[var(--text-secondary)]">
            有任务仍在执行或等待权限，退出将中断这些任务且不可恢复。
          </p>
          <DialogFooter>
            <Button variant="ghost" size="sm" disabled={quitting} onClick={() => setQuitOpen(false)}>
              取消
            </Button>
            <Button variant="destructive" size="sm" disabled={quitting} onClick={() => void confirmQuit()}>
              {quitting ? "退出中…" : "退出并中断"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
