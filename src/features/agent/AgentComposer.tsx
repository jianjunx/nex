import { useState, useRef, useEffect, useCallback, useMemo, type ClipboardEvent, type CSSProperties, type KeyboardEvent } from "react";
import { Send, Square, X, Plus, ImagePlus, FilePlus } from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import { useAgentStore, pendingMessagePreview, waitSessionReady } from "../../stores/agent.store";
import { useProjectStore } from "../../stores/project.store";
import {
  selectProjectActiveTabId,
  selectProjectConversations,
  useConversationStore,
} from "../../stores/conversation.store";
import { fsSearch, fsReadFile, type PromptBlock, type SearchMatch, type SessionTarget } from "../../bridge/tauri";
import { ComposerOptionMenu } from "./ComposerOptionMenu";
import { ContextUsageRing } from "./ContextUsageRing";
import { BranchSelector } from "../git/BranchSelector";
import { useGitStore } from "../../stores/git.store";
import { PlanBar } from "./thread/PlanBar";
import { PendingMessagesBar } from "./thread/PendingMessagesBar";
import { TextEditContextMenu } from "@/components/ui/TextEditContextMenu";
import {
  clearComposerDraft,
  loadComposerDraft,
  saveComposerDraft,
} from "../../stores/composerDrafts";
import { fuzzyFilter } from "./composerFuzzy";
import { setComposerSuggestOpen } from "./composerPanelState";
import { measureCaretInTextarea } from "./composerCaret";
import { fileBasename, relativeToProject } from "../editor/pathUtils";
import FileIcon from "../files/FileIcon";
import type { AvailableCommand } from "./thread/types";

// Compact default; grows with content / attached images inside the chrome.
const MIN_HEIGHT = 36;
const MAX_HEIGHT = 200;

interface FileMention {
  path: string;
  /** Token inserted after `@` in the textarea (basename or project-relative). */
  name: string;
}

interface PendingImage {
  id: string;
  mimeType: string;
  data: string;
  previewUrl: string;
}

/** Match `/query` at end of input (allows mid-message slash after whitespace). */
function matchSlashTrigger(value: string): { query: string; start: number } | null {
  const m = value.match(/(?:^|\s)\/([^\s]*)$/);
  if (!m) return null;
  const query = m[1] ?? "";
  const slashAt = value.lastIndexOf("/");
  return { query, start: slashAt };
}

function matchAtTrigger(value: string): { query: string } | null {
  const m = value.match(/(?:^|\s)@([^\s@]*)$/);
  if (!m) return null;
  return { query: m[1] ?? "" };
}

/** Prefer a short project-relative path for the inline `@token`. */
function mentionTokenFor(path: string, projectPath: string | undefined): string {
  const rel = relativeToProject(path, projectPath);
  if (rel !== path && !rel.startsWith("..") && rel.length > 0 && rel.length < 96) {
    return rel.replace(/\\/g, "/");
  }
  return fileBasename(path);
}

/** Replace trailing `@query` or append `@token ` at the end. */
function insertAtToken(text: string, token: string): string {
  if (/(?:^|\s)@[^\s@]*$/.test(text)) {
    return text.replace(/(?:^|\s)@[^\s@]*$/, (m) => {
      const lead = /^\s/.test(m) ? m[0]! : "";
      return `${lead}@${token} `;
    });
  }
  const needsSpace = text.length > 0 && !/\s$/.test(text);
  return `${text}${needsSpace ? " " : ""}@${token} `;
}

/** Filename + parent dir (with trailing `/`) for the @ picker row. */
function mentionDisplayParts(
  absPath: string,
  projectPath: string | undefined,
): { name: string; dir: string } {
  const name = fileBasename(absPath);
  const rel = relativeToProject(absPath, projectPath).replace(/\\/g, "/");
  if (rel === absPath || rel.startsWith("..")) {
    return { name, dir: "" };
  }
  const slash = rel.lastIndexOf("/");
  if (slash < 0) return { name, dir: "" };
  return { name, dir: rel.slice(0, slash + 1) };
}

/** Prefer filename hits; drop content-line duplicates for the @ picker. */
function dedupeMentionHits(hits: SearchMatch[]): SearchMatch[] {
  const seen = new Set<string>();
  const out: SearchMatch[] = [];
  const ordered = [...hits].sort((a, b) => {
    const an = a.line == null ? 0 : 1;
    const bn = b.line == null ? 0 : 1;
    return an - bn;
  });
  for (const h of ordered) {
    if (seen.has(h.path)) continue;
    seen.add(h.path);
    out.push(h);
  }
  return out;
}

function isImeKeyEvent(e: KeyboardEvent<HTMLTextAreaElement>): boolean {
  // keyCode 229 = browser still composing (common on macOS Chinese IME).
  return e.nativeEvent.isComposing || e.keyCode === 229;
}

export function AgentComposer() {
  const [text, setText] = useState("");
  const [mentions, setMentions] = useState<FileMention[]>([]);
  const [images, setImages] = useState<PendingImage[]>([]);
  const [slashOpen, setSlashOpen] = useState(false);
  const [atOpen, setAtOpen] = useState(false);
  const [slashQuery, setSlashQuery] = useState("");
  const [atQuery, setAtQuery] = useState("");
  const [atResults, setAtResults] = useState<SearchMatch[]>([]);
  const [suggestIndex, setSuggestIndex] = useState(0);
  const [plusOpen, setPlusOpen] = useState(false);
  const [branchOpen, setBranchOpen] = useState(false);
  const [previewImage, setPreviewImage] = useState<PendingImage | null>(null);
  const [caretPos, setCaretPos] = useState<{ top: number; left: number; lineHeight: number } | null>(null);
  const [imeComposing, setImeComposing] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const suggestListRef = useRef<HTMLDivElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const plusMenuRef = useRef<HTMLDivElement>(null);
  const suggestQueryRef = useRef({ slash: "", at: "" });
  const suggestNavRef = useRef({
    slashOpen: false,
    atOpen: false,
    commandCount: 0,
    atCount: 0,
    suggestIndex: 0,
  });
  const imagesRef = useRef(images);
  imagesRef.current = images;
  const textRef = useRef(text);
  textRef.current = text;
  const mentionsRef = useRef(mentions);
  mentionsRef.current = mentions;
  const draftTabRef = useRef<string | null>(null);

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

  const filteredCommands = useMemo(() => {
    if (!slashOpen) return [] as AvailableCommand[];
    const cmds = meta?.availableCommands ?? [];
    return fuzzyFilter(cmds, slashQuery, (c) => `${c.name} ${c.description}`, 40);
  }, [slashOpen, slashQuery, meta?.availableCommands]);

  const filteredAtResults = useMemo(() => {
    if (!atOpen) return [] as SearchMatch[];
    const unique = dedupeMentionHits(atResults);
    if (!atQuery.trim()) return unique.slice(0, 24);
    return fuzzyFilter(
      unique,
      atQuery,
      (h) => {
        const parts = mentionDisplayParts(h.path, project?.path);
        return `${parts.name} ${parts.dir}${parts.name}`;
      },
      24,
    );
  }, [atOpen, atQuery, atResults, project?.path]);

  // Always show the slash popover when `/` is active — even if the agent has
  // not published commands yet (otherwise "/" looks broken).
  const suggestOpen = slashOpen || atOpen;
  const suggestCount = slashOpen
    ? filteredCommands.length
    : atOpen
      ? filteredAtResults.length
      : 0;

  suggestNavRef.current = {
    slashOpen,
    atOpen,
    commandCount: filteredCommands.length,
    atCount: filteredAtResults.length,
    suggestIndex,
  };

  // 供命令注册表判断 Esc 是否应先关建议面板（见 composerPanelState）。
  useEffect(() => {
    setComposerSuggestOpen(slashOpen || atOpen);
  }, [slashOpen, atOpen]);
  useEffect(() => () => setComposerSuggestOpen(false), []);

  useEffect(() => {
    return () => {
      const tab = draftTabRef.current;
      if (tab) {
        saveComposerDraft(tab, { text: textRef.current, mentions: mentionsRef.current });
      }
      for (const img of imagesRef.current) URL.revokeObjectURL(img.previewUrl);
    };
  }, []);

  useEffect(() => {
    const prev = draftTabRef.current;
    if (prev && prev !== activeTabId) {
      saveComposerDraft(prev, { text: textRef.current, mentions: mentionsRef.current });
    }
    draftTabRef.current = activeTabId;
    const draft = activeTabId ? loadComposerDraft(activeTabId) : null;
    setText(draft?.text ?? "");
    setMentions(draft?.mentions ?? []);
    setSlashOpen(false);
    setAtOpen(false);
    setSlashQuery("");
    setAtQuery("");
    setAtResults([]);
    setSuggestIndex(0);
    setPlusOpen(false);
    setImeComposing(false);
    setImages((prevImgs) => {
      for (const img of prevImgs) URL.revokeObjectURL(img.previewUrl);
      return [];
    });
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.style.height = "auto";
      el.style.height = `${Math.min(Math.max(el.scrollHeight, MIN_HEIGHT), MAX_HEIGHT)}px`;
    });
  }, [activeTabId]);

  // Close + menu on outside click.
  useEffect(() => {
    if (!plusOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (plusMenuRef.current?.contains(e.target as Node)) return;
      setPlusOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [plusOpen]);

  // Composer branch button needs current branch — probe git status per project.
  const projectPath = project?.path;
  useEffect(() => {
    if (!projectPath) return;
    void useGitStore.getState().refresh(projectPath).then(() => {
      // 非 git 项目的探测失败不打扰用户；其它真实错误（权限/仓库损坏）保留。
      const st = useGitStore.getState();
      if (!st.status && st.error && /not a git repository/i.test(st.error)) {
        st.clearError();
      }
    });
  }, [projectPath]);

  // Keep highlight in range when the filtered list shrinks.
  useEffect(() => {
    setSuggestIndex((i) => (suggestCount === 0 ? 0 : Math.min(i, suggestCount - 1)));
  }, [suggestCount]);

  // Keep the keyboard-highlighted row visible inside the suggest list
  // without scrolling the page (scrollIntoView would move ancestors).
  useEffect(() => {
    if (!suggestOpen || suggestCount === 0) return;
    const list = suggestListRef.current;
    if (!list) return;
    const row = list.querySelector<HTMLElement>(`[data-suggest-index="${suggestIndex}"]`);
    if (!row) return;
    const listRect = list.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    if (rowRect.bottom > listRect.bottom) {
      list.scrollTop += rowRect.bottom - listRect.bottom;
    } else if (rowRect.top < listRect.top) {
      list.scrollTop -= listRect.top - rowRect.top;
    }
  }, [suggestOpen, suggestCount, suggestIndex]);

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
        /* skip */
      }
    }
    if (next.length > 0) setImages((prev) => [...prev, ...next]);
  }, []);

  const ensureLiveSession = async (): Promise<string | null> => {
    if (!activeTabId || !project || !activeConversation) return null;
    const current = useAgentStore.getState().sessions[activeTabId];
    if (current?.sessionId && current.status !== "starting") return current.sessionId;
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
  }, [adjustHeight, images.length]);

  useEffect(() => {
    if (!atOpen || !project) {
      setAtResults([]);
      return;
    }
    let cancelled = false;
    const t = window.setTimeout(() => {
      void fsSearch(project.path, atQuery).then((hits) => {
        if (!cancelled) setAtResults(hits.slice(0, 80));
      });
    }, 120);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [atOpen, atQuery, project]);

  const updateCaretAnchor = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    const pt = measureCaretInTextarea(el);
    setCaretPos(pt);
  }, []);

  const handleSend = async () => {
    if ((!text.trim() && images.length === 0) || !activeTabId) return;
    const content = text;
    // Only attach files still referenced by an `@token` in the text.
    const fileMentions = mentions.filter((m) => content.includes(`@${m.name}`));
    const pendingImages = [...images];
    setText("");
    setMentions([]);
    setImages([]);
    setPreviewImage(null);
    clearComposerDraft(activeTabId);
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

    if (isStarting) {
      enqueuePendingMessage(activeTabId, blocks);
      void useAgentStore.getState().processNextPending(activeTabId);
      return;
    }
    if (isRunning) {
      enqueuePendingMessage(activeTabId, blocks);
      return;
    }

    const sessionId = await ensureLiveSession();
    if (!sessionId) {
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

  const pickCommand = (name: string) => {
    const el = textareaRef.current;
    const slash = matchSlashTrigger(text);
    let next: string;
    if (slash) {
      next = `${text.slice(0, slash.start)}/${name} `;
    } else {
      next = `/${name} `;
    }
    setText(next);
    setSlashOpen(false);
    setSlashQuery("");
    requestAnimationFrame(() => {
      el?.focus();
      if (el) {
        el.selectionStart = el.selectionEnd = next.length;
        adjustHeight();
      }
    });
  };

  const pickFile = (hit: SearchMatch) => {
    const token = mentionTokenFor(hit.path, project?.path);
    setMentions((prev) => {
      const withoutDup = prev.filter((m) => m.path !== hit.path && m.name !== token);
      return [...withoutDup, { path: hit.path, name: token }];
    });
    const next = insertAtToken(text, token);
    setText(next);
    setAtOpen(false);
    setAtQuery("");
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      el?.focus();
      if (el) {
        el.selectionStart = el.selectionEnd = next.length;
        adjustHeight();
      }
    });
  };

  const applySuggest = () => {
    const nav = suggestNavRef.current;
    if (nav.slashOpen) {
      const cmd = filteredCommands[nav.suggestIndex];
      if (cmd) {
        pickCommand(cmd.name);
        return true;
      }
    }
    if (nav.atOpen) {
      const hit = filteredAtResults[nav.suggestIndex];
      if (hit) {
        pickFile(hit);
        return true;
      }
    }
    return false;
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Let the IME consume keys while composing (Enter confirms pinyin, arrows
    // move IME candidates). Sending / picking here would truncate Chinese input.
    if (imeComposing || isImeKeyEvent(e)) return;

    const nav = suggestNavRef.current;
    const menuActive = nav.slashOpen || nav.atOpen;
    const count = nav.slashOpen ? nav.commandCount : nav.atOpen ? nav.atCount : 0;

    if (menuActive && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      if (count === 0) return;
      setSuggestIndex((i) => {
        if (e.key === "ArrowDown") return (i + 1) % count;
        return (i - 1 + count) % count;
      });
      return;
    }
    if (menuActive && (e.key === "Enter" || e.key === "Tab")) {
      if (count > 0) {
        e.preventDefault();
        applySuggest();
        return;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        // Empty menu: don't send either while trigger is open with zero hits.
        e.preventDefault();
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey && !nav.slashOpen && !nav.atOpen) {
      e.preventDefault();
      void handleSend();
    }
    if (e.key === "Escape") {
      setSlashOpen(false);
      setAtOpen(false);
      setPlusOpen(false);
    }
  };

  const onChange = (value: string) => {
    setText(value);
    adjustHeight();
    // Drop mentions whose `@token` was deleted from the text.
    setMentions((prev) => prev.filter((m) => value.includes(`@${m.name}`)));
    const slash = matchSlashTrigger(value);
    const at = matchAtTrigger(value);
    // Prefer @ over / when both could match (shouldn't normally).
    if (at) {
      const qChanged = suggestQueryRef.current.at !== at.query;
      suggestQueryRef.current = { slash: "", at: at.query };
      setAtOpen(true);
      setAtQuery(at.query);
      setSlashOpen(false);
      setSlashQuery("");
      if (qChanged) setSuggestIndex(0);
      requestAnimationFrame(updateCaretAnchor);
      return;
    }
    setAtOpen(false);
    setAtQuery("");
    suggestQueryRef.current.at = "";
    if (slash) {
      const qChanged = suggestQueryRef.current.slash !== slash.query;
      suggestQueryRef.current.slash = slash.query;
      setSlashOpen(true);
      setSlashQuery(slash.query);
      if (qChanged) setSuggestIndex(0);
      requestAnimationFrame(updateCaretAnchor);
    } else {
      suggestQueryRef.current.slash = "";
      setSlashOpen(false);
      setSlashQuery("");
    }
  };

  const attachFilesFromDialog = async () => {
    setPlusOpen(false);
    try {
      const selected = await openDialog({
        multiple: true,
        title: "引入文件",
      });
      if (!selected) return;
      const paths = Array.isArray(selected) ? selected : [selected];
      let nextText = text;
      setMentions((prev) => {
        const next = [...prev];
        for (const p of paths) {
          if (typeof p !== "string") continue;
          const token = mentionTokenFor(p, project?.path);
          const existing = next.findIndex((m) => m.path === p || m.name === token);
          if (existing >= 0) next[existing] = { path: p, name: token };
          else next.push({ path: p, name: token });
          nextText = insertAtToken(nextText, token);
        }
        return next;
      });
      setText(nextText);
      requestAnimationFrame(() => {
        const el = textareaRef.current;
        el?.focus();
        if (el) {
          el.selectionStart = el.selectionEnd = nextText.length;
          adjustHeight();
        }
      });
    } catch {
      /* cancelled / dialog error */
    }
  };

  const activeSlashCmd = slashOpen ? filteredCommands[suggestIndex] ?? null : null;

  const popoverStyle: CSSProperties | undefined = caretPos
    ? {
        position: "fixed",
        top: Math.max(8, caretPos.top - 8),
        left: Math.min(Math.max(8, caretPos.left + 12), window.innerWidth - 160),
        transform: "translateY(-100%)",
        zIndex: 40,
      }
    : {
        position: "absolute",
        bottom: "100%",
        left: 16,
        marginBottom: 4,
        zIndex: 40,
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
        {(isStarting || agentError) && (
          <div className="mb-2 text-xs px-1">
            {isStarting && <p className="text-[var(--text-tertiary)]">正在连接服务…</p>}
            {agentError && !isStarting && (
              <p className="text-[var(--error)] whitespace-pre-wrap">{agentError}</p>
            )}
          </div>
        )}

        {suggestOpen && (
          <div style={popoverStyle} className="flex items-start gap-0 max-w-[min(92vw,640px)] pointer-events-auto">
            <div
              ref={suggestListRef}
              className="min-w-[150px] max-w-[min(92vw,480px)] w-max max-h-56 overflow-y-auto overflow-x-hidden rounded-[var(--radius-md)] border border-[color:var(--glass-border)] bg-[var(--glass-3-surface)] shadow-lg [scrollbar-width:none] [&::-webkit-scrollbar]:w-0 [&::-webkit-scrollbar]:h-0"
            >
              {slashOpen && filteredCommands.length === 0 && (
                <div className="px-2 py-1 text-[12px] leading-4 text-[var(--text-tertiary)] whitespace-nowrap">
                  {(meta?.availableCommands.length ?? 0) === 0
                    ? "等待 Agent 提供斜杠命令…"
                    : "没有匹配的命令"}
                </div>
              )}
              {slashOpen &&
                filteredCommands.map((c, i) => (
                  <button
                    key={c.name}
                    type="button"
                    data-suggest-index={i}
                    className={`block min-w-full text-left px-2 py-0.5 text-[12px] leading-4 whitespace-nowrap ${
                      i === suggestIndex ? "bg-[var(--overlay-active)]" : "hover:bg-[var(--glass-2-surface)]"
                    }`}
                    onMouseEnter={() => setSuggestIndex(i)}
                    onClick={() => pickCommand(c.name)}
                  >
                    <span className="font-mono text-[var(--accent)]">/{c.name}</span>
                  </button>
                ))}
              {atOpen && filteredAtResults.length === 0 && (
                <div className="px-2 py-1 text-[12px] leading-4 text-[var(--text-tertiary)] whitespace-nowrap">
                  搜索文件…
                </div>
              )}
              {atOpen &&
                filteredAtResults.map((hit, i) => {
                  const { name, dir } = mentionDisplayParts(hit.path, project?.path);
                  return (
                    <button
                      key={hit.path}
                      type="button"
                      data-suggest-index={i}
                      title={dir ? `${dir}${name}` : name}
                      className={`flex min-w-full items-center gap-1.5 text-left px-2 py-0.5 text-[12px] leading-4 whitespace-nowrap ${
                        i === suggestIndex ? "bg-[var(--overlay-active)]" : "hover:bg-[var(--glass-2-surface)]"
                      }`}
                      onMouseEnter={() => setSuggestIndex(i)}
                      onClick={() => pickFile(hit)}
                    >
                      <FileIcon filename={name} size={14} className="shrink-0" />
                      <span className="text-[var(--text-primary)] font-medium">{name}</span>
                      {dir ? (
                        <span className="text-[var(--text-tertiary)] truncate">{dir}</span>
                      ) : null}
                    </button>
                  );
                })}
            </div>
            {activeSlashCmd && (
              <div className="ml-1 min-w-[150px] w-[200px] max-h-56 overflow-y-auto overflow-x-hidden rounded-[var(--radius-md)] border border-[color:var(--glass-border)] bg-[var(--glass-2-surface)] shadow-lg px-2 py-1.5 text-[12px] leading-4 text-[var(--text-secondary)] [scrollbar-width:none] [&::-webkit-scrollbar]:w-0 [&::-webkit-scrollbar]:h-0">
                <div className="font-mono text-[var(--accent)] mb-1">/{activeSlashCmd.name}</div>
                <p className="leading-relaxed whitespace-pre-wrap">
                  {activeSlashCmd.description || "无描述"}
                </p>
                {activeSlashCmd.inputHint && (
                  <p className="mt-1 text-[var(--text-tertiary)]">用法：{activeSlashCmd.inputHint}</p>
                )}
              </div>
            )}
          </div>
        )}

        <div
          className="flex flex-col gap-1 rounded-[var(--radius-md)] bg-[var(--glass-3-surface)] border border-[color:var(--glass-border)] px-2.5 pt-2 pb-1.5 shadow-xs transition-[border-color,box-shadow] focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50"
          onClick={() => textareaRef.current?.focus()}
        >
          {images.length > 0 && (
            <div className="flex flex-wrap gap-1.5 px-0.5">
              {images.map((img) => (
                <span
                  key={img.id}
                  className="relative inline-flex rounded-[var(--radius-sm)] border border-[color:var(--border-subtle)] overflow-hidden"
                >
                  <button
                    type="button"
                    className="block"
                    title="预览图片"
                    onClick={(e) => {
                      e.stopPropagation();
                      setPreviewImage(img);
                    }}
                  >
                    <img src={img.previewUrl} alt="" className="h-14 w-14 object-cover" />
                  </button>
                  <button
                    type="button"
                    className="absolute top-0.5 right-0.5 rounded-full bg-black/55 text-white p-0.5"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (previewImage?.id === img.id) setPreviewImage(null);
                      removeImage(img.id);
                    }}
                    title="移除图片"
                  >
                    <X size={10} />
                  </button>
                </span>
              ))}
            </div>
          )}

          <TextEditContextMenu getTarget={() => textareaRef.current}>
            <Textarea
              ref={textareaRef}
              data-composer-input
              value={text}
              onChange={(e) => onChange(e.target.value)}
              onKeyDown={handleKeyDown}
              onCompositionStart={() => setImeComposing(true)}
              onCompositionEnd={() => setImeComposing(false)}
              onKeyUp={() => { if (slashOpen || atOpen) updateCaretAnchor(); }}
              onClick={() => { if (slashOpen || atOpen) updateCaretAnchor(); }}
              onPaste={handlePaste}
              placeholder={
                isStarting
                  ? "Agent 启动中…"
                  : activeTabId
                    ? "描述计划,@引用上下文,/使用命"
                    : "开始您的对话"
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
            <div className="relative" ref={plusMenuRef}>
              <Button
                variant="ghost"
                size="icon-sm"
                disabled={!activeTabId}
                title="添加图片或文件"
                className="rounded-full shrink-0"
                onClick={() => setPlusOpen((v) => !v)}
              >
                <Plus size={16} />
              </Button>
              {plusOpen && (
                <div className="absolute bottom-full left-0 mb-1 min-w-[140px] rounded-[var(--radius-md)] border border-[color:var(--glass-border)] bg-[var(--glass-3-surface)] shadow-lg py-1 z-30">
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 px-2.5 py-1.5 text-sm hover:bg-[var(--overlay-hover)]"
                    onClick={() => {
                      setPlusOpen(false);
                      imageInputRef.current?.click();
                    }}
                  >
                    <ImagePlus size={14} />
                    选择图片
                  </button>
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 px-2.5 py-1.5 text-sm hover:bg-[var(--overlay-hover)]"
                    onClick={() => void attachFilesFromDialog()}
                  >
                    <FilePlus size={14} />
                    引入文件
                  </button>
                </div>
              )}
              <input
                ref={imageInputRef}
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={(e) => {
                  const files = Array.from(e.target.files ?? []);
                  e.target.value = "";
                  if (files.length) void addImageFiles(files);
                }}
              />
            </div>

            {project && (
              <BranchSelector
                projectPath={project.path}
                open={branchOpen}
                onOpenChange={setBranchOpen}
              />
            )}

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

              {session?.sessionId && meta?.contextUsage && (
                <ContextUsageRing usage={meta.contextUsage} />
              )}

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

      <Dialog open={!!previewImage} onOpenChange={(open) => { if (!open) setPreviewImage(null); }}>
        <DialogContent
          className="max-w-[min(92vw,900px)] p-2 border-[color:var(--glass-border)] bg-[var(--glass-3-surface)]"
          showCloseButton
        >
          <DialogTitle className="sr-only">图片预览</DialogTitle>
          {previewImage && (
            <img
              src={previewImage.previewUrl}
              alt=""
              className="max-h-[80vh] w-full object-contain rounded-[var(--radius-sm)]"
            />
          )}
        </DialogContent>
      </Dialog>
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
