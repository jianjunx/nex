import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import type { UnlistenFn } from "@tauri-apps/api/event";
import {
  agentCreateSession,
  agentSendPrompt,
  agentCancel,
  agentRespondPermission,
  agentCloseSession,
  agentListServers,
  agentListAllServers,
  agentRefreshRegistry,
  agentCustomUpsert,
  agentCustomDelete,
  agentSetSessionMode,
  agentSetSessionModel,
  conversationReplaceThreadEntries,
  onAgentNotification,
  onAgentPermissionRequest,
  onAgentSessionTerminated,
  type PromptBlock,
  type ServerDescriptor,
  type SessionTarget,
  type CustomServer,
  type CreateSessionResult,
} from "../bridge/tauri";
import type { AgentPermissionRequestPayload } from "../bridge/events";
import { applySessionUpdate, emptySessionMeta } from "../features/agent/thread/applySessionUpdate";
import { assistantTextAfterLastUser } from "../features/agent/thread/messagesToThreadEntries";
import type { SessionMeta, ThreadEntry, ToolCallEntry } from "../features/agent/thread/types";
import { useConversationStore } from "./conversation.store";

export interface AgentSession {
  sessionId: string;
  conversationId: string;
  status: "starting" | "idle" | "running" | "waiting";
}

interface AgentStore {
  sessions: Record<string, AgentSession>;
  entriesByConversation: Record<string, ThreadEntry[]>;
  metaByConversation: Record<string, SessionMeta>;
  permissionQueues: Record<string, AgentPermissionRequestPayload[]>;
  pendingPermission: AgentPermissionRequestPayload | null;
  /** Shown on a tool card — exclude from PermissionModal fallback. */
  inlinePermissionIds: Record<string, true>;
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
  appendUserMessage: (
    conversationId: string,
    text: string,
    images?: { mimeType: string; data: string }[],
  ) => void;
  sendPrompt: (sessionId: string, blocks: PromptBlock[]) => Promise<void>;
  cancel: (sessionId: string) => Promise<void>;
  respondPermission: (requestId: string, optionId: string | null) => Promise<void>;
  setMode: (sessionId: string, modeId: string) => Promise<void>;
  setModel: (sessionId: string, modelId: string) => Promise<void>;
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
    }));
  }
  return meta;
}

function markToolWaiting(
  entries: ThreadEntry[],
  toolCallId: string | null | undefined,
  requestId: string,
  options: { optionId: string; label: string }[],
): boolean {
  if (!toolCallId) return false;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.kind === "tool_call" && e.toolCallId === toolCallId) {
      const tool = e as ToolCallEntry;
      tool.status = "waiting_for_confirmation";
      tool.permissionRequestId = requestId;
      tool.options = options.map((o) => ({ ...o, requestId }));
      return true;
    }
  }
  return false;
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

export const useAgentStore = create<AgentStore>()(
  immer((set, get) => ({
    sessions: {},
    entriesByConversation: {},
    metaByConversation: {},
    permissionQueues: {},
    pendingPermission: null,
    inlinePermissionIds: {},
    servers: [],
    loading: false,
    serversLoading: false,
    serversLoadedAt: 0,
    error: null,

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
        return result.sessionId;
      } catch (err) {
        set((s) => {
          delete s.sessions[conversationId];
          s.error = errorMessage(err);
        });
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
        });
      }
    },

    hydrateEntries: (conversationId, entries) => {
      set((s) => {
        s.entriesByConversation[conversationId] = entries;
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
      try {
        await agentSendPrompt(sessionId, blocks);
      } catch (err) {
        set((s) => {
          s.error = errorMessage(err);
        });
      } finally {
        const entries = get().entriesByConversation[session.conversationId] ?? [];
        const assistantText = assistantTextAfterLastUser(entries);
        if (assistantText) {
          void useConversationStore.getState().persistMessage(
            session.conversationId,
            "assistant",
            assistantText,
          );
        }
        // Persist full thread snapshot (thought/tool_call/etc.) so the UI can
        // restore complete history after restart.
        void conversationReplaceThreadEntries(
          session.conversationId,
          entries.map((e, sequence) => ({
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
            const hasWaiting = (s.permissionQueues[sessionId] ?? []).length > 0;
            s.sessions[session.conversationId].status = hasWaiting ? "waiting" : "idle";
          }
        });
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
          if (session) session.status = "idle";
          delete s.permissionQueues[sessionId];
          if (s.pendingPermission?.sessionId === sessionId) {
            s.pendingPermission = nextPendingPermission(s.permissionQueues, s.inlinePermissionIds);
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
              const stillWaiting = (s.permissionQueues[sessionIdForStatus] ?? []).length > 0;
              if (session.status === "waiting" && !stillWaiting) session.status = "running";
            }
          }
        });
      }
    },

    setMode: async (sessionId, modeId) => {
      const session = Object.values(get().sessions).find((ss) => ss.sessionId === sessionId);
      try {
        await agentSetSessionMode(sessionId, modeId);
        if (session) {
          set((s) => {
            const meta = s.metaByConversation[session.conversationId];
            if (meta) meta.currentModeId = modeId;
          });
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
        await agentSetSessionModel(sessionId, modelId);
        if (session) {
          set((s) => {
            const meta = s.metaByConversation[session.conversationId];
            if (meta) meta.currentModelId = modelId;
          });
        }
      } catch (err) {
        set((s) => {
          s.error = errorMessage(err);
        });
      }
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
      let unlistenTerminated: UnlistenFn | null = null;

      onAgentNotification(({ sessionId, update }) => {
        const session = Object.values(get().sessions).find((ss) => ss.sessionId === sessionId);
        if (!session) return;
        set((s) => {
          if (!s.entriesByConversation[session.conversationId]) {
            s.entriesByConversation[session.conversationId] = [];
          }
          if (!s.metaByConversation[session.conversationId]) {
            s.metaByConversation[session.conversationId] = emptySessionMeta();
          }
          const entries = s.entriesByConversation[session.conversationId];
          const meta = s.metaByConversation[session.conversationId];
          const applied = applySessionUpdate(entries, meta, update);
          if (applied.completedPlanSnapshot) {
            entries.push({
              id: crypto.randomUUID(),
              kind: "completed_plan",
              timestamp: Date.now(),
              entries: applied.completedPlanSnapshot,
            });
          }
        });
      }).then((fn) => {
        if (disposed) fn();
        else unlistenNotification = fn;
      });

      onAgentPermissionRequest((payload) => {
        set((s) => {
          if (!s.permissionQueues[payload.sessionId]) s.permissionQueues[payload.sessionId] = [];
          s.permissionQueues[payload.sessionId].push(payload);

          const session = Object.values(s.sessions).find((ss) => ss.sessionId === payload.sessionId);
          if (session) {
            session.status = "waiting";
            const entries = s.entriesByConversation[session.conversationId] ?? [];
            const attached = markToolWaiting(
              entries,
              payload.toolCallId,
              payload.requestId,
              payload.options,
            );
            if (attached) s.inlinePermissionIds[payload.requestId] = true;
            s.pendingPermission = nextPendingPermission(s.permissionQueues, s.inlinePermissionIds);
          } else if (!s.pendingPermission) {
            s.pendingPermission = payload;
          }
        });
      }).then((fn) => {
        if (disposed) fn();
        else unlistenPermission = fn;
      });

      onAgentSessionTerminated(({ sessionId }) => {
        set((s) => {
          const session = Object.values(s.sessions).find((ss) => ss.sessionId === sessionId);
          if (session) delete s.sessions[session.conversationId];
          delete s.permissionQueues[sessionId];
          if (s.pendingPermission?.sessionId === sessionId) {
            s.pendingPermission = nextPendingPermission(s.permissionQueues, s.inlinePermissionIds);
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
        unlistenTerminated?.();
        listenerTeardown = null;
      };
      return listenerTeardown;
    },
  })),
);
