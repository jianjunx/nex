import { useEffect, useRef, useState } from "react";
import { Plus } from "lucide-react";
import { useUiStore } from "@/stores/ui.store";
import { useProjectStore } from "@/stores/project.store";
import { startNewTask } from "./startTask";
import { errorMessage } from "@/lib/errors";

/** Kept under its former export name for command consumers; no agent picker here. */
export function NewConversationDropdown({
  triggerSize: _triggerSize,
  compact = false,
}: {
  triggerSize: "icon" | "icon-sm";
  /** Icon-only button for the collapsed sidebar rail. */
  compact?: boolean;
}) {
  const requested = useUiStore((s) => s.newConversationOpen);
  const lock = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const create = async () => {
    if (lock.current) return;
    const { projects, activeProjectId } = useProjectStore.getState();
    const project = projects.find((p) => p.id === activeProjectId) ?? projects[0];
    if (!project) {
      setError("请先添加项目");
      useUiStore.getState().closeNewConversation();
      return;
    }
    lock.current = true;
    setBusy(true);
    setError(null);
    useUiStore.getState().closeNewConversation();
    try {
      await startNewTask(project);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  useEffect(() => {
    if (requested) void create();
  }, [requested]);
  return (
    <div className="w-full">
      <button
        type="button"
        disabled={busy}
        aria-label="新建任务"
        title={compact ? "新建任务" : undefined}
        onClick={() => void create()}
      >
        <Plus size={16} />
        {!compact && (busy ? "正在创建…" : "新建任务")}
      </button>
      {error && (
        <p role="alert" className="text-xs">
          {error}
        </p>
      )}
    </div>
  );
}
