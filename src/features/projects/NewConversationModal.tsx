import { useState } from "react";
import { GlassModal, GlassButton } from "../../ui";
import { useConversationStore } from "../../stores/conversation.store";
import { useAgentStore } from "../../stores/agent.store";
import { useProjectStore } from "../../stores/project.store";

const AGENTS = [
  { id: "claude-code", label: "Claude Code", command: "claude --acp" },
  { id: "codex", label: "Codex", command: "codex --acp" },
  { id: "cursor-cli", label: "Cursor CLI", command: "cursor --acp" },
  { id: "opencode", label: "Opencode", command: "opencode --acp" },
];

interface Props { open: boolean; onClose: () => void; }

export function NewConversationModal({ open, onClose }: Props) {
  const [selectedAgent, setSelectedAgent] = useState(AGENTS[0]);
  const createConversation = useConversationStore((s) => s.createConversation);
  const createSession = useAgentStore((s) => s.createSession);
  const projects = useProjectStore((s) => s.projects);
  const activeProjectId = useProjectStore((s) => s.activeProjectId);
  const project = projects.find((p) => p.id === activeProjectId);

  const handleCreate = async () => {
    if (!project) return;
    const conv = await createConversation(project.id, selectedAgent.id);
    await createSession(conv.id, selectedAgent.command, project.path);
    onClose();
  };

  return (
    <GlassModal open={open} onClose={onClose} title="New Conversation">
      <div className="space-y-2 mb-4">
        {AGENTS.map((a) => (
          <button
            key={a.id}
            onClick={() => setSelectedAgent(a)}
            className={`w-full text-left px-3 py-2 rounded-[var(--radius-sm)] text-sm ${selectedAgent.id === a.id ? "bg-[var(--accent)]/20 border border-[var(--accent)]/40 text-[var(--text-primary)]" : "bg-[var(--glass-interactive-bg)] border border-white/[0.08] text-[var(--text-secondary)]"}`}
          >
            {a.label}
          </button>
        ))}
      </div>
      <GlassButton variant="accent" className="w-full" onClick={handleCreate}>
        Create
      </GlassButton>
    </GlassModal>
  );
}
