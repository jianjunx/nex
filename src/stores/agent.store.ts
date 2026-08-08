import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { persist } from "zustand/middleware";
import type { UnlistenFn } from "@tauri-apps/api/event";
import {
  agentCreateSession,
  agentSendPrompt,
  agentCancel,
  agentRespondPermission,
  agentRespondPlan,
  agentRespondAskQuestion,
  agentCloseSession,
  agentListServers,
  agentListAllServers,
  agentRefreshRegistry,
  agentCustomUpsert,
  agentCustomDelete,
  agentSetSessionMode,
  agentSetSessionModel,
  agentSetSessionConfigOption,
  conversationReplaceThreadEntries,
  nativeAgentGetConfig,
  onAgentNotification,
  onAgentPermissionRequest,
  onAgentPlanApprovalRequest,
  onAgentAskQuestionRequest,
  onAgentSessionTerminated,
  type PromptBlock,
  type ServerDescriptor,
  type SessionTarget,
  type CustomServer,
  type CreateSessionResult,
} from "../bridge/tauri";
import type {
  AgentAskQuestionRequestPayload,
  AgentPermissionRequestPayload,
  AgentPlanApprovalRequestPayload,
  AskQuestionAnswerPayload,
} from "../bridge/events";
import { pickAllowOptionId } from "../features/agent/pickAllowOptionId";
import {
  applyPermissionRequestToEntries,
  applySessionUpdate,
  emptySessionMeta,
} from "../features/agent/thread/applySessionUpdate";
import { assistantTextAfterLastUser } from "../features/agent/thread/messagesToThreadEntries";
import type { SessionMeta, ThreadEntry } from "../features/agent/thread/types";
import { useConversationStore } from "./conversation.store";
import { useNotificationStore } from "./notification.store";

export interface AgentSession {
  sessionId: string;
  conversationId: string;
  status: "starting" | "idle" | "running" | "waiting";
}

/** A user message that was queued because the session is starting or busy. */
export interface PendingMessage {
  id: string;
  blocks: PromptBlock[];
  /** 真正发送时才写入会话气泡的文本/图片（入队时不进对话框）。 */
  text: string;
  images?: { mimeType: string; data: string }[];
}

/** Build a short preview string from a list of PromptBlock for display. */
export function pendingMessagePreview(blocks: PromptBlock[]): string {
  const textBlock = blocks.find((b) => b.type === "text") as { type: "text"; text: string } | undefined;
  const imageCount = blocks.filter((b) => b.type === "image").length;
  const hasResource = blocks.some((b) => b.type === "resource" || b.type === "resource_link");

  let preview = textBlock?.text ?? "";
  if (imageCount > 0) preview += (preview ? " " : "") + `[图片 ×${imageCount}]`;
  if (hasResource) preview += (preview ? " " : "") + "[文件]";
  return preview.trim() || "(empty)";
}

/** 真正发送前：把排队消息写入会话气泡（入队时故意不写）。 */
function deliverPendingUserBubble(
  appendUserMessage: (
    conversationId: string,
    text: string,
    images?: { mimeType: string; data: string }[],
  ) => void,
  conversationId: string,
  pending: PendingMessage,
): void {
  appendUserMessage(conversationId, pending.text, pending.images);
  const titleSrc =
    pending.text.trim() ||
    (pending.images && pending.images.length > 0 ? "图片" : pending.text);
  useConversationStore.getState().autoTitleFromFirstMessage(conversationId, titleSrc);
}

export type AuthMode = "allow" | "menu";

/** Per-conversation composer choices restored after ACP session recreate. */
export interface SessionPrefs {
  modeId?: string;
  modelId?: string;
  configValues?: Record<string, string>;
  authMode?: AuthMode;
}

interface AgentStore {
  sessions: Record<string, AgentSession>;
  entriesByConversation: Record<string, ThreadEntry[]>;
  metaByConversation: Record<string, SessionMeta>;
  /** Persisted mode/model/config/auth choices keyed by conversation id. */
  sessionPrefsByConversation: Record<string, SessionPrefs>;
  permissionQueues: Record<string, AgentPermissionRequestPayload[]>;
  pendingPermission: AgentPermissionRequestPayload | null;
  /** Shown on a tool card — exclude from PermissionModal fallback. */
  inlinePermissionIds: Record<string, true>;
  planApprovalQueues: Record<string, AgentPlanApprovalRequestPayload[]>;
  pendingPlanApproval: AgentPlanApprovalRequestPayload | null;
  askQuestionQueues: Record<string, AgentAskQuestionRequestPayload[]>;
  pendingAskQuestion: AgentAskQuestionRequestPayload | null;
  /** Pending user messages waiting for session to become available (starting → idle) or current task to finish. */
  pendingMessagesByConversation: Record<string, PendingMessage[]>;
  servers: ServerDescriptor[];
  loading: boolean;
  serversLoading: boolean;
  /** 上次 loadAllServers 尝试（成败均计）的时间戳（0＝从未尝试）。失败也打点，防守卫以 IPC 为节拍自激重试；手动重试走 refreshRegistry。 */
  serversLoadedAt: number;
  error: string | null;

  createSession: (conversationId: string, target: SessionTarget, cwd: string) => Promise<string>;
  removeSession: (conversationId: string) => Promise<void>;
  /** Replace in-memory thread with hydrated history (used on cold restore). */
  hydrateEntries: (conversationId: string, entries: ThreadEntry[]) => void;
  /** Best-effort persist of all in-memory thread snapshots (window close / quit). */
  flushThreadSnapshots: () => Promise<void>;
  /** Drop hydrated thread entries for conversation ids not in `keepIds` (switch-project memory). */
  pruneEntriesExcept: (keepIds: Set<string>) => void;
  appendUserMessage: (
    conversationId: string,
    text: string,
    images?: { mimeType: string; data: string }[],
  ) => void;
  sendPrompt: (sessionId: string, blocks: PromptBlock[]) => Promise<void>;
  cancel: (sessionId: string) => Promise<void>;
  respondPermission: (requestId: string, optionId: string | null) => Promise<void>;
  respondPlan: (
    requestId: string,
    outcome: "accepted" | "rejected" | "cancelled",
    reason?: string | null,
  ) => Promise<void>;
  respondAskQuestion: (
    requestId: string,
    outcome: "answered" | "skipped" | "cancelled",
    answers?: AskQuestionAnswerPayload[] | null,
    reason?: string | null,
  ) => Promise<void>;
  setMode: (
    sessionId: string,
    modeId: string,
    opts?: { skipConfirm?: boolean },
  ) => Promise<void>;
  setModel: (sessionId: string, modelId: string) => Promise<void>;
  setConfigOption: (sessionId: string, configId: string, value: string) => Promise<void>;
  setAuthMode: (conversationId: string, authMode: AuthMode) => void;
  /** Cached from nex-agent.json; used to chain `/review` after mutating turns. */
  nativeAutoReview: boolean;
  /** Refresh `nativeAutoReview` from disk (call after settings save). */
  refreshNativeAutoReview: () => Promise<void>;
  /** Queue a message for later sending when the session is starting or busy. */
  enqueuePendingMessage: (
    conversationId: string,
    blocks: PromptBlock[],
    text: string,
    images?: { mimeType: string; data: string }[],
  ) => string;
  /** Remove a specific queued message (user dismissed it). */
  removePendingMessage: (conversationId: string, messageId: string) => void;
  /** Cancel current task and immediately send a specific queued message. */
  sendPendingNow: (conversationId: string, messageId: string) => Promise<void>;
  /** Dequeue and send the oldest pending message for a conversation, if the session is idle. */
  processNextPending: (conversationId: string) => Promise<void>;
  loadServers: () => Promise<void>;
  /** Settings: whitelist + custom + other registry agents. */
  loadAllServers: () => Promise<void>;
  refreshRegistry: () => Promise<void>;
  upsertCustom: (server: CustomServer) => Promise<void>;
  deleteCustom: (id: string) => Promise<void>;
  initListeners: () => () => void;
}

function errorMessage(err: unknown): string {
  if (err && typeof err === "object" && "message" in err && typeof (err as { message: unknown }).message === "string") {
    return (err as { message: string }).message;
  }
  return String(err);
}

let listenerTeardown: (() => void) | null = null;

function nextPendingPermission(
  queues: Record<string, AgentPermissionRequestPayload[]>,
  inlineIds: Record<string, true>,
): AgentPermissionRequestPayload | null {
  for (const queue of Object.values(queues)) {
    for (const item of queue) {
      if (!inlineIds[item.requestId]) return item;
    }
  }
  return null;
}

function nextPendingPlanApproval(
  queues: Record<string, AgentPlanApprovalRequestPayload[]>,
): AgentPlanApprovalRequestPayload | null {
  for (const queue of Object.values(queues)) {
    if (queue.length > 0) return queue[0];
  }
  return null;
}

function nextPendingAskQuestion(
  queues: Record<string, AgentAskQuestionRequestPayload[]>,
): AgentAskQuestionRequestPayload | null {
  for (const queue of Object.values(queues)) {
    if (queue.length > 0) return queue[0];
  }
  return null;
}

function sessionStillWaiting(
  s: {
    permissionQueues: Record<string, AgentPermissionRequestPayload[]>;
    planApprovalQueues: Record<string, AgentPlanApprovalRequestPayload[]>;
    askQuestionQueues: Record<string, AgentAskQuestionRequestPayload[]>;
  },
  sessionId: string,
): boolean {
  return (
    (s.permissionQueues[sessionId] ?? []).length > 0 ||
    (s.planApprovalQueues[sessionId] ?? []).length > 0 ||
    (s.askQuestionQueues[sessionId] ?? []).length > 0
  );
}

/** After Cursor plan accept: leave plan/ask for an executable mode and continue. */
async function handoffPlanToExecute(
  get: () => AgentStore,
  set: (fn: (s: AgentStore) => void) => void,
  sessionId: string,
  conversationId: string,
): Promise<void> {
  const meta = get().metaByConversation[conversationId];
  const current = meta?.currentModeId ?? "";
  if (current === "plan" || current === "ask") {
    const preferred = ["agent", "code", "auto"] as const;
    const execMode =
      preferred.find((id) => meta?.modes.some((m) => m.id === id)) ??
      meta?.modes.find((m) => m.id !== "plan" && m.id !== "ask")?.id;
    if (execMode) {
      try {
        await agentSetSessionMode(sessionId, execMode);
        set((s) => {
          const m = s.metaByConversation[conversationId];
          if (m) m.currentModeId = execMode;
        });
        patchPrefs(set, conversationId, { modeId: execMode });
      } catch (err) {
        set((s) => {
          s.error = errorMessage(err);
        });
      }
    }
  }

  const continueText = "计划已确认，请开始执行。";
  const blocks: PromptBlock[] = [{ type: "text", text: continueText }];
  const session = get().sessions[conversationId];
  if (!session || session.sessionId !== sessionId) return;

  // If the create_plan turn is still finishing, queue; otherwise send now.
  if (session.status === "idle") {
    get().appendUserMessage(conversationId, continueText);
    await get().sendPrompt(sessionId, blocks);
  } else {
    get().enqueuePendingMessage(conversationId, blocks, continueText);
  }
}

function applyCreateMeta(result: CreateSessionResult): SessionMeta {
  const meta = emptySessionMeta();
  if (result.modes) {
    meta.currentModeId = result.modes.currentModeId;
    meta.modes = result.modes.availableModes.map((m) => ({
      id: m.id,
      name: m.name,
      description: m.description ?? undefined,
    }));
  }
  if (result.models) {
    meta.currentModelId = result.models.currentModelId;
    meta.models = result.models.availableModels.map((m) => ({
      id: m.id,
      name: m.name,
      description: m.description ?? undefined,
      vision: typeof m.vision === "boolean" ? m.vision : undefined,
    }));
  }
  if (result.configOptions && result.configOptions.length > 0) {
    meta.configOptions = result.configOptions.map((o) => ({
      id: o.id,
      name: o.name,
      category: o.category ?? undefined,
      currentValueId: o.currentValueId,
      options: o.options.map((x) => ({ id: x.id, name: x.name })),
    }));
  }
  if (result.availableCommands && result.availableCommands.length > 0) {
    meta.availableCommands = result.availableCommands.map((c) => ({
      name: c.name,
      description: c.description,
      inputHint: c.inputHint ?? undefined,
    }));
  }
  return meta;
}

function clearToolWaiting(entries: ThreadEntry[], requestId: string): void {
  for (const e of entries) {
    if (e.kind === "tool_call" && e.permissionRequestId === requestId) {
      e.status = e.status === "waiting_for_confirmation" ? "in_progress" : e.status;
      e.options = undefined;
      e.permissionRequestId = undefined;
    }
  }
}

function patchPrefs(
  set: (fn: (s: AgentStore) => void) => void,
  conversationId: string,
  patch: Partial<SessionPrefs>,
): void {
  set((s) => {
    const prev = s.sessionPrefsByConversation[conversationId] ?? {};
    s.sessionPrefsByConversation[conversationId] = { ...prev, ...patch };
  });
}

/**
 * Notifications that arrive before `createSession` finishes registering the
 * live `sessionId` (classic race for `available_commands_update`). Flushed in
 * [`flushPendingNotifications`].
 */
const pendingNotificationsBySessionId = new Map<string, unknown[]>();
/** Cap per sessionId so a stuck/orphan agent cannot grow the buffer unboundedly. */
const MAX_PENDING_UPDATES_PER_SESSION = 8;

/** Only meta catalogs that must survive the create-session race. Drop stream chunks. */
function isBufferableSessionUpdate(update: unknown): boolean {
  if (!update || typeof update !== "object") return false;
  const kind = (update as { sessionUpdate?: unknown }).sessionUpdate;
  return (
    kind === "available_commands_update" ||
    kind === "current_mode_update" ||
    kind === "config_option_update"
  );
}

function sessionCreateInFlight(get: () => AgentStore): boolean {
  return Object.values(get().sessions).some(
    (ss) => ss.status === "starting" || ss.sessionId === "",
  );
}

/** Drop buffered updates when no create is in flight (failed create / stale ids). */
function pruneStalePendingNotifications(get: () => AgentStore): void {
  if (sessionCreateInFlight(get)) return;
  pendingNotificationsBySessionId.clear();
}

function enqueuePendingNotification(sessionId: string, update: unknown, get: () => AgentStore): void {
  pruneStalePendingNotifications(get);
  if (!sessionCreateInFlight(get)) return;
  if (!isBufferableSessionUpdate(update)) return;
  const q = pendingNotificationsBySessionId.get(sessionId) ?? [];
  if (q.length >= MAX_PENDING_UPDATES_PER_SESSION) return;
  q.push(update);
  pendingNotificationsBySessionId.set(sessionId, q);
}

function applyNotificationUpdate(
  set: (fn: (s: AgentStore) => void) => void,
  get: () => AgentStore,
  sessionId: string,
  update: unknown,
): void {
  const session = Object.values(get().sessions).find((ss) => ss.sessionId === sessionId);
  if (!session) return;
  let modeFromAgent: string | null = null;
  set((s) => {
    if (!s.entriesByConversation[session.conversationId]) {
      s.entriesByConversation[session.conversationId] = [];
    }
    if (!s.metaByConversation[session.conversationId]) {
      s.metaByConversation[session.conversationId] = emptySessionMeta();
    }
    const entries = s.entriesByConversation[session.conversationId];
    const meta = s.metaByConversation[session.conversationId];
    const prevMode = meta.currentModeId;
    const applied = applySessionUpdate(entries, meta, update);
    if (applied.completedPlanSnapshot) {
      entries.push({
        id: crypto.randomUUID(),
        kind: "completed_plan",
        timestamp: Date.now(),
        entries: applied.completedPlanSnapshot,
      });
    }
    if (applied.metaChanged && meta.currentModeId && meta.currentModeId !== prevMode) {
      modeFromAgent = meta.currentModeId;
    }
  });
  if (modeFromAgent) {
    patchPrefs(set, session.conversationId, { modeId: modeFromAgent });
  }
}

function flushPendingNotifications(
  set: (fn: (s: AgentStore) => void) => void,
  get: () => AgentStore,
  sessionId: string,
): void {
  const pending = pendingNotificationsBySessionId.get(sessionId);
  if (!pending?.length) return;
  pendingNotificationsBySessionId.delete(sessionId);
  for (const update of pending) {
    applyNotificationUpdate(set, get, sessionId, update);
  }
}

function clearPrefKey(
  set: (fn: (s: AgentStore) => void) => void,
  conversationId: string,
  key: keyof SessionPrefs,
): void {
  set((s) => {
    const prev = s.sessionPrefsByConversation[conversationId];
    if (!prev) return;
    const next = { ...prev };
    delete next[key];
    if (Object.keys(next).length === 0) delete s.sessionPrefsByConversation[conversationId];
    else s.sessionPrefsByConversation[conversationId] = next;
  });
}

function clearConfigPref(
  set: (fn: (s: AgentStore) => void) => void,
  conversationId: string,
  configId: string,
): void {
  set((s) => {
    const prev = s.sessionPrefsByConversation[conversationId];
    if (!prev?.configValues?.[configId]) return;
    const configValues = { ...prev.configValues };
    delete configValues[configId];
    const next: SessionPrefs = { ...prev, configValues };
    if (Object.keys(configValues).length === 0) delete next.configValues;
    if (Object.keys(next).length === 0) delete s.sessionPrefsByConversation[conversationId];
    else s.sessionPrefsByConversation[conversationId] = next;
  });
}

/** Re-apply saved composer choices after ACP session/new. Invalid ids are dropped quietly. */
async function restorePrefsToLiveSession(
  set: (fn: (s: AgentStore) => void) => void,
  get: () => AgentStore,
  conversationId: string,
  sessionId: string,
): Promise<void> {
  const prefs = get().sessionPrefsByConversation[conversationId];
  if (!prefs) return;
  const meta = get().metaByConversation[conversationId];
  if (!meta) return;

  if (prefs.modeId && prefs.modeId !== meta.currentModeId) {
    const inModes = meta.modes.some((m) => m.id === prefs.modeId);
    const modeOpt = meta.configOptions.find((o) => o.id === "mode" || o.category === "mode");
    const inConfig = modeOpt?.options.some((o) => o.id === prefs.modeId) ?? false;
    if (inModes || inConfig) {
      try {
        await agentSetSessionMode(sessionId, prefs.modeId);
        set((s) => {
          const m = s.metaByConversation[conversationId];
          if (m) m.currentModeId = prefs.modeId!;
        });
      } catch {
        clearPrefKey(set, conversationId, "modeId");
      }
    } else {
      clearPrefKey(set, conversationId, "modeId");
    }
  }

  if (prefs.modelId && prefs.modelId !== meta.currentModelId) {
    const inModels = meta.models.some((m) => m.id === prefs.modelId);
    const modelOpt = meta.configOptions.find((o) => o.id === "model" || o.category === "model");
    const inConfig = modelOpt?.options.some((o) => o.id === prefs.modelId) ?? false;
    if (inModels || inConfig) {
      try {
        // Must apply returned configOptions — native agent refreshes reasoning
        // levels for the restored model; discarding them hides the Composer menu.
        const next = await agentSetSessionModel(sessionId, prefs.modelId);
        set((s) => {
          const m = s.metaByConversation[conversationId];
          if (!m) return;
          m.currentModelId = prefs.modelId!;
          if (next) {
            m.configOptions = next.map((o) => ({
              id: o.id,
              name: o.name,
              category: o.category ?? undefined,
              currentValueId: o.currentValueId,
              options: o.options.map((x) => ({ id: x.id, name: x.name })),
            }));
          }
        });
      } catch {
        clearPrefKey(set, conversationId, "modelId");
      }
    } else {
      clearPrefKey(set, conversationId, "modelId");
    }
  }

  const configValues = prefs.configValues ?? {};
  for (const [configId, valueId] of Object.entries(configValues)) {
    const opt = meta.configOptions.find((o) => o.id === configId);
    if (!opt || !opt.options.some((o) => o.id === valueId) || opt.currentValueId === valueId) {
      if (!opt || !opt.options.some((o) => o.id === valueId)) {
        clearConfigPref(set, conversationId, configId);
      }
      continue;
    }
    try {
      const next = await agentSetSessionConfigOption(sessionId, configId, valueId);
      set((s) => {
        const m = s.metaByConversation[conversationId];
        if (!m) return;
        if (next && next.length > 0) {
          m.configOptions = next.map((o) => ({
            id: o.id,
            name: o.name,
            category: o.category ?? undefined,
            currentValueId: o.currentValueId,
            options: o.options.map((x) => ({ id: x.id, name: x.name })),
          }));
        } else {
          const local = m.configOptions.find((o) => o.id === configId);
          if (local) local.currentValueId = valueId;
        }
      });
    } catch {
      clearConfigPref(set, conversationId, configId);
    }
  }
}

export const useAgentStore = create<AgentStore>()(
  persist(
    immer((set, get) => ({
    sessions: {},
    entriesByConversation: {},
    metaByConversation: {},
    sessionPrefsByConversation: {},
    permissionQueues: {},
    pendingPermission: null,
    inlinePermissionIds: {},
    planApprovalQueues: {},
    pendingPlanApproval: null,
    askQuestionQueues: {},
    pendingAskQuestion: null,
    pendingMessagesByConversation: {},
    servers: [],
    loading: false,
    serversLoading: false,
    serversLoadedAt: 0,
    error: null,
    nativeAutoReview: false,

    createSession: async (conversationId, target, cwd) => {
      set((s) => {
        s.loading = true;
        s.error = null;
        s.sessions[conversationId] = {
          sessionId: "",
          conversationId,
          status: "starting",
        };
        if (!s.entriesByConversation[conversationId]) s.entriesByConversation[conversationId] = [];
      });
      try {
        const result = await agentCreateSession(conversationId, target, cwd);
        set((s) => {
          s.sessions[conversationId] = {
            sessionId: result.sessionId,
            conversationId,
            status: "idle",
          };
          if (!s.entriesByConversation[conversationId]) s.entriesByConversation[conversationId] = [];
          s.metaByConversation[conversationId] = applyCreateMeta(result);
        });
        // Drain commands/mode updates that raced ahead of the sessionId mapping.
        flushPendingNotifications(set, get, result.sessionId);
        pruneStalePendingNotifications(get);
        await restorePrefsToLiveSession(set, get, conversationId, result.sessionId);
        // Auto-process any messages queued while the session was starting
        void get().processNextPending(conversationId);
        return result.sessionId;
      } catch (err) {
        set((s) => {
          delete s.sessions[conversationId];
          s.error = errorMessage(err);
        });
        pruneStalePendingNotifications(get);
        throw err;
      } finally {
        set((s) => {
          s.loading = false;
        });
      }
    },

    removeSession: async (conversationId) => {
      const session = get().sessions[conversationId];
      if (!session) return;
      set((s) => {
        s.error = null;
      });
      try {
        if (session.sessionId) await agentCloseSession(session.sessionId);
      } catch (err) {
        set((s) => {
          s.error = errorMessage(err);
        });
      } finally {
        set((s) => {
          delete s.sessions[conversationId];
          delete s.entriesByConversation[conversationId];
          delete s.metaByConversation[conversationId];
          // Drop queued-but-unsent messages and any permission queues so a
          // removed conversation leaves no orphaned state behind.
          delete s.pendingMessagesByConversation[conversationId];
          const liveSessionId = session.sessionId;
          if (liveSessionId) {
            pendingNotificationsBySessionId.delete(liveSessionId);
            // Drop inline-permission markers belonging to this session's queue.
            for (const req of s.permissionQueues[liveSessionId] ?? []) {
              delete s.inlinePermissionIds[req.requestId];
            }
            delete s.permissionQueues[liveSessionId];
            delete s.planApprovalQueues[liveSessionId];
            delete s.askQuestionQueues[liveSessionId];
            if (s.pendingPermission?.sessionId === liveSessionId) {
              s.pendingPermission = nextPendingPermission(s.permissionQueues, s.inlinePermissionIds);
            }
            if (s.pendingPlanApproval?.sessionId === liveSessionId) {
              s.pendingPlanApproval = nextPendingPlanApproval(s.planApprovalQueues);
            }
            if (s.pendingAskQuestion?.sessionId === liveSessionId) {
              s.pendingAskQuestion = nextPendingAskQuestion(s.askQuestionQueues);
            }
          }
        });
      }
    },

    hydrateEntries: (conversationId, entries) => {
      set((s) => {
        // Mid-turn / live ACP session: in-memory thread is ahead of DB.
        // Switching projects must not clobber streaming tool cards with a
        // stale hydrate from disk. Guard only when the in-memory thread is
        // non-empty: on cold restart the composer auto-spawns a "starting"
        // session with an EMPTY thread, and refusing the hydrate there would
        // leave the conversation blank until the user revisits it.
        const live = s.sessions[conversationId];
        const current = s.entriesByConversation[conversationId];
        if (
          live &&
          (live.status === "running" ||
            live.status === "waiting" ||
            live.status === "starting") &&
          (current?.length ?? 0) > 0
        ) {
          return;
        }
        s.entriesByConversation[conversationId] = entries;
      });
    },

    flushThreadSnapshots: async () => {
      // Closing mid-turn loses everything since the last completed turn
      // (sendPrompt persists only in its finally). Flush whatever is in
      // memory now; empty threads are skipped so we never wipe DB rows.
      const snapshots = Object.entries(get().entriesByConversation).filter(
        ([, list]) => list.length > 0,
      );
      await Promise.all(
        snapshots.map(([conversationId, list]) =>
          conversationReplaceThreadEntries(
            conversationId,
            list.map((e, sequence) => ({
              kind: e.kind,
              sequence,
              timestamp: e.timestamp,
              payload: e,
            })),
          ).catch((err) => {
            console.error("[conversation] flushThreadSnapshots failed:", err);
          }),
        ),
      );
    },

    pruneEntriesExcept: (keepIds) => {
      set((s) => {
        // Always retain threads for live ACP sessions (any project). Switching
        // away used to wipe running turns, so coming back showed empty/stale
        // history until the turn finished and re-persisted.
        const liveConversationIds = new Set(Object.keys(s.sessions));
        for (const id of Object.keys(s.entriesByConversation)) {
          if (!keepIds.has(id) && !liveConversationIds.has(id)) {
            delete s.entriesByConversation[id];
          }
        }
      });
    },

    appendUserMessage: (conversationId, text, images) => {
      set((s) => {
        if (!s.entriesByConversation[conversationId]) s.entriesByConversation[conversationId] = [];
        s.entriesByConversation[conversationId].push({
          id: crypto.randomUUID(),
          kind: "user_message",
          text,
          ...(images && images.length > 0 ? { images } : {}),
          timestamp: Date.now(),
        });
        // Optimistic busy flag so ThreadView can show loading during
        // ensureLiveSession / file-mention reads before sendPrompt runs.
        const session = s.sessions[conversationId];
        if (session?.status === "idle") session.status = "running";
      });
      const persistText =
        text.trim() ||
        (images && images.length > 0 ? `[图片 ×${images.length}]` : "");
      if (persistText) {
        void useConversationStore.getState().persistMessage(conversationId, "user", persistText);
      }
    },

    sendPrompt: async (sessionId, blocks) => {
      const session = Object.values(get().sessions).find((ss) => ss.sessionId === sessionId);
      if (!session) {
        set((s) => {
          s.error = `no such session ${sessionId}`;
        });
        return;
      }
      set((s) => {
        s.sessions[session.conversationId].status = "running";
        s.error = null;
      });
      let promptFailed = false;
      let hadMutations = false;
      try {
        const result = await agentSendPrompt(sessionId, blocks);
        hadMutations = !!result?.hadMutations;
      } catch (err) {
        promptFailed = true;
        set((s) => {
          s.error = errorMessage(err);
        });
      }

      const entries = get().entriesByConversation[session.conversationId] ?? [];
      // Never synthesize a "turn completed" assistant message when the
      // prompt itself failed — that would disguise an error as success.
      if (!promptFailed) {
        const assistantText = assistantTextAfterLastUser(entries);
        if (assistantText) {
          void useConversationStore.getState().persistMessage(
            session.conversationId,
            "assistant",
            assistantText,
          );
        } else {
          // Agents like Cursor may finish a turn with only tool cards and no
          // agent_message_chunk. Surface an explicit completion so the thread
          // doesn't look stuck after status returns to idle.
          set((s) => {
            const list = s.entriesByConversation[session.conversationId];
            if (!list) return;
            const last = list[list.length - 1];
            if (last?.kind === "user_message") {
              list.push({
                id: crypto.randomUUID(),
                kind: "assistant_message",
                timestamp: Date.now(),
                chunks: [{ type: "message", text: "（本回合已完成，未返回文本消息）" }],
              });
            } else if (last?.kind === "tool_call") {
              list.push({
                id: crypto.randomUUID(),
                kind: "assistant_message",
                timestamp: Date.now(),
                chunks: [{ type: "message", text: "（本回合已完成）" }],
              });
            }
          });
        }
      }
      // Persist full thread snapshot (thought/tool_call/etc.) so the UI can
      // restore complete history after restart.
      const latestEntries = get().entriesByConversation[session.conversationId] ?? entries;
      void conversationReplaceThreadEntries(
        session.conversationId,
        latestEntries.map((e, sequence) => ({
          kind: e.kind,
          sequence,
          timestamp: e.timestamp,
          payload: e,
        })),
      ).catch((e) => {
        console.error("[conversation] persistThreadEntries failed:", e);
      });
      set((s) => {
        if (s.sessions[session.conversationId]) {
          s.sessions[session.conversationId].status = sessionStillWaiting(s, sessionId)
            ? "waiting"
            : "idle";
        }
      });

      // NexAgent: after a mutating turn, chain a visible `/review` once.
      const conv = Object.values(useConversationStore.getState().conversationsByProject)
        .flat()
        .find((c) => c.id === session.conversationId);
      const isNative = conv?.agent_type === "nex" || conv?.agent_type === "native";
      const promptText = blocks
        .filter((b): b is Extract<PromptBlock, { type: "text" }> => b.type === "text")
        .map((b) => b.text)
        .join(" ")
        .trim();
      const wasReview = /^\/review(?:\s|$)/i.test(promptText);
      if (
        !promptFailed &&
        isNative &&
        get().nativeAutoReview &&
        hadMutations &&
        !wasReview &&
        get().sessions[session.conversationId]?.status === "idle"
      ) {
        get().appendUserMessage(session.conversationId, "/review");
        await get().sendPrompt(sessionId, [{ type: "text", text: "/review" }]);
        return;
      }

      // Auto-process next queued message if session returned to idle
      if (get().sessions[session.conversationId]?.status === "idle") {
        void get().processNextPending(session.conversationId);
      }
    },

    cancel: async (sessionId) => {
      set((s) => {
        s.error = null;
      });
      try {
        await agentCancel(sessionId);
      } catch (err) {
        set((s) => {
          s.error = errorMessage(err);
        });
      } finally {
        set((s) => {
          const session = Object.values(s.sessions).find((ss) => ss.sessionId === sessionId);
          if (session) {
            session.status = "idle";
            // Backend cancels waiters; mark in-thread plan cards so they don't
            // look actionable after the oneshot is gone.
            const list = s.entriesByConversation[session.conversationId];
            if (list) {
              for (const e of list) {
                if (e.kind === "plan_approval" && e.status === "pending") {
                  e.status = "cancelled";
                }
              }
            }
          }
          delete s.permissionQueues[sessionId];
          delete s.planApprovalQueues[sessionId];
          delete s.askQuestionQueues[sessionId];
          if (s.pendingPermission?.sessionId === sessionId) {
            s.pendingPermission = nextPendingPermission(s.permissionQueues, s.inlinePermissionIds);
          }
          if (s.pendingPlanApproval?.sessionId === sessionId) {
            s.pendingPlanApproval = nextPendingPlanApproval(s.planApprovalQueues);
          }
          if (s.pendingAskQuestion?.sessionId === sessionId) {
            s.pendingAskQuestion = nextPendingAskQuestion(s.askQuestionQueues);
          }
        });
      }
    },

    respondPermission: async (requestId, optionId) => {
      set((s) => {
        s.error = null;
      });
      try {
        await agentRespondPermission(requestId, optionId);
      } catch (err) {
        set((s) => {
          s.error = errorMessage(err);
        });
      } finally {
        set((s) => {
          let sessionIdForStatus: string | null = null;
          for (const [sessionId, queue] of Object.entries(s.permissionQueues)) {
            const idx = queue.findIndex((q) => q.requestId === requestId);
            if (idx !== -1) {
              queue.splice(idx, 1);
              if (queue.length === 0) delete s.permissionQueues[sessionId];
              sessionIdForStatus = sessionId;
              break;
            }
          }
          delete s.inlinePermissionIds[requestId];
          for (const entries of Object.values(s.entriesByConversation)) {
            clearToolWaiting(entries, requestId);
          }
          s.pendingPermission = nextPendingPermission(s.permissionQueues, s.inlinePermissionIds);
          if (sessionIdForStatus) {
            const session = Object.values(s.sessions).find((ss) => ss.sessionId === sessionIdForStatus);
            if (session) {
              // 已处理（同意/拒绝）：撤掉该会话的「等待确认」通知，避免误导。
              useNotificationStore.getState().dismissForConversation(session.conversationId);
              if (session.status === "waiting" && !sessionStillWaiting(s, sessionIdForStatus)) {
                session.status = "running";
              }
            }
          }
        });
      }
    },

    respondPlan: async (requestId, outcome, reason) => {
      // Dequeue first so double-clicks cannot resolve the same request twice.
      // Keep a plain copy for re-queue if the RPC fails.
      let sessionIdForStatus: string | null = null;
      let conversationIdForHandoff: string | null = null;
      let dequeued: AgentPlanApprovalRequestPayload | null = null;
      set((s) => {
        s.error = null;
        for (const [sessionId, queue] of Object.entries(s.planApprovalQueues)) {
          const idx = queue.findIndex((q) => q.requestId === requestId);
          if (idx !== -1) {
            const item = queue[idx];
            dequeued = {
              sessionId: item.sessionId,
              requestId: item.requestId,
              name: item.name,
              overview: item.overview,
              plan: item.plan,
              todos: item.todos.map((t) => ({ ...t })),
            };
            queue.splice(idx, 1);
            if (queue.length === 0) delete s.planApprovalQueues[sessionId];
            sessionIdForStatus = sessionId;
            break;
          }
        }
        s.pendingPlanApproval = nextPendingPlanApproval(s.planApprovalQueues);
        // Mirror outcome onto the in-thread card.
        const session = sessionIdForStatus
          ? Object.values(s.sessions).find((ss) => ss.sessionId === sessionIdForStatus)
          : undefined;
        if (session) {
          conversationIdForHandoff = session.conversationId;
          const list = s.entriesByConversation[session.conversationId];
          const card = list?.find(
            (e) => e.kind === "plan_approval" && e.requestId === requestId,
          );
          if (card && card.kind === "plan_approval") {
            card.status =
              outcome === "accepted"
                ? "accepted"
                : outcome === "rejected"
                  ? "rejected"
                  : "cancelled";
          }
        }
      });
      if (!sessionIdForStatus) return;
      const resolvedSessionId = sessionIdForStatus;
      let respondedOk = false;
      try {
        await agentRespondPlan(requestId, outcome, reason);
        respondedOk = true;
      } catch (err) {
        set((s) => {
          s.error = errorMessage(err);
          // Re-queue + roll back card so the user can retry.
          if (dequeued) {
            const queue = s.planApprovalQueues[resolvedSessionId] ?? [];
            if (!queue.some((q) => q.requestId === requestId)) {
              queue.unshift(dequeued);
              s.planApprovalQueues[resolvedSessionId] = queue;
            }
            s.pendingPlanApproval = nextPendingPlanApproval(s.planApprovalQueues);
          }
          if (conversationIdForHandoff) {
            const list = s.entriesByConversation[conversationIdForHandoff];
            const card = list?.find(
              (e) => e.kind === "plan_approval" && e.requestId === requestId,
            );
            if (card && card.kind === "plan_approval") card.status = "pending";
          }
        });
      } finally {
        set((s) => {
          const session = Object.values(s.sessions).find((ss) => ss.sessionId === resolvedSessionId);
          if (session) {
            useNotificationStore.getState().dismissForConversation(session.conversationId);
            if (session.status === "waiting" && !sessionStillWaiting(s, resolvedSessionId)) {
              session.status = "running";
            }
          }
        });
      }

      // Accept alone unblocks Cursor but often leaves the session in plan/ask
      // mode with the prompt turn ending — switch to an executable mode and
      // queue a continue turn so the plan actually runs.
      if (respondedOk && outcome === "accepted" && conversationIdForHandoff) {
        await handoffPlanToExecute(get, set, resolvedSessionId, conversationIdForHandoff);
      }
    },

    respondAskQuestion: async (requestId, outcome, answers, reason) => {
      let sessionIdForStatus: string | null = null;
      let dequeued: AgentAskQuestionRequestPayload | null = null;
      set((s) => {
        s.error = null;
        for (const [sessionId, queue] of Object.entries(s.askQuestionQueues)) {
          const idx = queue.findIndex((q) => q.requestId === requestId);
          if (idx !== -1) {
            const item = queue[idx];
            dequeued = {
              sessionId: item.sessionId,
              requestId: item.requestId,
              title: item.title,
              questions: item.questions.map((q) => ({
                ...q,
                options: q.options.map((o) => ({ ...o })),
              })),
            };
            queue.splice(idx, 1);
            if (queue.length === 0) delete s.askQuestionQueues[sessionId];
            sessionIdForStatus = sessionId;
            break;
          }
        }
        s.pendingAskQuestion = nextPendingAskQuestion(s.askQuestionQueues);
      });
      if (!sessionIdForStatus) return;
      const resolvedSessionId = sessionIdForStatus;
      try {
        await agentRespondAskQuestion(requestId, outcome, answers, reason);
      } catch (err) {
        set((s) => {
          s.error = errorMessage(err);
          if (dequeued) {
            const queue = s.askQuestionQueues[resolvedSessionId] ?? [];
            if (!queue.some((q) => q.requestId === requestId)) {
              queue.unshift(dequeued);
              s.askQuestionQueues[resolvedSessionId] = queue;
            }
            s.pendingAskQuestion = nextPendingAskQuestion(s.askQuestionQueues);
          }
        });
      } finally {
        set((s) => {
          const session = Object.values(s.sessions).find((ss) => ss.sessionId === resolvedSessionId);
          if (session) {
            useNotificationStore.getState().dismissForConversation(session.conversationId);
            if (session.status === "waiting" && !sessionStillWaiting(s, resolvedSessionId)) {
              session.status = "running";
            }
          }
        });
      }
    },

    setMode: async (sessionId, modeId, opts) => {
      const session = Object.values(get().sessions).find((ss) => ss.sessionId === sessionId);
      if (session && !opts?.skipConfirm) {
        const from = get().metaByConversation[session.conversationId]?.currentModeId;
        if (
          from === "plan" &&
          (modeId === "code" || modeId === "auto" || modeId === "agent")
        ) {
          const ok = window.confirm("确认离开 Plan 并开始执行？");
          if (!ok) return;
        }
      }
      try {
        await agentSetSessionMode(sessionId, modeId);
        if (session) {
          set((s) => {
            const meta = s.metaByConversation[session.conversationId];
            if (meta) meta.currentModeId = modeId;
          });
          patchPrefs(set, session.conversationId, { modeId });
        }
      } catch (err) {
        set((s) => {
          s.error = errorMessage(err);
        });
      }
    },

    setModel: async (sessionId, modelId) => {
      const session = Object.values(get().sessions).find((ss) => ss.sessionId === sessionId);
      try {
        const next = await agentSetSessionModel(sessionId, modelId);
        if (session) {
          set((s) => {
            const meta = s.metaByConversation[session.conversationId];
            if (!meta) return;
            meta.currentModelId = modelId;
            // Native agent returns refreshed reasoning levels for the new model.
            if (next) {
              meta.configOptions = next.map((o) => ({
                id: o.id,
                name: o.name,
                category: o.category ?? undefined,
                currentValueId: o.currentValueId,
                options: o.options.map((x) => ({ id: x.id, name: x.name })),
              }));
            }
          });
          patchPrefs(set, session.conversationId, { modelId });
        }
      } catch (err) {
        set((s) => {
          s.error = errorMessage(err);
        });
      }
    },

    setConfigOption: async (sessionId, configId, value) => {
      const session = Object.values(get().sessions).find((ss) => ss.sessionId === sessionId);
      try {
        const next = await agentSetSessionConfigOption(sessionId, configId, value);
        if (session) {
          set((s) => {
            const meta = s.metaByConversation[session.conversationId];
            if (!meta) return;
            if (next && next.length > 0) {
              meta.configOptions = next.map((o) => ({
                id: o.id,
                name: o.name,
                category: o.category ?? undefined,
                currentValueId: o.currentValueId,
                options: o.options.map((x) => ({ id: x.id, name: x.name })),
              }));
              // Keep legacy mode/model selectors in sync when agents dual-write.
              const modeOpt = meta.configOptions.find((o) => o.id === "mode" || o.category === "mode");
              if (modeOpt) {
                meta.currentModeId = modeOpt.currentValueId;
              }
              const modelOpt = meta.configOptions.find(
                (o) => o.id === "model" || o.category === "model",
              );
              if (modelOpt) {
                meta.currentModelId = modelOpt.currentValueId;
              }
            } else {
              const opt = meta.configOptions.find((o) => o.id === configId);
              if (opt) opt.currentValueId = value;
            }
          });
          const metaAfter = get().metaByConversation[session.conversationId];
          const optMeta = metaAfter?.configOptions.find((o) => o.id === configId);
          const isMode = configId === "mode" || optMeta?.category === "mode";
          const isModel = configId === "model" || optMeta?.category === "model";
          if (isMode) patchPrefs(set, session.conversationId, { modeId: value });
          else if (isModel) patchPrefs(set, session.conversationId, { modelId: value });
          else {
            set((s) => {
              const prev = s.sessionPrefsByConversation[session.conversationId] ?? {};
              s.sessionPrefsByConversation[session.conversationId] = {
                ...prev,
                configValues: { ...(prev.configValues ?? {}), [configId]: value },
              };
            });
          }
        }
      } catch (err) {
        set((s) => {
          s.error = errorMessage(err);
        });
      }
    },

    setAuthMode: (conversationId, authMode) => {
      patchPrefs(set, conversationId, { authMode });
    },

    refreshNativeAutoReview: async () => {
      try {
        const cfg = await nativeAgentGetConfig();
        set((s) => {
          s.nativeAutoReview = !!cfg.agent.autoReview;
        });
      } catch {
        /* settings unavailable — leave cached value */
      }
    },

    enqueuePendingMessage: (conversationId, blocks, text, images) => {
      const id = crypto.randomUUID();
      set((s) => {
        if (!s.pendingMessagesByConversation[conversationId]) {
          s.pendingMessagesByConversation[conversationId] = [];
        }
        s.pendingMessagesByConversation[conversationId].push({
          id,
          blocks,
          text,
          ...(images && images.length > 0 ? { images } : {}),
        });
      });
      return id;
    },

    removePendingMessage: (conversationId, messageId) => {
      set((s) => {
        const queue = s.pendingMessagesByConversation[conversationId];
        if (!queue) return;
        s.pendingMessagesByConversation[conversationId] = queue.filter((m) => m.id !== messageId);
        if (s.pendingMessagesByConversation[conversationId].length === 0) {
          delete s.pendingMessagesByConversation[conversationId];
        }
      });
    },

    sendPendingNow: async (conversationId, messageId) => {
      const state = get();
      const session = state.sessions[conversationId];
      if (!session?.sessionId) return;

      // Cancel current running task if any
      if (session.status === "running" || session.status === "waiting") {
        try {
          await agentCancel(session.sessionId);
        } catch {
          /* best-effort cancel */
        }
        set((s) => {
          const sess = s.sessions[conversationId];
          if (sess) sess.status = "idle";
        });
      }

      // Find and remove the specific message from the queue
      const queue = state.pendingMessagesByConversation[conversationId] ?? [];
      const idx = queue.findIndex((m) => m.id === messageId);
      if (idx === -1) return;
      const pending = queue[idx];
      set((s) => {
        const q = s.pendingMessagesByConversation[conversationId];
        if (q) {
          s.pendingMessagesByConversation[conversationId] = q.filter((m) => m.id !== messageId);
          if (s.pendingMessagesByConversation[conversationId].length === 0) {
            delete s.pendingMessagesByConversation[conversationId];
          }
        }
      });

      deliverPendingUserBubble(get().appendUserMessage, conversationId, pending);
      await get().sendPrompt(session.sessionId, pending.blocks);
    },

    processNextPending: async (conversationId) => {
      const state = get();
      const session = state.sessions[conversationId];
      // Only auto-process when session is truly idle
      if (!session || session.status !== "idle") return;

      const queue = state.pendingMessagesByConversation[conversationId];
      if (!queue || queue.length === 0) return;

      const pending = queue[0];
      // Remove from queue before sending to avoid race
      set((s) => {
        s.pendingMessagesByConversation[conversationId] = s.pendingMessagesByConversation[conversationId].slice(1);
        if (s.pendingMessagesByConversation[conversationId].length === 0) {
          delete s.pendingMessagesByConversation[conversationId];
        }
      });

      deliverPendingUserBubble(get().appendUserMessage, conversationId, pending);
      await get().sendPrompt(session.sessionId, pending.blocks);
    },

    loadServers: async () => {
      set((s) => {
        s.serversLoading = true;
      });
      try {
        const servers = await agentListServers();
        set((s) => {
          s.servers = servers;
        });
      } catch (err) {
        set((s) => {
          s.error = errorMessage(err);
        });
      } finally {
        set((s) => {
          s.serversLoading = false;
          s.serversLoadedAt = Date.now();
        });
      }
    },

    loadAllServers: async () => {
      set((s) => {
        s.serversLoading = true;
      });
      try {
        const servers = await agentListAllServers();
        set((s) => {
          s.servers = servers;
        });
      } catch (err) {
        set((s) => {
          s.error = errorMessage(err);
        });
      } finally {
        set((s) => {
          s.serversLoading = false;
          s.serversLoadedAt = Date.now();
        });
      }
    },

    refreshRegistry: async () => {
      set((s) => {
        s.serversLoading = true;
        s.error = null;
      });
      try {
        await agentRefreshRegistry();
        // Caller decides whitelist vs full list via a subsequent load;
        // default to whitelist for New Conversation.
        const servers = await agentListServers();
        set((s) => {
          s.servers = servers;
        });
      } catch (err) {
        set((s) => {
          s.error = errorMessage(err);
        });
      } finally {
        set((s) => {
          s.serversLoading = false;
          s.serversLoadedAt = Date.now();
        });
      }
    },

    upsertCustom: async (server) => {
      set((s) => {
        s.error = null;
      });
      try {
        await agentCustomUpsert(server);
        const servers = await agentListAllServers();
        set((s) => {
          s.servers = servers;
        });
      } catch (err) {
        set((s) => {
          s.error = errorMessage(err);
        });
        throw err;
      }
    },

    deleteCustom: async (id) => {
      set((s) => {
        s.error = null;
      });
      try {
        await agentCustomDelete(id);
        const servers = await agentListAllServers();
        set((s) => {
          s.servers = servers;
        });
      } catch (err) {
        set((s) => {
          s.error = errorMessage(err);
        });
      }
    },

    initListeners: () => {
      if (listenerTeardown) return listenerTeardown;
      let disposed = false;
      let unlistenNotification: UnlistenFn | null = null;
      let unlistenPermission: UnlistenFn | null = null;
      let unlistenPlanApproval: UnlistenFn | null = null;
      let unlistenAskQuestion: UnlistenFn | null = null;
      let unlistenTerminated: UnlistenFn | null = null;

      void get().refreshNativeAutoReview();

      onAgentNotification(({ sessionId, update }) => {
        const session = Object.values(get().sessions).find((ss) => ss.sessionId === sessionId);
        if (!session) {
          // SessionId not registered yet (createSession still in flight) — buffer
          // meta catalogs only; stream chunks for unknown ids are dropped.
          enqueuePendingNotification(sessionId, update, get);
          return;
        }
        applyNotificationUpdate(set, get, sessionId, update);
      }).then((fn) => {
        if (disposed) fn();
        else unlistenNotification = fn;
      });

      onAgentPermissionRequest((payload) => {
        const session = Object.values(get().sessions).find((ss) => ss.sessionId === payload.sessionId);
        const authMode = session
          ? get().sessionPrefsByConversation[session.conversationId]?.authMode
          : undefined;
        if (authMode === "allow") {
          const optionId = pickAllowOptionId(payload.options);
          if (optionId) {
            void get().respondPermission(payload.requestId, optionId);
            return;
          }
        }

        set((s) => {
          if (!s.permissionQueues[payload.sessionId]) s.permissionQueues[payload.sessionId] = [];
          s.permissionQueues[payload.sessionId].push(payload);

          const live = Object.values(s.sessions).find((ss) => ss.sessionId === payload.sessionId);
          if (live) {
            live.status = "waiting";
            if (!s.entriesByConversation[live.conversationId]) {
              s.entriesByConversation[live.conversationId] = [];
            }
            const entries = s.entriesByConversation[live.conversationId];
            const attached = applyPermissionRequestToEntries(entries, payload);
            if (attached) s.inlinePermissionIds[payload.requestId] = true;
            s.pendingPermission = nextPendingPermission(s.permissionQueues, s.inlinePermissionIds);
          } else if (!s.pendingPermission) {
            s.pendingPermission = payload;
          }
        });

        // 软件内通知：用户可能在看其它项目/会话，需要提醒去处理确认。
        if (session) {
          let projectId: string | null = null;
          let convTitle = "";
          const byProject = useConversationStore.getState().conversationsByProject;
          for (const [pid, list] of Object.entries(byProject)) {
            const c = list.find((x) => x.id === session.conversationId);
            if (c) {
              projectId = pid;
              convTitle = c.title;
              break;
            }
          }
          useNotificationStore.getState().push({
            title: "Agent 等待确认",
            body: `${payload.toolTitle ?? "工具调用"}${convTitle ? ` · ${convTitle}` : ""}`,
            projectId,
            conversationId: session.conversationId,
          });
        }
      }).then((fn) => {
        if (disposed) fn();
        else unlistenPermission = fn;
      });

      onAgentPlanApprovalRequest((payload) => {
        const session = Object.values(get().sessions).find((ss) => ss.sessionId === payload.sessionId);
        set((s) => {
          if (!s.planApprovalQueues[payload.sessionId]) s.planApprovalQueues[payload.sessionId] = [];
          s.planApprovalQueues[payload.sessionId].push(payload);
          const live = Object.values(s.sessions).find((ss) => ss.sessionId === payload.sessionId);
          if (live) live.status = "waiting";
          if (!s.pendingPlanApproval) s.pendingPlanApproval = payload;
          // Inline card in the conversation thread (no modal).
          if (live) {
            if (!s.entriesByConversation[live.conversationId]) {
              s.entriesByConversation[live.conversationId] = [];
            }
            const list = s.entriesByConversation[live.conversationId];
            if (!list.some((e) => e.kind === "plan_approval" && e.requestId === payload.requestId)) {
              list.push({
                id: crypto.randomUUID(),
                kind: "plan_approval",
                timestamp: Date.now(),
                requestId: payload.requestId,
                name: payload.name ?? undefined,
                overview: payload.overview ?? undefined,
                plan: payload.plan,
                todos: payload.todos.map((t) => ({
                  id: t.id,
                  content: t.content,
                  status: t.status,
                })),
                status: "pending",
              });
            }
          }
        });

        if (session) {
          let projectId: string | null = null;
          let convTitle = "";
          const byProject = useConversationStore.getState().conversationsByProject;
          for (const [pid, list] of Object.entries(byProject)) {
            const c = list.find((x) => x.id === session.conversationId);
            if (c) {
              projectId = pid;
              convTitle = c.title;
              break;
            }
          }
          useNotificationStore.getState().push({
            title: "计划等待确认",
            body: `${payload.name?.trim() || "执行计划"}${convTitle ? ` · ${convTitle}` : ""}`,
            projectId,
            conversationId: session.conversationId,
          });
        }
      }).then((fn) => {
        if (disposed) fn();
        else unlistenPlanApproval = fn;
      });

      onAgentAskQuestionRequest((payload) => {
        const session = Object.values(get().sessions).find((ss) => ss.sessionId === payload.sessionId);
        set((s) => {
          if (!s.askQuestionQueues[payload.sessionId]) s.askQuestionQueues[payload.sessionId] = [];
          s.askQuestionQueues[payload.sessionId].push(payload);
          const live = Object.values(s.sessions).find((ss) => ss.sessionId === payload.sessionId);
          if (live) live.status = "waiting";
          if (!s.pendingAskQuestion) s.pendingAskQuestion = payload;
        });

        if (session) {
          let projectId: string | null = null;
          let convTitle = "";
          const byProject = useConversationStore.getState().conversationsByProject;
          for (const [pid, list] of Object.entries(byProject)) {
            const c = list.find((x) => x.id === session.conversationId);
            if (c) {
              projectId = pid;
              convTitle = c.title;
              break;
            }
          }
          const firstPrompt = payload.questions[0]?.prompt?.trim();
          useNotificationStore.getState().push({
            title: "Agent 需要选择",
            body: `${payload.title?.trim() || firstPrompt || "选择题"}${convTitle ? ` · ${convTitle}` : ""}`,
            projectId,
            conversationId: session.conversationId,
          });
        }
      }).then((fn) => {
        if (disposed) fn();
        else unlistenAskQuestion = fn;
      });

      onAgentSessionTerminated(({ sessionId }) => {
        set((s) => {
          const session = Object.values(s.sessions).find((ss) => ss.sessionId === sessionId);
          if (session) delete s.sessions[session.conversationId];
          delete s.permissionQueues[sessionId];
          delete s.planApprovalQueues[sessionId];
          delete s.askQuestionQueues[sessionId];
          if (s.pendingPermission?.sessionId === sessionId) {
            s.pendingPermission = nextPendingPermission(s.permissionQueues, s.inlinePermissionIds);
          }
          if (s.pendingPlanApproval?.sessionId === sessionId) {
            s.pendingPlanApproval = nextPendingPlanApproval(s.planApprovalQueues);
          }
          if (s.pendingAskQuestion?.sessionId === sessionId) {
            s.pendingAskQuestion = nextPendingAskQuestion(s.askQuestionQueues);
          }
        });
      }).then((fn) => {
        if (disposed) fn();
        else unlistenTerminated = fn;
      });

      listenerTeardown = () => {
        disposed = true;
        unlistenNotification?.();
        unlistenPermission?.();
        unlistenPlanApproval?.();
        unlistenAskQuestion?.();
        unlistenTerminated?.();
        listenerTeardown = null;
      };
      return listenerTeardown;
    },
  })),
    {
      name: "nex-agent",
      partialize: (s) => ({
        sessionPrefsByConversation: s.sessionPrefsByConversation,
      }),
    },
  ),
);

/**
 * Waits for the session of `conversationId` to leave "starting" without
 * polling: subscribes to store changes and resolves on the first relevant
 * transition. Resolves the live sessionId, or null when the session is gone.
 * The timeout is only a safety net for a stuck handshake — success/failure
 * transitions resolve immediately.
 */
export function waitSessionReady(
  conversationId: string,
  timeoutMs = 15_000,
): Promise<string | null> {
  return new Promise((resolve) => {
    const current = useAgentStore.getState().sessions[conversationId];
    if (!current) return resolve(null);
    if (current.sessionId && current.status !== "starting") return resolve(current.sessionId);

    let unsub: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (value: string | null) => {
      if (timer !== undefined) clearTimeout(timer);
      unsub?.();
      resolve(value);
    };
    unsub = useAgentStore.subscribe(() => {
      const s = useAgentStore.getState().sessions[conversationId];
      if (!s) return finish(null);
      if (s.sessionId && s.status !== "starting") return finish(s.sessionId);
    });
    timer = setTimeout(() => {
      const s = useAgentStore.getState().sessions[conversationId];
      finish(s?.sessionId || null);
    }, timeoutMs);
  });
}
