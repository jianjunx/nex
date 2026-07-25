import { useEffect, useState } from "react";
import { GlassModal, GlassButton } from "../../ui";
import { useConversationStore } from "../../stores/conversation.store";
import { useAgentStore } from "../../stores/agent.store";
import { useProjectStore } from "../../stores/project.store";
import type { Conversation } from "../../bridge/tauri";

const AGENTS = [
  { id: "claude-code", label: "Claude Code", command: "claude --acp" },
  { id: "codex", label: "Codex", command: "codex --acp" },
  { id: "cursor-cli", label: "Cursor CLI", command: "cursor --acp" },
  { id: "opencode", label: "Opencode", command: "opencode --acp" },
];

interface Props { open: boolean; onClose: () => void; }

// Backend errors arrive as { type, message }; fall back to String(err).
function errorMessage(err: unknown): string {
  if (err && typeof err === "object" && "message" in err && typeof (err as { message: unknown }).message === "string") {
    return (err as { message: string }).message;
  }
  return String(err);
}

export function NewConversationModal({ open, onClose }: Props) {
  const [selectedAgent, setSelectedAgent] = useState(AGENTS[0]);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const createConversation = useConversationStore((s) => s.createConversation);
  const closeTab = useConversationStore((s) => s.closeTab);
  const createSession = useAgentStore((s) => s.createSession);
  const projects = useProjectStore((s) => s.projects);
  const activeProjectId = useProjectStore((s) => s.activeProjectId);
  const project = projects.find((p) => p.id === activeProjectId);

  // Fresh state every time the modal opens (stale errors from a previous
  // failed attempt must not linger).
  useEffect(() => {
    if (open) {
      setCreating(false);
      setError(null);
    }
  }, [open]);

  const handleCreate = async () => {
    if (!project || creating) return;
    setCreating(true);
    setError(null);
    let conv: Conversation | null = null;
    try {
      conv = await createConversation(project.id, selectedAgent.id);
      await createSession(conv.id, selectedAgent.command, project.path);
    } catch (err) {
      // If the conversation (and its tab) was created before the agent
      // session failed to start, drop the orphan tab; show the error so the
      // user can retry or pick another agent.
      if (conv) closeTab(conv.id);
      setError(errorMessage(err));
      setCreating(false);
      return;
    }
    setCreating(false);
    onClose();
  };

  return (
    <GlassModal open={open} onClose={onClose} title="New Conversation">
      <div className="space-y-2 mb-6">
        {AGENTS.map((a) => (
          <button
            key={a.id}
            disabled={creating}
            onClick={() => { setSelectedAgent(a); setError(null); }}
            className={`w-full text-left px-5 py-3 rounded-[var(--radius-md)] text-sm disabled:opacity-50 transition-colors ${selectedAgent.id === a.id ? "bg-[var(--accent)]/20 border border-[var(--accent)]/40 text-[var(--text-primary)]" : "bg-[var(--glass-interactive-bg)] border border-[color:var(--border-default)] text-[var(--text-secondary)] hover:bg-[var(--overlay-hover)]"}`}
          >
            {a.label}
          </button>
        ))}
      </div>
      {error && (
        <p className="mb-4 text-sm text-[var(--error)] px-1">{error}</p>
      )}
      <GlassButton variant="accent" className="w-full py-3" disabled={creating} onClick={handleCreate}>
        {creating ? "Creating…" : "Create"}
      </GlassButton>
    </GlassModal>
  );
}
