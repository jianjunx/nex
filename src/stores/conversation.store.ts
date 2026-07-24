import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { conversationCreate, conversationList, conversationGetMessages, type Conversation, type Message } from "../bridge/tauri";

interface ConversationStore {
  conversationsByProject: Record<string, Conversation[]>;
  openTabs: string[];
  activeTabId: string | null;
  messagesByConversation: Record<string, Message[]>;
  loading: boolean;
  error: string | null;

  loadConversations: (projectId: string) => Promise<void>;
  createConversation: (projectId: string, agentType: string) => Promise<Conversation>;
  switchTab: (id: string) => void;
  closeTab: (id: string) => void;
  loadMessages: (conversationId: string) => Promise<void>;
  appendMessage: (conversationId: string, message: Message) => void;
  updateMessageContent: (conversationId: string, messageId: string, content: string) => void;
}

// Backend errors arrive as { type, message }; fall back to String(err).
function errorMessage(err: unknown): string {
  if (err && typeof err === "object" && "message" in err && typeof (err as { message: unknown }).message === "string") {
    return (err as { message: string }).message;
  }
  return String(err);
}

export const useConversationStore = create<ConversationStore>()(
  immer((set) => ({
    conversationsByProject: {},
    openTabs: [],
    activeTabId: null,
    messagesByConversation: {},
    loading: false,
    error: null,

    loadConversations: async (projectId: string) => {
      set((s) => { s.loading = true; s.error = null; });
      try {
        const convs = await conversationList(projectId);
        set((s) => { s.conversationsByProject[projectId] = convs; });
      } catch (err) {
        set((s) => { s.error = errorMessage(err); });
      } finally {
        set((s) => { s.loading = false; });
      }
    },

    createConversation: async (projectId: string, agentType: string) => {
      set((s) => { s.loading = true; s.error = null; });
      try {
        const conv = await conversationCreate(projectId, agentType);
        set((s) => {
          if (!s.conversationsByProject[projectId]) s.conversationsByProject[projectId] = [];
          s.conversationsByProject[projectId].unshift(conv);
          s.openTabs.push(conv.id);
          s.activeTabId = conv.id;
        });
        return conv;
      } catch (err) {
        set((s) => { s.error = errorMessage(err); });
        throw err;
      } finally {
        set((s) => { s.loading = false; });
      }
    },

    switchTab: (id: string) => {
      set((s) => { s.activeTabId = id; });
    },

    closeTab: (id: string) => {
      set((s) => {
        s.openTabs = s.openTabs.filter((t) => t !== id);
        if (s.activeTabId === id) {
          s.activeTabId = s.openTabs[s.openTabs.length - 1] || null;
        }
      });
    },

    loadMessages: async (conversationId: string) => {
      set((s) => { s.loading = true; s.error = null; });
      try {
        const msgs = await conversationGetMessages(conversationId);
        set((s) => { s.messagesByConversation[conversationId] = msgs; });
      } catch (err) {
        set((s) => { s.error = errorMessage(err); });
      } finally {
        set((s) => { s.loading = false; });
      }
    },

    appendMessage: (conversationId: string, message: Message) => {
      set((s) => {
        if (!s.messagesByConversation[conversationId]) s.messagesByConversation[conversationId] = [];
        s.messagesByConversation[conversationId].push(message);
      });
    },

    updateMessageContent: (conversationId: string, messageId: string, content: string) => {
      set((s) => {
        const msg = s.messagesByConversation[conversationId]?.find((m) => m.id === messageId);
        if (msg) msg.content = content;
      });
    },
  }))
);
