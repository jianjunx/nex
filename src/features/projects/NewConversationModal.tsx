import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useConversationStore } from "../../stores/conversation.store";
import { useAgentStore } from "../../stores/agent.store";
import { useProjectStore } from "../../stores/project.store";
import type { Conversation, ServerDescriptor, SessionTarget } from "../../bridge/tauri";

interface Props { open: boolean; onClose: () => void; }

function errorMessage(err: unknown): string {
  if (err && typeof err === "object" && "message" in err && typeof (err as { message: unknown }).message === "string") {
    return (err as { message: string }).message;
  }
  return String(err);
}

export function NewConversationModal({ open, onClose }: Props) {
  const servers = useAgentStore((s) => s.servers);
  const serversLoading = useAgentStore((s) => s.serversLoading);
  const refreshRegistry = useAgentStore((s) => s.refreshRegistry);
  const createSession = useAgentStore((s) => s.createSession);
  const createConversation = useConversationStore((s) => s.createConversation);
  const closeTab = useConversationStore((s) => s.closeTab);
  const projects = useProjectStore((s) => s.projects);
  const activeProjectId = useProjectStore((s) => s.activeProjectId);
  const project = projects.find((p) => p.id === activeProjectId);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setCreating(false);
      setError(null);
      void useAgentStore.getState().loadServers();
    }
  }, [open]);

  const selected: ServerDescriptor | null =
    servers.find((s) => s.id === selectedId) ?? servers[0] ?? null;

  const handleCreate = async () => {
    if (!project || creating || !selected) return;
    setCreating(true);
    setError(null);
    let conv: Conversation | null = null;
    try {
      conv = await createConversation(project.id, selected.id);
      const target: SessionTarget = { type: "registry", id: selected.id };
      await createSession(conv.id, target, project.path);
    } catch (err) {
      if (conv) closeTab(conv.id);
      setError(errorMessage(err));
      setCreating(false);
      return;
    }
    setCreating(false);
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New Conversation</DialogTitle>
        </DialogHeader>
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium uppercase tracking-wide text-[var(--text-tertiary)]">
            Agents (Claude Code · Codex · Cursor)
          </span>
          <button
            disabled={serversLoading || creating}
            onClick={() => void refreshRegistry()}
            title="Refresh agent registry"
            className="flex items-center gap-1 text-xs text-[var(--text-tertiary)] transition-colors hover:text-[var(--text-secondary)] disabled:opacity-50"
          >
            <RefreshCw size={12} className={serversLoading ? "animate-spin" : ""} />
            {serversLoading ? "Refreshing…" : "Refresh"}
          </button>
        </div>

        <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
          {servers.length === 0 && !serversLoading && (
            <p className="text-sm text-[var(--text-tertiary)] px-1">
              No agents available. Connect to the internet and hit Refresh.
            </p>
          )}
          {servers.map((s) => {
            const isSelected = selected?.id === s.id;
            return (
              <button
                key={s.id}
                disabled={creating}
                onClick={() => { setSelectedId(s.id); setError(null); }}
                className={`w-full text-left px-5 py-3 rounded-[var(--radius-md)] text-sm disabled:opacity-50 transition-colors duration-150 ${isSelected ? "border border-[var(--accent)] bg-[var(--accent)]/10 text-[var(--text-primary)]" : "bg-[var(--glass-2-surface)] border border-[color:var(--color-border)] text-[var(--text-secondary)] hover:bg-[var(--glass-3-surface)]"}`}
              >
                <div className="flex items-center gap-2">
                  <span className="font-medium">{s.name}</span>
                  {s.version && <span className="text-xs text-[var(--text-tertiary)]">v{s.version}</span>}
                </div>
                {s.description && (
                  <div className="mt-0.5 text-xs text-[var(--text-tertiary)] truncate">{s.description}</div>
                )}
              </button>
            );
          })}
        </div>

        {error && (
          <p className="text-sm text-[var(--error)] whitespace-pre-wrap">{error}</p>
        )}
        <Button
          disabled={creating || !selected}
          onClick={handleCreate}
          className="w-full h-auto py-3"
        >
          {creating ? "Creating…" : "Create"}
        </Button>
      </DialogContent>
    </Dialog>
  );
}
