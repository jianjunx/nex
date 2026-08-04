import { useState, useRef, useEffect, useCallback, type ClipboardEvent, type KeyboardEvent } from "react";
import { Send, Square, X, AtSign } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useAgentStore, pendingMessagePreview, waitSessionReady } from "../../stores/agent.store";
import { useProjectStore } from "../../stores/project.store";
import {
  selectProjectActiveTabId,
  selectProjectConversations,
  useConversationStore,
} from "../../stores/conversation.store";
import { fsSearch, fsReadFile, type PromptBlock, type SearchMatch, type SessionTarget } from "../../bridge/tauri";
import { ComposerOptionMenu } from "./ComposerOptionMenu";
import { PlanBar } from "./thread/PlanBar";
import { PendingMessagesBar } from "./thread/PendingMessagesBar";
import { TextEditContextMenu } from "@/components/ui/TextEditContextMenu";

// Text area only — toolbar lives inside the same chrome below this.
const MIN_HEIGHT = 48;
const MAX_HEIGHT = 200;

interface FileMention {
  path: string;
  name: string;
}

interface PendingImage {
  id: string;
  mimeType: string;
  data: string;
  previewUrl: string;
}

export function AgentComposer() {
  const [text, setText] = useState("");
  const [mentions, setMentions] = useState<FileMention[]>([]);
  const [images, setImages] = useState<PendingImage[]>([]);
  const [slashOpen, setSlashOpen] = useState(false);
  const [atOpen, setAtOpen] = useState(false);
  const [atQuery, setAtQuery] = useState("");
  const [atResults, setAtResults] = useState<SearchMatch[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const imagesRef = useRef(images);
  imagesRef.current = images;

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
  const setConfigOption = useAgentStore((s) => s.setConfigOption);
  const setAuthMode = useAgentStore((s) => s.setAuthMode);
  const sessionPrefsByConversation = useAgentStore((s) => s.sessionPrefsByConversation);
  const autoTitleFromFirstMessage = useConversationStore((s) => s.autoTitleFromFirstMessage);
  const pendingMessagesByConversation = useAgentStore((s) => s.pendingMessagesByConversation);
  const enqueuePendingMessage = useAgentStore((s) => s.enqueuePendingMessage);
  const removePendingMessage = useAgentStore((s) => s.removePendingMessage);
  const sendPendingNow = useAgentStore((s) => s.sendPendingNow);

  const session = activeTabId ? sessions[activeTabId] : null;
  const meta = activeTabId ? metaByConversation[activeTabId] : null;
  const isStarting = session?.status === "starting";
  const isRunning = session?.status === "running" || session?.status === "waiting";
  const pendingMessages = activeTabId ? (pendingMessagesByConversation[activeTabId] ?? []) : [];
  const agentError = useAgentStore((s) => s.error);
  const createSession = useAgentStore((s) => s.createSession);
  const conversations = useConversationStore((s) =>
    selectProjectConversations(s, activeProjectId),
  );
  const activeConversation = conversations.find((c) => c.id === activeTabId) ?? null;
  const canSend = (!!text.trim() || images.length > 0) && !!activeTabId;
  const isCursorAgent = activeConversation?.agent_type === "cursor";
  const authMode =
    (activeTabId ? sessionPrefsByConversation[activeTabId]?.authMode : undefined) ?? "menu";

  // Revoke leftover object URLs on unmount.
  useEffect(() => {
    return () => {
      for (const img of imagesRef.current) URL.revokeObjectURL(img.previewUrl);
    };
  }, []);

  const removeImage = useCallback((id: string) => {
    setImages((prev) => {
      const target = prev.find((x) => x.id === id);
      if (target) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((x) => x.id !== id);
    });
  }, []);

  const addImageFiles = useCallback(async (files: File[]) => {
    const next: PendingImage[] = [];
    for (const file of files) {
      if (!file.type.startsWith("image/")) continue;
      try {
        const data = await fileToBase64(file);
        next.push({
          id: crypto.randomUUID(),
          mimeType: file.type || "image/png",
          data,
          previewUrl: URL.createObjectURL(file),
        });
      } catch {
        /* skip unreadable clipboard blobs */
      }
    }
    if (next.length > 0) setImages((prev) => [...prev, ...next]);
  }, []);

  /** After restart, tabs restore without a live ACP process — spawn on first send. */
  const ensureLiveSession = async (): Promise<string | null> => {
    if (!activeTabId || !project || !activeConversation) return null;
    const current = useAgentStore.getState().sessions[activeTabId];
    if (current?.sessionId && current.status !== "starting") return current.sessionId;

    // Wait if a create is already in flight for this tab — event-driven
    // (store subscription), not a fixed-delay polling loop.
    if (current?.status === "starting") {
      return waitSessionReady(activeTabId);
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
    if ((!text.trim() && images.length === 0) || !activeTabId) return;
    const content = text;
    const fileMentions = [...mentions];
    const pendingImages = [...images];
    setText("");
    setMentions([]);
    setImages([]);
    for (const img of pendingImages) URL.revokeObjectURL(img.previewUrl);
    setSlashOpen(false);
    setAtOpen(false);
    requestAnimationFrame(adjustHeight);

    const threadImages = pendingImages.map((img) => ({
      mimeType: img.mimeType,
      data: img.data,
    }));
    appendUserMessage(activeTabId, content, threadImages);
    autoTitleFromFirstMessage(
      activeTabId,
      content.trim() || (threadImages.length > 0 ? "图片" : content),
    );

    // Build prompt blocks eagerly (reads file mentions now, even if session isn't ready)
    const blocks: PromptBlock[] = [];
    if (content.trim()) blocks.push({ type: "text", text: content });
    for (const img of pendingImages) {
      blocks.push({ type: "image", data: img.data, mime_type: img.mimeType });
    }
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
    if (blocks.length === 0) {
      useAgentStore.setState((s) => {
        if (s.sessions[activeTabId]?.status === "running") {
          s.sessions[activeTabId].status = "idle";
        }
      });
      return;
    }

    // If session is starting or busy, queue the message for later
    if (isStarting) {
      enqueuePendingMessage(activeTabId, blocks);
      // Session may have become ready while we were building blocks — trigger check
      void useAgentStore.getState().processNextPending(activeTabId);
      return;
    }
    if (isRunning) {
      enqueuePendingMessage(activeTabId, blocks);
      return;
    }

    // Normal flow: ensure session and send
    const sessionId = await ensureLiveSession();
    if (!sessionId) {
      // appendUserMessage may have flipped idle → running; clear it if we never send.
      const sess = useAgentStore.getState().sessions[activeTabId];
      if (sess?.status === "running") {
        useAgentStore.setState((s) => {
          if (s.sessions[activeTabId]?.status === "running") {
            s.sessions[activeTabId].status = "idle";
          }
        });
      }
      return;
    }
    await sendPrompt(sessionId, blocks);
  };

  const handlePaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const dt = e.clipboardData;
    if (!dt) return;
    const imageFiles: File[] = [];
    for (const item of Array.from(dt.items ?? [])) {
      if (!item.type.startsWith("image/")) continue;
      const file = item.getAsFile();
      if (file) imageFiles.push(file);
    }
    if (imageFiles.length === 0) {
      for (const file of Array.from(dt.files ?? [])) {
        if (file.type.startsWith("image/")) imageFiles.push(file);
      }
    }
    if (imageFiles.length === 0) return;
    e.preventDefault();
    void addImageFiles(imageFiles);
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
      <PendingMessagesBar
        messages={pendingMessages}
        onSendNow={(id) => void sendPendingNow(activeTabId!, id)}
        onRemove={(id) => removePendingMessage(activeTabId!, id)}
        previewFn={pendingMessagePreview}
      />

      <div className="px-4 pb-3 relative">
        {slashOpen && filteredCommands.length > 0 && (
          <div className="absolute bottom-full left-4 right-4 mb-1 max-h-48 overflow-y-auto rounded-[var(--radius-md)] border border-[color:var(--glass-border)] bg-[var(--glass-3-surface)] shadow-lg z-20">
            {filteredCommands.map((c) => (
              <button
                key={c.name}
                type="button"
                className="w-full text-left px-2.5 py-1.5 text-sm hover:bg-[var(--glass-2-surface)]"
                onClick={() => pickCommand(c.name)}
              >
                <span className="font-mono text-[var(--accent)]">/{c.name}</span>
                <span className="ml-2 text-[var(--text-tertiary)]">{c.description}</span>
              </button>
            ))}
          </div>
        )}

        {atOpen && (
          <div className="absolute bottom-full left-4 right-4 mb-1 max-h-48 overflow-y-auto rounded-[var(--radius-md)] border border-[color:var(--glass-border)] bg-[var(--glass-3-surface)] shadow-lg z-20">
            {atResults.length === 0 ? (
              <div className="px-2.5 py-1.5 text-xs text-[var(--text-tertiary)]">Search files…</div>
            ) : (
              atResults.map((hit) => (
                <button
                  key={hit.path}
                  type="button"
                  className="w-full text-left px-2.5 py-1.5 text-sm hover:bg-[var(--glass-2-surface)]"
                  onClick={() => pickFile(hit)}
                >
                  <span className="font-medium">{hit.name}</span>
                  <span className="ml-2 text-xs text-[var(--text-tertiary)]">{hit.path}</span>
                </button>
              ))
            )}
          </div>
        )}

        {(mentions.length > 0 || images.length > 0) && (
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
            {images.map((img) => (
              <span
                key={img.id}
                className="relative inline-flex rounded-[var(--radius-sm)] border border-[color:var(--border-subtle)] overflow-hidden"
              >
                <img src={img.previewUrl} alt="" className="h-14 w-14 object-cover" />
                <button
                  type="button"
                  className="absolute top-0.5 right-0.5 rounded-full bg-black/55 text-white p-0.5"
                  onClick={() => removeImage(img.id)}
                  title="移除图片"
                >
                  <X size={10} />
                </button>
              </span>
            ))}
          </div>
        )}

        {(isStarting || agentError) && (
          <div className="mb-2 text-xs px-1">
            {isStarting && (
              <p className="text-[var(--text-tertiary)]">正在连接服务…</p>
            )}
            {agentError && !isStarting && (
              <p className="text-[var(--error)] whitespace-pre-wrap">{agentError}</p>
            )}
          </div>
        )}

        {/* Single bordered surface: textarea + toolbar share one chrome so
            Mode/Model/Send sit inside the input box (not below it). */}
        <div
          className="flex flex-col gap-1.5 rounded-[var(--radius-md)] bg-[var(--glass-3-surface)] border border-[color:var(--glass-border)] px-2.5 pt-2 pb-1.5 shadow-xs transition-[border-color,box-shadow] focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50"
          onClick={() => textareaRef.current?.focus()}
        >
          <TextEditContextMenu getTarget={() => textareaRef.current}>
            <Textarea
              ref={textareaRef}
              value={text}
              onChange={(e) => onChange(e.target.value)}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              placeholder={
                isStarting
                  ? "Agent starting…"
                  : activeTabId
                    ? "Send a message…  / commands  @ files  粘贴图片"
                    : "Start a conversation to chat"
              }
              className="flex-1 min-h-0 border-0 bg-transparent p-1 shadow-none rounded-none text-sm font-normal leading-[21px] text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] resize-none overflow-y-auto focus-visible:border-0 focus-visible:ring-0 dark:bg-transparent"
              style={{ minHeight: MIN_HEIGHT, maxHeight: MAX_HEIGHT }}
              disabled={!activeTabId}
            />
          </TextEditContextMenu>

          <div
            className="flex items-center gap-1 pt-0.5"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="ml-auto flex items-center gap-0.5 min-w-0">
              {isCursorAgent && activeTabId && (
                <ComposerOptionMenu
                  ariaLabel="Authorization"
                  value={authMode}
                  options={[
                    { id: "allow", name: "Allow" },
                    { id: "menu", name: "Menu" },
                  ]}
                  onSelect={(id) => setAuthMode(activeTabId, id as "allow" | "menu")}
                />
              )}
              {session?.sessionId && meta && (() => {
                const configOpts = (meta.configOptions ?? []).filter((o) => o.options.length > 0);
                const hasConfigMode = configOpts.some(
                  (o) => o.id === "mode" || o.category === "mode",
                );
                const hasConfigModel = configOpts.some(
                  (o) => o.id === "model" || o.category === "model",
                );
                return (
                  <>
                    {!hasConfigMode && meta.modes.length > 0 && (
                      <ComposerOptionMenu
                        ariaLabel="Mode"
                        value={meta.currentModeId ?? ""}
                        options={meta.modes.map((m) => ({ id: m.id, name: m.name }))}
                        onSelect={(id) => void setMode(session.sessionId, id)}
                      />
                    )}
                    {!hasConfigModel && meta.models.length > 0 && (
                      <ComposerOptionMenu
                        ariaLabel="Model"
                        value={meta.currentModelId ?? ""}
                        options={meta.models.map((m) => ({ id: m.id, name: m.name }))}
                        onSelect={(id) => void setModel(session.sessionId, id)}
                      />
                    )}
                    {configOpts.map((opt) => (
                      <ComposerOptionMenu
                        key={opt.id}
                        ariaLabel={opt.name || opt.id}
                        value={opt.currentValueId}
                        options={opt.options.map((o) => ({ id: o.id, name: o.name }))}
                        onSelect={(id) => void setConfigOption(session.sessionId, opt.id, id)}
                      />
                    ))}
                  </>
                );
              })()}

              {isRunning ? (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => session?.sessionId && void cancel(session.sessionId)}
                  title="Stop"
                  className="rounded-full shrink-0"
                >
                  <Square size={14} />
                </Button>
              ) : (
                <Button
                  variant="default"
                  size="icon-sm"
                  disabled={!canSend}
                  onClick={() => void handleSend()}
                  title="Send"
                  className="rounded-full shrink-0"
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

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        reject(new Error("unexpected FileReader result"));
        return;
      }
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.readAsDataURL(file);
  });
}
