import { useState, useRef, useEffect, useCallback, useMemo, type CSSProperties } from "react";
import { Send, Square, X, Plus, ImagePlus, FilePlus } from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Button } from "@/components/ui/button";
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
import { ComposerGroupedOptionMenu } from "./ComposerGroupedOptionMenu";
import { ContextUsageRing, resolveContextRingUsage } from "./ContextUsageRing";
import { BranchSelector } from "../git/BranchSelector";
import { useGitStore } from "../../stores/git.store";
import { useDragDropStore } from "../../stores/dragDrop.store";
import { PlanBar } from "./thread/PlanBar";
import { PendingMessagesBar } from "./thread/PendingMessagesBar";
import {
  clearComposerDraft,
  loadComposerDraft,
  saveComposerDraft,
} from "../../stores/composerDrafts";
import { fuzzyFilter } from "./composerFuzzy";
import { setComposerSuggestOpen } from "./composerPanelState";
import { fileBasename, relativeToProject } from "../editor/pathUtils";
import FileIcon from "../files/FileIcon";
import type { AvailableCommand } from "./thread/types";
import { ComposerEditor, type ComposerEditorHandle } from "./ComposerEditor";
import {
  appendToken,
  hasToken,
  parseTokens,
  resolveTokenPath,
  tokenFor,
} from "./composerTokens";
import { registerComposerAttach } from "../../lib/composerAttach";
import { useOsDragDrop } from "../../lib/osDragDrop";
import { isOverComposer } from "../../lib/dropTargets";

interface PendingImage {
  id: string;
  mimeType: string;
  data: string;
  previewUrl: string;
}

/** Image payloads cross the invoke boundary as base64, so cap both their size
 * and count before allocating/retaining them in the composer. */
const MAX_COMPOSER_IMAGES = 4;
const MAX_COMPOSER_IMAGE_BYTES = 8 * 1024 * 1024;

/** Match `/query` at end of input (allows mid-message slash after whitespace). */
function matchSlashTrigger(value: string): { query: string; start: number } | null {
  const m = value.match(/(?:^|\s)\/([^\s]*)$/);
  if (!m) return null;
  const query = m[1] ?? "";
  const slashAt = value.lastIndexOf("/");
  return { query, start: slashAt };
}

function matchAtTrigger(value: string): { query: string } | null {
  // `[` is excluded: `@[` starts a literal file token, not a picker trigger.
  const m = value.match(/(?:^|\s)@([^\s@[]*)$/);
  if (!m) return null;
  return { query: m[1] ?? "" };
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

function isImeKeyEvent(e: globalThis.KeyboardEvent): boolean {
  // keyCode 229 = browser still composing (common on macOS Chinese IME).
  return e.isComposing || e.keyCode === 229;
}

export function AgentComposer() {
  const [text, setText] = useState("");
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
  // A tree file is being pointer-dragged over the composer (drop = attach).
  const composerDropHover = useDragDropStore((s) => s.overComposer);
  // An OS file drag is hovering the composer (drop = attach as token).
  const [osDropHover, setOsDropHover] = useState(false);
  const editorRef = useRef<ComposerEditorHandle>(null);
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

  const contextStatsByConversation = useAgentStore((s) => s.contextStatsByConversation);
  const session = activeTabId ? sessions[activeTabId] : null;
  const meta = activeTabId ? metaByConversation[activeTabId] : null;
  const contextStats = activeTabId ? contextStatsByConversation[activeTabId] : undefined;
  const contextRingUsage = resolveContextRingUsage(meta?.contextUsage, contextStats);
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
  // Allow/Menu is Cursor-only: other ACP agents use session/request_permission
  // without this composer toggle. Native NexAgent has its own auto mode.
  const showAuthMode = activeConversation?.agent_type === "cursor";
  const authMode =
    (activeTabId ? sessionPrefsByConversation[activeTabId]?.authMode : undefined) ?? "menu";
  // NexAgent advertises vision per model; unknown (external agents) stays allowed.
  const modelSupportsVision = (() => {
    if (!meta?.currentModelId) return true;
    const m = meta.models.find((x) => x.id === meta.currentModelId);
    if (!m || m.vision === undefined) return true;
    return m.vision;
  })();

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
        saveComposerDraft(tab, {
          text: textRef.current,
          mentions: [],
          images: imagesRef.current.map(toDraftImage),
        });
      }
      for (const img of imagesRef.current) URL.revokeObjectURL(img.previewUrl);
    };
  }, []);

  useEffect(() => {
    const prev = draftTabRef.current;
    if (prev && prev !== activeTabId) {
      saveComposerDraft(prev, {
        text: textRef.current,
        mentions: [],
        images: imagesRef.current.map(toDraftImage),
      });
    }
    draftTabRef.current = activeTabId;
    const draft = activeTabId ? loadComposerDraft(activeTabId) : null;
    const draftText = draft?.text ?? "";
    setText(draftText);
    editorRef.current?.setText(draftText);
    setSlashOpen(false);
    setAtOpen(false);
    setSlashQuery("");
    setAtQuery("");
    setAtResults([]);
    setSuggestIndex(0);
    setPlusOpen(false);
    setImeComposing(false);
    setPreviewImage(null);
    setImages((prevImgs) => {
      for (const img of prevImgs) URL.revokeObjectURL(img.previewUrl);
      return (draft?.images ?? []).map(fromDraftImage);
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
    if (!modelSupportsVision) return;
    const next: PendingImage[] = [];
    for (const file of files) {
      if (!file.type.startsWith("image/")) continue;
      if (file.size > MAX_COMPOSER_IMAGE_BYTES) continue;
      if (imagesRef.current.length + next.length >= MAX_COMPOSER_IMAGES) break;
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
    if (next.length > 0) {
      setImages((prev) => [...prev, ...next].slice(0, MAX_COMPOSER_IMAGES));
    }
  }, [modelSupportsVision]);

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
        : descriptor?.kind === "native"
          ? { type: "native" }
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
    setCaretPos(editorRef.current?.coordsAtCursor() ?? null);
  }, []);

  /** Append file tokens (tree drag / OS drop / dialog) — dedupes by path. */
  const insertFilePaths = useCallback((paths: string[]) => {
    const ed = editorRef.current;
    if (!ed) return;
    const projPath = useProjectStore.getState().projects.find(
      (p) => p.id === useProjectStore.getState().activeProjectId,
    )?.path;
    let next = ed.getText();
    for (const p of paths) {
      if (typeof p === "string" && p.length > 0) next = appendToken(next, p, projPath);
    }
    ed.setText(next);
    ed.selectEnd();
    ed.focus();
  }, []);

  // Tree pointer-drags call attachToComposer(paths) → lands here as tokens.
  useEffect(() => {
    registerComposerAttach(insertFilePaths);
    return () => registerComposerAttach(null);
  }, [insertFilePaths]);

  // OS file drag into the composer (Tauri event stream; HTML5 drops are dead
  // with dragDropEnabled on Windows).
  useOsDragDrop((e) => {
    if (e.type === "leave") {
      setOsDropHover(false);
      return;
    }
    const over = isOverComposer(e);
    if (e.type === "drop") {
      setOsDropHover(false);
      if (over && e.paths && e.paths.length > 0) insertFilePaths(e.paths);
      return;
    }
    setOsDropHover((v) => (v === over ? v : over));
  });

  const handleSend = async () => {
    if ((!text.trim() && images.length === 0) || !activeTabId) return;
    // Raw document text (with `@[path]` tokens) is what the bubble shows and
    // the agent receives; attachments are parsed from the same tokens.
    const content = text;
    const fileMentions = parseTokens(content);
    const pendingImages = [...images];
    setText("");
    editorRef.current?.setText("");
    setImages([]);
    setPreviewImage(null);
    clearComposerDraft(activeTabId);
    for (const img of pendingImages) URL.revokeObjectURL(img.previewUrl);
    setSlashOpen(false);
    setAtOpen(false);

    const threadImages = pendingImages.map((img) => ({
      mimeType: img.mimeType,
      data: img.data,
    }));

    const blocks: PromptBlock[] = [];
    if (content.trim()) blocks.push({ type: "text", text: content });
    for (const img of pendingImages) {
      blocks.push({ type: "image", data: img.data, mime_type: img.mimeType });
    }
    for (const m of fileMentions) {
      // Tokens store project-relative paths when possible — resolve to
      // absolute for the backend read / file URI.
      const absPath = resolveTokenPath(m.path, project?.path);
      try {
        const file = await fsReadFile(absPath);
        if (file.is_text && file.content != null) {
          blocks.push({
            type: "resource",
            uri: pathToFileUri(absPath),
            mime_type: "text/plain",
            text: file.content,
          });
        } else {
          blocks.push({ type: "resource_link", uri: pathToFileUri(absPath), name: m.name });
        }
      } catch {
        blocks.push({ type: "resource_link", uri: pathToFileUri(absPath), name: m.name });
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

    // 会话启动中/忙碌：只进等待发送列表，真正执行时再写入对话框。
    const live = useAgentStore.getState().sessions[activeTabId];
    const queueBecauseBusy =
      live?.status === "starting" ||
      live?.status === "running" ||
      live?.status === "waiting";
    if (queueBecauseBusy) {
      enqueuePendingMessage(activeTabId, blocks, content, threadImages);
      if (live?.status === "starting") {
        void useAgentStore.getState().processNextPending(activeTabId);
      }
      return;
    }

    appendUserMessage(activeTabId, content, threadImages);
    autoTitleFromFirstMessage(
      activeTabId,
      content.trim() || (threadImages.length > 0 ? "图片" : content),
    );

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

  const handlePaste = (e: globalThis.ClipboardEvent) => {
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
    const ed = editorRef.current;
    if (!ed) return;
    const current = ed.getText();
    const slash = matchSlashTrigger(current);
    const next = slash ? `${current.slice(0, slash.start)}/${name} ` : `/${name} `;
    ed.setText(next);
    ed.focus();
    setSlashOpen(false);
    setSlashQuery("");
  };

  const pickFile = (hit: SearchMatch) => {
    const ed = editorRef.current;
    if (!ed) return;
    if (hasToken(ed.getText(), hit.path, project?.path)) {
      // Already referenced — just erase the typed `@query`.
      ed.replaceAtTrigger("");
    } else {
      // Replace the typed `@query` with the inline token (`@[path] `).
      ed.replaceAtTrigger(`${tokenFor(hit.path, project?.path)} `);
    }
    setAtOpen(false);
    setAtQuery("");
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

  // Runs from CM6 domEventHandlers BEFORE keymaps: return true when consumed
  // (stops the editor); false lets CM6 apply its default (caret, newline…).
  const handleEditorKeyDown = (e: globalThis.KeyboardEvent): boolean => {
    // Let the IME consume keys while composing (Enter confirms pinyin, arrows
    // move IME candidates). Sending / picking here would truncate Chinese input.
    if (imeComposing || isImeKeyEvent(e)) return false;

    const nav = suggestNavRef.current;
    const menuActive = nav.slashOpen || nav.atOpen;
    const count = nav.slashOpen ? nav.commandCount : nav.atOpen ? nav.atCount : 0;

    if (menuActive && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      if (count === 0) return true;
      setSuggestIndex((i) => {
        if (e.key === "ArrowDown") return (i + 1) % count;
        return (i - 1 + count) % count;
      });
      return true;
    }
    if (menuActive && (e.key === "Enter" || e.key === "Tab")) {
      if (count > 0) {
        e.preventDefault();
        applySuggest();
        return true;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        // Empty menu: don't send either while trigger is open with zero hits.
        e.preventDefault();
        return true;
      }
      return false;
    }
    if (e.key === "Enter" && !e.shiftKey && !nav.slashOpen && !nav.atOpen) {
      e.preventDefault();
      void handleSend();
      return true;
    }
    if (e.key === "Escape") {
      setSlashOpen(false);
      setAtOpen(false);
      setPlusOpen(false);
      return true;
    }
    return false;
  };

  // CM6 → React mirror. File mentions live in the text itself as `@[path]`
  // tokens, so there is no separate mention state to keep in sync.
  const handleEditorChange = (value: string) => {
    setText(value);
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

  // Caret moved without a doc change — keep an open popover anchored.
  const handleEditorSelectionChange = () => {
    const nav = suggestNavRef.current;
    if (nav.slashOpen || nav.atOpen) updateCaretAnchor();
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
      insertFilePaths(paths.filter((p): p is string => typeof p === "string"));
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

      <div className="px-4 pb-3 relative" data-composer-dropzone>
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
              className="min-w-[150px] max-w-[min(92vw,480px)] w-max max-h-56 overflow-y-auto overflow-x-hidden rounded-[var(--radius-md)] border border-[color:var(--glass-border)] bg-[var(--card)] nex-elevated [scrollbar-width:none] [&::-webkit-scrollbar]:w-0 [&::-webkit-scrollbar]:h-0"
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
              <div className="ml-1 min-w-[150px] w-[200px] max-h-56 overflow-y-auto overflow-x-hidden rounded-[var(--radius-md)] border border-[color:var(--glass-border)] bg-[var(--glass-2-surface)] nex-elevated px-2 py-1.5 text-[12px] leading-4 text-[var(--text-secondary)] [scrollbar-width:none] [&::-webkit-scrollbar]:w-0 [&::-webkit-scrollbar]:h-0">
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
          className={`flex flex-col gap-1 rounded-[var(--radius-lg)] bg-[var(--glass-3-surface)] border border-[color:var(--glass-border)] px-3 pt-2.5 pb-1.5 shadow-[inset_0_1px_0_0_var(--edge-highlight)] transition-[border-color,box-shadow] duration-150 focus-within:border-[color:var(--accent)] focus-within:shadow-[inset_0_1px_0_0_var(--edge-highlight),0_0_0_3px_var(--accent-glow)]${
            composerDropHover || osDropHover
              ? " border-[color:var(--accent)] shadow-[inset_0_1px_0_0_var(--edge-highlight),0_0_0_3px_var(--accent-glow)]"
              : ""
          }`}
          onClick={() => editorRef.current?.focus()}
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

          <ComposerEditor
            ref={editorRef}
            initialText={text}
            placeholder={
              isStarting
                ? "Agent 启动中…"
                : activeTabId
                  ? "描述任务，@ 引用文件，/ 使用命令"
                  : "先新建或选择一个会话"
            }
            disabled={!activeTabId}
            onChange={handleEditorChange}
            onKeyDown={handleEditorKeyDown}
            onPaste={handlePaste}
            onCompositionStart={() => setImeComposing(true)}
            onCompositionEnd={() => setImeComposing(false)}
            onSelectionChange={handleEditorSelectionChange}
          />

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
                className="nex-interactive-chrome nex-pressable rounded-full shrink-0 border border-[color:var(--hairline-soft)] bg-[color:color-mix(in_srgb,var(--material-panel)_78%,transparent)] shadow-[inset_0_1px_0_0_var(--edge-highlight-soft)] hover:bg-[color:color-mix(in_srgb,var(--material-floating)_78%,transparent)]"
                onClick={() => setPlusOpen((v) => !v)}
              >
                <Plus size={16} />
              </Button>
              {plusOpen && (
                <div className="absolute bottom-full left-0 z-30 mb-1.5 min-w-[156px] rounded-[calc(var(--radius-md)+2px)] border border-[color:var(--hairline-soft)] nex-material-floating py-1.5">
                  <button
                    type="button"
                    className="nex-interactive-chrome flex w-full items-center gap-2 px-3 py-1.5 text-sm text-[var(--text-secondary)] hover:bg-[color:color-mix(in_srgb,var(--material-elevated)_86%,transparent)] hover:text-[var(--text-primary)] disabled:opacity-40"
                    disabled={!modelSupportsVision}
                    title={modelSupportsVision ? undefined : "当前模型不支持图片"}
                    onClick={() => {
                      if (!modelSupportsVision) return;
                      setPlusOpen(false);
                      imageInputRef.current?.click();
                    }}
                  >
                    <ImagePlus size={14} />
                    {modelSupportsVision ? "选择图片" : "选择图片（模型不支持）"}
                  </button>
                  <button
                    type="button"
                    className="nex-interactive-chrome flex w-full items-center gap-2 px-3 py-1.5 text-sm text-[var(--text-secondary)] hover:bg-[color:color-mix(in_srgb,var(--material-elevated)_86%,transparent)] hover:text-[var(--text-primary)]"
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
              {showAuthMode && activeTabId && (
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
              {session?.sessionId && contextRingUsage && (
                <ContextUsageRing usage={contextRingUsage} stats={contextStats} />
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
                      <ComposerGroupedOptionMenu
                        ariaLabel="Model"
                        value={meta.currentModelId ?? ""}
                        options={meta.models.map((m) => ({
                          id: m.id,
                          name: m.name,
                          group: m.description?.trim() || "其他",
                        }))}
                        onSelect={(id) => void setModel(session.sessionId, id)}
                      />
                    )}
                    {configOpts.map((opt) => {
                      const isModelOpt = opt.id === "model" || opt.category === "model";
                      if (isModelOpt) {
                        return (
                          <ComposerGroupedOptionMenu
                            key={opt.id}
                            ariaLabel={opt.name || opt.id}
                            value={opt.currentValueId}
                            options={opt.options.map((o) => ({
                              id: o.id,
                              name: o.name.includes("/") ? (o.name.split("/").pop() ?? o.name) : o.name,
                              group: o.name.includes("/")
                                ? (o.name.split("/")[0] ?? "其他")
                                : "模型",
                            }))}
                            onSelect={(id) => void setConfigOption(session.sessionId, opt.id, id)}
                          />
                        );
                      }
                      return (
                        <ComposerOptionMenu
                          key={opt.id}
                          ariaLabel={opt.name || opt.id}
                          value={opt.currentValueId}
                          options={opt.options.map((o) => ({ id: o.id, name: o.name }))}
                          onSelect={(id) => void setConfigOption(session.sessionId, opt.id, id)}
                        />
                      );
                    })}
                  </>
                );
              })()}

              {isRunning ? (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => session?.sessionId && void cancel(session.sessionId)}
                  title="Stop"
                  className="nex-interactive-chrome nex-pressable rounded-full shrink-0 border border-[color:var(--hairline-soft)] bg-[color:color-mix(in_srgb,var(--material-panel)_78%,transparent)] shadow-[inset_0_1px_0_0_var(--edge-highlight-soft)] hover:bg-[color:color-mix(in_srgb,var(--material-floating)_78%,transparent)]"
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
                  className="rounded-full shrink-0 border border-[color:var(--hairline-soft)] shadow-[inset_0_1px_0_0_rgba(255,255,255,0.18)]"
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

function toDraftImage(img: PendingImage): { id: string; mimeType: string; data: string } {
  return { id: img.id, mimeType: img.mimeType, data: img.data };
}

/** Rebuild a blob preview URL from the persisted base64 payload. */
function fromDraftImage(img: { id: string; mimeType: string; data: string }): PendingImage {
  return {
    id: img.id,
    mimeType: img.mimeType,
    data: img.data,
    previewUrl: base64ToObjectUrl(img.mimeType, img.data),
  };
}

function base64ToObjectUrl(mimeType: string, data: string): string {
  try {
    const binary = atob(data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return URL.createObjectURL(new Blob([bytes], { type: mimeType || "image/png" }));
  } catch {
    // Fall back so a corrupt draft still shows something in the strip.
    return `data:${mimeType || "image/png"};base64,${data}`;
  }
}
