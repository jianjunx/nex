import { useEffect, useState } from "react";
import { RefreshCw, Plus, X } from "lucide-react";
import { Button, Input, Modal, ModalContent, ModalHeader, ModalTitle, Textarea } from "@glinui/ui";
import { useConversationStore } from "../../stores/conversation.store";
import { useAgentStore } from "../../stores/agent.store";
import { useProjectStore } from "../../stores/project.store";
import type { Conversation, ServerDescriptor, SessionTarget } from "../../bridge/tauri";

interface Props { open: boolean; onClose: () => void; }

// Backend errors arrive as { type, message }; fall back to String(err).
function errorMessage(err: unknown): string {
  if (err && typeof err === "object" && "message" in err && typeof (err as { message: unknown }).message === "string") {
    return (err as { message: string }).message;
  }
  return String(err);
}

// Accent CTA overrides must carry dark: counterparts: dark: is bound to
// [data-theme="dark"] via @custom-variant in globals.css (app pins light, so
// these are inert until dark theme support lands), but GlinUI's default
// variant brings dark:bg-*/dark:text-*/dark:hover:bg-* that tailwind-merge
// can't merge across modifier groups.
const ACCENT_CTA =
  "bg-[var(--accent)] text-white hover:bg-[var(--accent-hover)] dark:bg-[var(--accent)] dark:text-white dark:hover:bg-[var(--accent-hover)]";

export function NewConversationModal({ open, onClose }: Props) {
  const servers = useAgentStore((s) => s.servers);
  const serversLoading = useAgentStore((s) => s.serversLoading);
  const refreshRegistry = useAgentStore((s) => s.refreshRegistry);
  const upsertCustom = useAgentStore((s) => s.upsertCustom);
  const deleteCustom = useAgentStore((s) => s.deleteCustom);
  const createSession = useAgentStore((s) => s.createSession);
  const createConversation = useConversationStore((s) => s.createConversation);
  const closeTab = useConversationStore((s) => s.closeTab);
  const projects = useProjectStore((s) => s.projects);
  const activeProjectId = useProjectStore((s) => s.activeProjectId);
  const project = projects.find((p) => p.id === activeProjectId);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showCustomForm, setShowCustomForm] = useState(false);
  const [customName, setCustomName] = useState("");
  const [customCommand, setCustomCommand] = useState("");
  const [customEnv, setCustomEnv] = useState("");

  // Fresh state + a server-list load every time the modal opens (stale errors
  // from a previous attempt must not linger). Uses getState() so the effect
  // only re-runs on `open`.
  useEffect(() => {
    if (open) {
      setCreating(false);
      setError(null);
      setShowCustomForm(false);
      void useAgentStore.getState().loadServers();
    }
  }, [open]);

  // Selection falls back to the first server if the stored id is missing
  // (list just loaded, or the selected custom server was deleted).
  const selected: ServerDescriptor | null =
    servers.find((s) => s.id === selectedId) ?? servers[0] ?? null;

  const registryServers = servers.filter((s) => s.kind === "registry");
  const customServers = servers.filter((s) => s.kind === "custom");

  const handleCreate = async () => {
    if (!project || creating || !selected) return;
    setCreating(true);
    setError(null);
    let conv: Conversation | null = null;
    try {
      conv = await createConversation(project.id, selected.id);
      const target: SessionTarget =
        selected.kind === "registry"
          ? { type: "registry", id: selected.id }
          : { type: "custom", id: selected.id };
      await createSession(conv.id, target, project.path);
    } catch (err) {
      // If the conversation (and its tab) was created before the agent session
      // failed to start, drop the orphan tab; show the error so the user can
      // retry or pick another agent.
      if (conv) closeTab(conv.id);
      setError(errorMessage(err));
      setCreating(false);
      return;
    }
    setCreating(false);
    onClose();
  };

  const handleAddCustom = async () => {
    const name = customName.trim();
    const command = customCommand.trim();
    if (!name || !command) {
      setError("A name and a command are required for a custom server.");
      return;
    }
    // Parse "KEY=VALUE" lines into an env map; blank/malformed lines ignored.
    const env: Record<string, string> = {};
    for (const line of customEnv.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const eq = trimmed.indexOf("=");
      if (eq > 0) env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
    }
    setCreating(true);
    setError(null);
    try {
      const id = crypto.randomUUID();
      await upsertCustom({ id, name, command, env });
      setSelectedId(id);
      setShowCustomForm(false);
      setCustomName("");
      setCustomCommand("");
      setCustomEnv("");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setCreating(false);
    }
  };

  const renderServer = (s: ServerDescriptor) => {
    const isSelected = selected?.id === s.id;
    return (
      <div key={s.id} className="relative">
        <button
          disabled={creating}
          onClick={() => { setSelectedId(s.id); setError(null); }}
          className={`w-full text-left px-5 py-3 rounded-[var(--radius-md)] text-sm disabled:opacity-50 transition-colors ${isSelected ? "border border-[var(--accent)] bg-[var(--accent)]/10 text-[var(--text-primary)]" : "bg-[var(--glass-2-surface)] border border-[color:var(--color-border)] text-[var(--text-secondary)] hover:bg-[var(--glass-3-surface)]"}`}
        >
          <div className="flex items-center gap-2">
            <span className="font-medium">{s.name}</span>
            {s.version && <span className="text-xs text-[var(--text-tertiary)]">v{s.version}</span>}
          </div>
          {s.description && (
            <div className="mt-0.5 text-xs text-[var(--text-tertiary)] truncate">{s.description}</div>
          )}
        </button>
        {s.kind === "custom" && (
          <button
            disabled={creating}
            onClick={() => void deleteCustom(s.id)}
            title="Remove custom server"
            className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded text-[var(--text-tertiary)] hover:text-[var(--error)] hover:bg-[var(--overlay-hover)]"
          >
            <X size={13} />
          </button>
        )}
      </div>
    );
  };

  return (
    <Modal open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <ModalContent size="sm">
        <ModalHeader>
          <ModalTitle>New Conversation</ModalTitle>
        </ModalHeader>
        <div className="flex items-center justify-between px-1">
          <span className="text-xs font-medium uppercase tracking-wide text-[var(--text-tertiary)]">Agents</span>
          <button
            disabled={serversLoading || creating}
            onClick={() => void refreshRegistry()}
            title="Refresh agent registry"
            className="flex items-center gap-1 text-xs text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] disabled:opacity-50"
          >
            <RefreshCw size={12} className={serversLoading ? "animate-spin" : ""} />
            {serversLoading ? "Refreshing…" : "Refresh"}
          </button>
        </div>

        <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
          {servers.length === 0 && !serversLoading && (
            <p className="text-sm text-[var(--text-tertiary)] px-1">
              No agents available. Connect to the internet and hit Refresh, or add a custom server below.
            </p>
          )}
          {registryServers.map(renderServer)}
          {customServers.length > 0 && (
            <>
              <div className="pt-1 text-xs font-medium uppercase tracking-wide text-[var(--text-tertiary)] px-1">Custom</div>
              {customServers.map(renderServer)}
            </>
          )}
        </div>

        {showCustomForm ? (
          <div className="space-y-2 p-3 rounded-[var(--radius-md)] bg-[var(--glass-2-surface)] border border-[color:var(--border-default)]">
            <Input
              variant="glass"
              value={customName}
              onChange={(e) => setCustomName(e.target.value)}
              placeholder="Name (e.g. My Agent)"
              disabled={creating}
            />
            <Input
              variant="glass"
              value={customCommand}
              onChange={(e) => setCustomCommand(e.target.value)}
              placeholder="Command (e.g. npx -y my-agent --acp)"
              disabled={creating}
            />
            <Textarea
              variant="glass"
              value={customEnv}
              onChange={(e) => setCustomEnv(e.target.value)}
              placeholder={"Env (one KEY=VALUE per line, optional)\nANTHROPIC_API_KEY=sk-…"}
              disabled={creating}
              rows={2}
              className="resize-none font-normal placeholder:text-[var(--text-tertiary)]"
            />
            <div className="flex gap-2">
              <Button size="sm" disabled={creating} onClick={handleAddCustom} className={ACCENT_CTA}>Save server</Button>
              <Button size="sm" variant="ghost" disabled={creating} onClick={() => setShowCustomForm(false)}>Cancel</Button>
            </div>
          </div>
        ) : (
          <button
            disabled={creating}
            onClick={() => { setShowCustomForm(true); setError(null); }}
            className="flex items-center gap-1.5 px-1 text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)] disabled:opacity-50"
          >
            <Plus size={14} /> Add custom ACP server…
          </button>
        )}

        {error && (
          <p className="text-sm text-[var(--error)] px-1 whitespace-pre-wrap">{error}</p>
        )}
        <Button
          disabled={creating || !selected}
          onClick={handleCreate}
          className={`w-full h-auto py-3 ${ACCENT_CTA}`}
        >
          {creating ? "Creating…" : "Create"}
        </Button>
      </ModalContent>
    </Modal>
  );
}
