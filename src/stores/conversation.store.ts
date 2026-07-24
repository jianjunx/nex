import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { conversationCreate, conversationList, conversationGetMessages, type Conversation, type Message } from "../bridge/tauri";

interface ConversationStore {
  conversationsByProject: Record<string, Conversation[]>;
  openTabs: string[];
  activeTabId: string | null;
  messagesByConversation: Record<string, Message[]>;

  loadConversations: (projectId: string) => Promise<void>;
  createConversation: (projectId: string, agentType: string) => Promise<Conversation>;
  switchTab: (id: string) => void;
  closeTab: (id: string) => void;
  loadMessages: (conversationId: string) => Promise<void>;
  appendMessage: (conversationId: string, message: Message) => void;
}

export const useConversationStore = create<ConversationStore>()(
  immer((set) => ({
    conversationsByProject: {},
    openTabs: [],
    activeTabId: null,
    messagesByConversation: {},

    loadConversations: async (projectId: string) => {
      const convs = await conversationList(projectId);
      set((s) => { s.conversationsByProject[projectId] = convs; });
    },

    createConversation: async (projectId: string, agentType: string) => {
      const conv = await conversationCreate(projectId, agentType);
      set((s) => {
        if (!s.conversationsByProject[projectId]) s.conversationsByProject[projectId] = [];
        s.conversationsByProject[projectId].unshift(conv);
        s.openTabs.push(conv.id);
        s.activeTabId = conv.id;
      });
      return conv;
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
      const msgs = await conversationGetMessages(conversationId);
      set((s) => { s.messagesByConversation[conversationId] = msgs; });
    },

    appendMessage: (conversationId: string, message: Message) => {
      set((s) => {
        if (!s.messagesByConversation[conversationId]) s.messagesByConversation[conversationId] = [];
        s.messagesByConversation[conversationId].push(message);
      });
    },
  }))
);
