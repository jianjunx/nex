import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import type { UnlistenFn } from "@tauri-apps/api/event";
import {
  acpCreateSession,
  acpSendPrompt,
  acpCancel,
  acpRespondPermission,
  onAcpNotification,
  onAcpPermissionRequest,
  onAcpSessionTerminated,
  type Message,
} from "../bridge/tauri";
import type { AcpPermissionRequestPayload } from "../bridge/events";
import { useConversationStore } from "./conversation.store";

export interface AgentSession {
  sessionId: string;
  conversationId: string;
  status: "idle" | "running" | "waiting";
}

interface AgentStore {
  sessions: Record<string, AgentSession>; // keyed by conversationId
  /** Outstanding ACP permission requests, FIFO per session (keyed by sessionId). */
  permissionQueues: Record<string, AcpPermissionRequestPayload[]>;
  /** The permission request currently shown in the modal (head of the first non-empty queue). */
  pendingPermission: AcpPermissionRequestPayload | null;
  /** conversationId -> id of the assistant message currently accumulating stream chunks. */
  streamingMessageId: Record<string, string>;
  loading: boolean;
  error: string | null;

  createSession: (conversationId: string, agentCommand: string, cwd: string) => Promise<string>;
  sendPrompt: (sessionId: string, content: string) => Promise<void>;
  cancel: (sessionId: string) => Promise<void>;
  respondPermission: (requestId: string, optionId: string | null) => Promise<void>;
  /** Subscribes to ACP events. Returns an unlisten cleanup; safe to call from a StrictMode effect. */
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
  queues: Record<string, AcpPermissionRequestPayload[]>,
): AcpPermissionRequestPayload | null {
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
    loading: false,
    error: null,

    createSession: async (conversationId, agentCommand, cwd) => {
      set((s) => { s.loading = true; s.error = null; });
      try {
        const sessionId = await acpCreateSession(conversationId, agentCommand, cwd);
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

    // `acpSendPrompt` resolves when the agent finishes the turn, so the
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
        await acpSendPrompt(sessionId, content);
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
        await acpCancel(sessionId);
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
        await acpRespondPermission(requestId, optionId);
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

    initListeners: () => {
      if (listenerTeardown) return listenerTeardown;
      let disposed = false;
      let unlistenNotification: UnlistenFn | null = null;
      let unlistenPermission: UnlistenFn | null = null;
      let unlistenTerminated: UnlistenFn | null = null;

      onAcpNotification(({ sessionId, update }) => {
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

      onAcpPermissionRequest((payload) => {
        set((s) => {
          if (!s.permissionQueues[payload.sessionId]) s.permissionQueues[payload.sessionId] = [];
          s.permissionQueues[payload.sessionId].push(payload);
          // FIFO: only show this request if nothing is currently displayed.
          if (!s.pendingPermission) s.pendingPermission = payload;
        });
      }).then((fn) => { if (disposed) fn(); else unlistenPermission = fn; });

      onAcpSessionTerminated(({ sessionId }) => {
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
