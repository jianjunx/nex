import { useState, useRef, useEffect, useCallback, type KeyboardEvent } from "react";
import { Send, Square, X, AtSign, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useAgentStore } from "../../stores/agent.store";
import { useProjectStore } from "../../stores/project.store";
import {
  selectProjectActiveTabId,
  selectProjectConversations,
  useConversationStore,
} from "../../stores/conversation.store";
import { fsSearch, fsReadFile, type PromptBlock, type SearchMatch, type SessionTarget } from "../../bridge/tauri";
import { PlanBar } from "./thread/PlanBar";

// Text area only — toolbar lives inside the same chrome below this.
const MIN_HEIGHT = 60;
const MAX_HEIGHT = 240;

interface FileMention {
  path: string;
  name: string;
}

export function AgentComposer() {
  const [text, setText] = useState("");
  const [mentions, setMentions] = useState<FileMention[]>([]);
  const [slashOpen, setSlashOpen] = useState(false);
  const [atOpen, setAtOpen] = useState(false);
  const [atQuery, setAtQuery] = useState("");
  const [atResults, setAtResults] = useState<SearchMatch[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const activeProjectId = useProjectStore((s) => s.activeProjectId);
  const projects = useProjectStore((s) => s.projects);
  const project = projects.find((p) => p.id === activeProjectId);
  const activeTabId = useConversationStore((s) => selectProjectActiveTabId(s, activeProjectId));
  const sessions = useAgentStore((s) => s.sessions);
  const metaByConversation = useAgentStore((s) => s.metaByConversation);
  const sendPrompt = useAgentStore((s) => s.sendPrompt);
  const appendUserMessage = useAgentStore((s) => s.appendUserMessage);
  const cancel = useAgentStore((s) => s.cancel);
  const setMode = useAgentStore((s) => s.setMode);
  const setModel = useAgentStore((s) => s.setModel);
  const autoTitleFromFirstMessage = useConversationStore((s) => s.autoTitleFromFirstMessage);

  const session = activeTabId ? sessions[activeTabId] : null;
  const meta = activeTabId ? metaByConversation[activeTabId] : null;
  const isStarting = session?.status === "starting";
  const isRunning = session?.status === "running" || session?.status === "waiting";
  const agentError = useAgentStore((s) => s.error);
  const createSession = useAgentStore((s) => s.createSession);
  const conversations = useConversationStore((s) =>
    selectProjectConversations(s, activeProjectId),
  );
  const activeConversation = conversations.find((c) => c.id === activeTabId) ?? null;

  /** After restart, tabs restore without a live ACP process — spawn on first send. */
  const ensureLiveSession = async (): Promise<string | null> => {
    if (!activeTabId || !project || !activeConversation) return null;
    const current = useAgentStore.getState().sessions[activeTabId];
    if (current?.sessionId && current.status !== "starting") return current.sessionId;

    // Wait briefly if a create is already in flight for this tab.
    if (current?.status === "starting") {
      for (let i = 0; i < 60; i++) {
        await new Promise((r) => setTimeout(r, 250));
        const s = useAgentStore.getState().sessions[activeTabId];
        if (s?.sessionId && s.status !== "starting") return s.sessionId;
        if (!s) break;
      }
      return useAgentStore.getState().sessions[activeTabId]?.sessionId || null;
    }

    const servers = useAgentStore.getState().servers;
    if (servers.length === 0) await useAgentStore.getState().loadServers();
    const descriptor =
      useAgentStore.getState().servers.find((s) => s.id === activeConversation.agent_type) ?? null;
    const target: SessionTarget =
      descriptor?.kind === "custom"
        ? { type: "custom", id: activeConversation.agent_type }
        : { type: "registry", id: activeConversation.agent_type };
    try {
      return await createSession(activeTabId, target, project.path);
    } catch {
      return null;
    }
  };

  // Restore cold tabs without an active ACP process by starting the agent
  // automatically when the active tab becomes available.
  useEffect(() => {
    if (!activeTabId || !project || !activeConversation) return;
    void ensureLiveSession();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTabId, project?.path, activeConversation?.id]);

  const adjustHeight = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(Math.max(el.scrollHeight, MIN_HEIGHT), MAX_HEIGHT)}px`;
  }, []);

  useEffect(() => {
    adjustHeight();
  }, [adjustHeight]);

  useEffect(() => {
    if (!atOpen || !project || !atQuery.trim()) {
      setAtResults([]);
      return;
    }
    let cancelled = false;
    const t = window.setTimeout(() => {
      void fsSearch(project.path, atQuery).then((hits) => {
        if (!cancelled) setAtResults(hits.slice(0, 8));
      });
    }, 120);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [atOpen, atQuery, project]);

  const filteredCommands = (meta?.availableCommands ?? []).filter((c) => {
    if (!slashOpen) return false;
    const q = text.startsWith("/") ? text.slice(1).toLowerCase() : "";
    return !q || c.name.toLowerCase().includes(q);
  });

  const handleSend = async () => {
    if (!text.trim() || !activeTabId || isStarting) return;
    const content = text;
    const fileMentions = [...mentions];
    setText("");
    setMentions([]);
    setSlashOpen(false);
    setAtOpen(false);
    requestAnimationFrame(adjustHeight);

    appendUserMessage(activeTabId, content);
    autoTitleFromFirstMessage(activeTabId, content);

    const sessionId = await ensureLiveSession();
    if (!sessionId) return;

    const blocks: PromptBlock[] = [{ type: "text", text: content }];
    for (const m of fileMentions) {
      try {
        const file = await fsReadFile(m.path);
        if (file.is_text && file.content != null) {
          blocks.push({
            type: "resource",
            uri: pathToFileUri(m.path),
            mime_type: "text/plain",
            text: file.content,
          });
        } else {
          blocks.push({ type: "resource_link", uri: pathToFileUri(m.path), name: m.name });
        }
      } catch {
        blocks.push({ type: "resource_link", uri: pathToFileUri(m.path), name: m.name });
      }
    }
    await sendPrompt(sessionId, blocks);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !slashOpen && !atOpen) {
      e.preventDefault();
      void handleSend();
    }
    if (e.key === "Escape") {
      setSlashOpen(false);
      setAtOpen(false);
    }
  };

  const onChange = (value: string) => {
    setText(value);
    adjustHeight();
    if (value.startsWith("/") && !value.includes("\n") && (meta?.availableCommands.length ?? 0) > 0) {
      setSlashOpen(true);
      setAtOpen(false);
    } else {
      setSlashOpen(false);
    }
    const atMatch = value.match(/(?:^|\s)@([^\s@]*)$/);
    if (atMatch) {
      setAtOpen(true);
      setAtQuery(atMatch[1] ?? "");
      setSlashOpen(false);
    } else {
      setAtOpen(false);
    }
  };

  const pickCommand = (name: string) => {
    setText(`/${name} `);
    setSlashOpen(false);
    textareaRef.current?.focus();
  };

  const pickFile = (hit: SearchMatch) => {
    setMentions((prev) => (prev.some((m) => m.path === hit.path) ? prev : [...prev, { path: hit.path, name: hit.name }]));
    setText((t) => t.replace(/(?:^|\s)@[^\s@]*$/, " ").trimStart());
    setAtOpen(false);
    textareaRef.current?.focus();
  };

  return (
    <div>
      {meta?.plan && meta.plan.length > 0 && <PlanBar entries={meta.plan} />}

      <div className="px-6 py-4 relative">
        {slashOpen && filteredCommands.length > 0 && (
          <div className="absolute bottom-full left-6 right-6 mb-1 max-h-48 overflow-y-auto rounded-[var(--radius-md)] border border-[color:var(--glass-border)] bg-[var(--glass-3-surface)] shadow-lg z-20">
            {filteredCommands.map((c) => (
              <button
                key={c.name}
                type="button"
                className="w-full text-left px-3 py-2 text-sm hover:bg-[var(--glass-2-surface)]"
                onClick={() => pickCommand(c.name)}
              >
                <span className="font-mono text-[var(--accent)]">/{c.name}</span>
                <span className="ml-2 text-[var(--text-tertiary)]">{c.description}</span>
              </button>
            ))}
          </div>
        )}

        {atOpen && (
          <div className="absolute bottom-full left-6 right-6 mb-1 max-h-48 overflow-y-auto rounded-[var(--radius-md)] border border-[color:var(--glass-border)] bg-[var(--glass-3-surface)] shadow-lg z-20">
            {atResults.length === 0 ? (
              <div className="px-3 py-2 text-xs text-[var(--text-tertiary)]">Search files…</div>
            ) : (
              atResults.map((hit) => (
                <button
                  key={hit.path}
                  type="button"
                  className="w-full text-left px-3 py-2 text-sm hover:bg-[var(--glass-2-surface)]"
                  onClick={() => pickFile(hit)}
                >
                  <span className="font-medium">{hit.name}</span>
                  <span className="ml-2 text-xs text-[var(--text-tertiary)]">{hit.path}</span>
                </button>
              ))
            )}
          </div>
        )}

        {mentions.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-2">
            {mentions.map((m) => (
              <span
                key={m.path}
                className="inline-flex items-center gap-1 rounded-full bg-[var(--glass-2-surface)] border border-[color:var(--border-subtle)] px-2 py-0.5 text-xs"
              >
                <AtSign size={10} />
                {m.name}
                <button type="button" onClick={() => setMentions((prev) => prev.filter((x) => x.path !== m.path))}>
                  <X size={10} />
                </button>
              </span>
            ))}
          </div>
        )}

        {(isStarting || agentError) && (
          <div className="mb-2 text-xs px-1">
            {isStarting && (
              <p className="text-[var(--text-tertiary)]">正在启动 Agent（拉起进程并握手）…</p>
            )}
            {agentError && !isStarting && (
              <p className="text-[var(--error)] whitespace-pre-wrap">{agentError}</p>
            )}
          </div>
        )}

        {/* Single bordered surface: textarea + toolbar share one chrome so
            Mode/Model/Send sit inside the input box (not below it). */}
        <div
          className="flex flex-col gap-2 rounded-[var(--radius-lg)] bg-[var(--glass-3-surface)] border border-[color:var(--glass-border)] px-3 pt-3 pb-2 shadow-xs transition-[border-color,box-shadow] focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50"
          onClick={() => textareaRef.current?.focus()}
        >
          <Textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={
              isStarting
                ? "Agent starting…"
                : activeTabId
                  ? "Send a message…  / commands  @ files"
                  : "Start a conversation to chat"
            }
            className="flex-1 min-h-0 border-0 bg-transparent p-1 shadow-none rounded-none text-sm font-normal leading-[21px] text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] resize-none overflow-y-auto focus-visible:border-0 focus-visible:ring-0 dark:bg-transparent"
            style={{ minHeight: MIN_HEIGHT, maxHeight: MAX_HEIGHT }}
            disabled={!activeTabId || isStarting}
          />

          <div
            className="flex items-center gap-1.5 flex-wrap pt-0.5"
            onClick={(e) => e.stopPropagation()}
          >
            {meta && meta.modes.length > 0 && session?.sessionId && (
              <label className="relative inline-flex items-center text-xs text-[var(--text-secondary)]">
                <span className="mr-1 opacity-70">Mode</span>
                <select
                  className="appearance-none bg-[var(--glass-2-surface)] border border-[color:var(--border-subtle)] rounded-full pl-2.5 pr-6 py-1 text-xs"
                  value={meta.currentModeId ?? ""}
                  onChange={(e) => void setMode(session.sessionId, e.target.value)}
                >
                  {meta.modes.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </select>
                <ChevronDown size={12} className="absolute right-1.5 pointer-events-none opacity-50" />
              </label>
            )}

            {meta && meta.models.length > 0 && session?.sessionId && (
              <label className="relative inline-flex items-center text-xs text-[var(--text-secondary)]">
                <select
                  className="appearance-none bg-transparent hover:bg-[var(--glass-2-surface)] rounded-full pl-2 pr-6 py-1 text-xs max-w-[160px] text-[var(--text-secondary)]"
                  value={meta.currentModelId ?? ""}
                  onChange={(e) => void setModel(session.sessionId, e.target.value)}
                  title="Model"
                >
                  {meta.models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </select>
                <ChevronDown size={12} className="absolute right-1.5 pointer-events-none opacity-50" />
              </label>
            )}

            {meta?.configOptions.map((opt) =>
              session?.sessionId ? (
                <label key={opt.id} className="relative inline-flex items-center text-xs text-[var(--text-secondary)]">
                  <span className="mr-1 opacity-70">{opt.name}</span>
                  <select
                    className="appearance-none bg-[var(--glass-2-surface)] border border-[color:var(--border-subtle)] rounded-full pl-2.5 pr-6 py-1 text-xs"
                    value={opt.currentValueId}
                    onChange={() => {
                      /* set_config not in ACP 0.7; UI ready for future wire-up */
                    }}
                  >
                    {opt.options.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.name}
                      </option>
                    ))}
                  </select>
                  <ChevronDown size={12} className="absolute right-1.5 pointer-events-none opacity-50" />
                </label>
              ) : null,
            )}

            <div className="ml-auto flex items-center gap-1.5">
              {isRunning ? (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => session?.sessionId && void cancel(session.sessionId)}
                  title="Stop"
                  className="rounded-full"
                >
                  <Square size={14} />
                </Button>
              ) : (
                <Button
                  variant="default"
                  size="icon-sm"
                  disabled={!text.trim() || !activeTabId || isStarting}
                  onClick={() => void handleSend()}
                  title="Send"
                  className="rounded-full"
                >
                  <Send size={14} />
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function pathToFileUri(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  if (/^[a-zA-Z]:/.test(normalized)) return `file:///${normalized}`;
  return `file://${normalized}`;
}
