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
  agentRefreshRegistry,
  agentCustomUpsert,
  agentCustomDelete,
  onAgentNotification,
  onAgentPermissionRequest,
  onAgentSessionTerminated,
  type Message,
  type ServerDescriptor,
  type SessionTarget,
  type CustomServer,
} from "../bridge/tauri";
import type { AgentPermissionRequestPayload } from "../bridge/events";
import { useConversationStore } from "./conversation.store";

export interface AgentSession {
  sessionId: string;
  conversationId: string;
  status: "idle" | "running" | "waiting";
}

interface AgentStore {
  sessions: Record<string, AgentSession>; // keyed by conversationId
  /** Outstanding permission requests, FIFO per session (keyed by sessionId). */
  permissionQueues: Record<string, AgentPermissionRequestPayload[]>;
  /** The permission request currently shown in the modal (head of the first non-empty queue). */
  pendingPermission: AgentPermissionRequestPayload | null;
  /** conversationId -> id of the assistant message currently accumulating stream chunks. */
  streamingMessageId: Record<string, string>;
  /** Available agents for the New-Conversation dropdown (registry + custom). */
  servers: ServerDescriptor[];
  loading: boolean;
  /** True while the server list is (re)loading, for the dropdown's spinner. */
  serversLoading: boolean;
  error: string | null;

  createSession: (conversationId: string, target: SessionTarget, cwd: string) => Promise<string>;
  /**
   * Tears down the conversation's agent session (kills the agent process)
   * and drops local session state. No-op when no session was ever started.
   * Idempotent with the `agent-session-terminated` listener, which cleans up
   * the same keys when the backend confirms termination.
   */
  removeSession: (conversationId: string) => Promise<void>;
  sendPrompt: (sessionId: string, content: string) => Promise<void>;
  cancel: (sessionId: string) => Promise<void>;
  respondPermission: (requestId: string, optionId: string | null) => Promise<void>;
  /** Loads the merged agent list (registry + custom) from the backend. */
  loadServers: () => Promise<void>;
  /** Forces a registry re-fetch, then reloads the list. */
  refreshRegistry: () => Promise<void>;
  upsertCustom: (server: CustomServer) => Promise<void>;
  deleteCustom: (id: string) => Promise<void>;
  /** Subscribes to agent events. Returns an unlisten cleanup; safe to call from a StrictMode effect. */
  initListeners: () => () => void;
}

// Backend errors arrive as { type, message }; fall back to String(err).
function errorMessage(err: unknown): string {
  if (err && typeof err === "object" && "message" in err && typeof (err as { message: unknown }).message === "string") {
    return (err as { message: string }).message;
  }
  return String(err);
}

// Module-level so the active teardown survives store re-reads; StrictMode
// mounts -> cleans up -> re-mounts, and this guard prevents double subscription.
let listenerTeardown: (() => void) | null = null;

interface ParsedUpdate {
  role: string;
  text: string;
  toolSummary: string | null;
}

function contentBlockText(content: unknown): string | null {
  if (!content || typeof content !== "object") return null;
  const text = (content as Record<string, unknown>).text;
  return typeof text === "string" ? text : null;
}

/**
 * Extracts displayable content from an ACP `SessionUpdate`
 * (serialized as `{ sessionUpdate: "<kind>", ... }`). Returns null for
 * updates that should not render as chat messages (thoughts, plans,
 * tool-call progress updates, user echoes).
 */
function parseSessionUpdate(update: unknown): ParsedUpdate | null {
  if (!update || typeof update !== "object") return null;
  const u = update as Record<string, unknown>;
  switch (u.sessionUpdate) {
    case "agent_message_chunk": {
      const text = contentBlockText(u.content);
      return text ? { role: "assistant", text, toolSummary: null } : null;
    }
    case "tool_call": {
      const title = typeof u.title === "string" ? u.title : "Tool call";
      const kind = typeof u.kind === "string" ? u.kind : "tool";
      return { role: "assistant", text: "", toolSummary: `${kind}: ${title}` };
    }
    default:
      return null;
  }
}

/**
 * The request to display is the head of the first non-empty session queue
 * (Record iteration order is stable insertion order), or null when all
 * queues are empty.
 */
function nextPendingPermission(
  queues: Record<string, AgentPermissionRequestPayload[]>,
): AgentPermissionRequestPayload | null {
  for (const queue of Object.values(queues)) {
    if (queue.length > 0) return queue[0];
  }
  return null;
}

export const useAgentStore = create<AgentStore>()(
  immer((set, get) => ({
    sessions: {},
    permissionQueues: {},
    pendingPermission: null,
    streamingMessageId: {},
    servers: [],
    loading: false,
    serversLoading: false,
    error: null,

    createSession: async (conversationId, target, cwd) => {
      set((s) => { s.loading = true; s.error = null; });
      try {
        const sessionId = await agentCreateSession(conversationId, target, cwd);
        set((s) => {
          s.sessions[conversationId] = { sessionId, conversationId, status: "idle" };
        });
        return sessionId;
      } catch (err) {
        set((s) => { s.error = errorMessage(err); });
        throw err;
      } finally {
        set((s) => { s.loading = false; });
      }
    },

    removeSession: async (conversationId) => {
      const session = get().sessions[conversationId];
      // No session was ever started for this tab — nothing to tear down.
      if (!session) return;
      set((s) => { s.error = null; });
      try {
        await agentCloseSession(session.sessionId);
      } catch (err) {
        set((s) => { s.error = errorMessage(err); });
      } finally {
        // Drop local state regardless: the tab is closing either way, and
        // the agent-session-terminated listener does the same cleanup when the
        // backend event arrives.
        set((s) => {
          delete s.sessions[conversationId];
          delete s.streamingMessageId[conversationId];
        });
      }
    },

    // `agentSendPrompt` resolves when the agent finishes the turn, so the
    // session stays "running" for the whole turn instead of flickering per
    // streamed chunk. Session status, not `loading`, tracks the turn.
    sendPrompt: async (sessionId, content) => {
      const session = Object.values(get().sessions).find((ss) => ss.sessionId === sessionId);
      if (!session) {
        set((s) => { s.error = `no such session ${sessionId}`; });
        return;
      }
      set((s) => {
        s.sessions[session.conversationId].status = "running";
        s.error = null;
      });
      try {
        await agentSendPrompt(sessionId, content);
      } catch (err) {
        set((s) => { s.error = errorMessage(err); });
      } finally {
        set((s) => {
          if (s.sessions[session.conversationId]) s.sessions[session.conversationId].status = "idle";
          delete s.streamingMessageId[session.conversationId];
        });
      }
    },

    cancel: async (sessionId) => {
      set((s) => { s.error = null; });
      try {
        await agentCancel(sessionId);
      } catch (err) {
        set((s) => { s.error = errorMessage(err); });
      } finally {
        set((s) => {
          const session = Object.values(s.sessions).find((ss) => ss.sessionId === sessionId);
          if (session) session.status = "idle";
          // Cancel resolves the session's pending permissions as Cancelled on
          // the backend; drop them so the modal cannot stick on dead requests.
          delete s.permissionQueues[sessionId];
          if (s.pendingPermission?.sessionId === sessionId) {
            s.pendingPermission = nextPendingPermission(s.permissionQueues);
          }
        });
      }
    },

    respondPermission: async (requestId, optionId) => {
      set((s) => { s.error = null; });
      try {
        await agentRespondPermission(requestId, optionId);
      } catch (err) {
        set((s) => { s.error = errorMessage(err); });
      } finally {
        // Advance on success AND failure: the request is gone either way
        // (unknown-id responses error), so the modal must still close.
        set((s) => {
          for (const [sessionId, queue] of Object.entries(s.permissionQueues)) {
            const idx = queue.findIndex((q) => q.requestId === requestId);
            if (idx !== -1) {
              queue.splice(idx, 1);
              if (queue.length === 0) delete s.permissionQueues[sessionId];
              break;
            }
          }
          s.pendingPermission = nextPendingPermission(s.permissionQueues);
        });
      }
    },

    loadServers: async () => {
      set((s) => { s.serversLoading = true; });
      try {
        const servers = await agentListServers();
        set((s) => { s.servers = servers; });
      } catch (err) {
        set((s) => { s.error = errorMessage(err); });
      } finally {
        set((s) => { s.serversLoading = false; });
      }
    },

    refreshRegistry: async () => {
      set((s) => { s.serversLoading = true; s.error = null; });
      try {
        await agentRefreshRegistry();
        const servers = await agentListServers();
        set((s) => { s.servers = servers; });
      } catch (err) {
        set((s) => { s.error = errorMessage(err); });
      } finally {
        set((s) => { s.serversLoading = false; });
      }
    },

    upsertCustom: async (server) => {
      set((s) => { s.error = null; });
      try {
        await agentCustomUpsert(server);
        const servers = await agentListServers();
        set((s) => { s.servers = servers; });
      } catch (err) {
        set((s) => { s.error = errorMessage(err); });
        throw err;
      }
    },

    deleteCustom: async (id) => {
      set((s) => { s.error = null; });
      try {
        await agentCustomDelete(id);
        const servers = await agentListServers();
        set((s) => { s.servers = servers; });
      } catch (err) {
        set((s) => { s.error = errorMessage(err); });
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
        const parsed = parseSessionUpdate(update);
        if (!parsed) return;

        const conversationId = session.conversationId;
        const convStore = useConversationStore.getState();

        if (parsed.toolSummary) {
          const msg: Message = {
            id: crypto.randomUUID(),
            conversation_id: conversationId,
            role: "assistant",
            content: "",
            tool_summary: parsed.toolSummary,
            timestamp: Date.now(),
            sequence: 0,
          };
          convStore.appendMessage(conversationId, msg);
          return;
        }

        // Agents stream a turn as many small chunks; accumulate them into one
        // assistant message instead of one bubble per chunk.
        const streamingId = get().streamingMessageId[conversationId];
        const existing = streamingId
          ? (convStore.messagesByConversation[conversationId] ?? []).find((m) => m.id === streamingId)
          : undefined;
        if (existing) {
          convStore.updateMessageContent(conversationId, existing.id, existing.content + parsed.text);
        } else {
          const msg: Message = {
            id: crypto.randomUUID(),
            conversation_id: conversationId,
            role: parsed.role,
            content: parsed.text,
            tool_summary: null,
            timestamp: Date.now(),
            sequence: 0,
          };
          convStore.appendMessage(conversationId, msg);
          set((s) => { s.streamingMessageId[conversationId] = msg.id; });
        }
      }).then((fn) => { if (disposed) fn(); else unlistenNotification = fn; });

      onAgentPermissionRequest((payload) => {
        set((s) => {
          if (!s.permissionQueues[payload.sessionId]) s.permissionQueues[payload.sessionId] = [];
          s.permissionQueues[payload.sessionId].push(payload);
          // FIFO: only show this request if nothing is currently displayed.
          if (!s.pendingPermission) s.pendingPermission = payload;
        });
      }).then((fn) => { if (disposed) fn(); else unlistenPermission = fn; });

      onAgentSessionTerminated(({ sessionId }) => {
        set((s) => {
          const session = Object.values(s.sessions).find((ss) => ss.sessionId === sessionId);
          if (session) {
            delete s.sessions[session.conversationId];
            delete s.streamingMessageId[session.conversationId];
          }
          delete s.permissionQueues[sessionId];
          if (s.pendingPermission?.sessionId === sessionId) {
            s.pendingPermission = nextPendingPermission(s.permissionQueues);
          }
        });
      }).then((fn) => { if (disposed) fn(); else unlistenTerminated = fn; });

      listenerTeardown = () => {
        disposed = true;
        unlistenNotification?.();
        unlistenPermission?.();
        unlistenTerminated?.();
        listenerTeardown = null;
      };
      return listenerTeardown;
    },
  }))
);
