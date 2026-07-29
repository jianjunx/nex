import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { persist } from "zustand/middleware";
import {
  conversationCreate,
  conversationList,
  conversationGetMessages,
  conversationUpdateTitle,
  type Conversation,
  type Message,
} from "../bridge/tauri";
import { useProjectStore } from "./project.store";
import {
  DEFAULT_CONVERSATION_TITLE,
  deriveConversationTitle,
} from "../features/agent/deriveConversationTitle";

export type LegacyTabsMigration = { tabs: string[]; activeId: string | null };

interface ConversationStore {
  conversationsByProject: Record<string, Conversation[]>;
  tabsByProject: Record<string, string[]>;
  activeTabByProject: Record<string, string | null>;
  /** One-shot stash from v0 persist; App applies then clearLegacyTabsMigration() */
  legacyTabsMigration: LegacyTabsMigration | null;
  messagesByConversation: Record<string, Message[]>;
  loading: boolean;
  error: string | null;

  /** Returns the list on success; `null` on failure (error set on store). */
  loadConversations: (projectId: string) => Promise<Conversation[] | null>;
  createConversation: (projectId: string, agentType: string) => Promise<Conversation>;
  switchTab: (id: string) => void;
  closeTab: (id: string) => void;
  /** Persist a new title and update the in-memory conversation list. */
  renameConversation: (conversationId: string, title: string) => Promise<void>;
  /**
   * If the conversation still has the default "New Chat" title, rename it from
   * the first user message. No-op once the title has been customized.
   */
  autoTitleFromFirstMessage: (conversationId: string, text: string) => void;
  loadMessages: (conversationId: string) => Promise<void>;
  appendMessage: (conversationId: string, message: Message) => void;
  updateMessageContent: (conversationId: string, messageId: string, content: string) => void;
  restoreTabs: (
    projectId: string,
    candidateTabs: string[],
    candidateActiveId: string | null,
    validIds: Set<string>,
  ) => void;
  clearLegacyTabsMigration: () => void;
}

/** Stable empty tabs — never allocate in selectors (breaks useSyncExternalStore). */
const EMPTY_TABS: string[] = [];

export function selectProjectOpenTabs(
  s: Pick<ConversationStore, "tabsByProject">,
  projectId: string | null | undefined,
): string[] {
  if (!projectId) return EMPTY_TABS;
  return s.tabsByProject[projectId] ?? EMPTY_TABS;
}

export function selectProjectActiveTabId(
  s: Pick<ConversationStore, "activeTabByProject">,
  projectId: string | null | undefined,
): string | null {
  if (!projectId) return null;
  return s.activeTabByProject[projectId] ?? null;
}

/** Exported for unit tests; also wired as persist.migrate */
export function migrateConversationPersist(
  persistedState: unknown,
  version: number,
): {
  tabsByProject: Record<string, string[]>;
  activeTabByProject: Record<string, string | null>;
  legacyTabsMigration: LegacyTabsMigration | null;
} {
  const old = (persistedState ?? {}) as {
    openTabs?: string[];
    activeTabId?: string | null;
    tabsByProject?: Record<string, string[]>;
    activeTabByProject?: Record<string, string | null>;
    legacyTabsMigration?: LegacyTabsMigration | null;
  };

  if (version >= 1) {
    return {
      tabsByProject: old.tabsByProject ?? {},
      activeTabByProject: old.activeTabByProject ?? {},
      legacyTabsMigration: old.legacyTabsMigration ?? null,
    };
  }

  const legacy =
    Array.isArray(old.openTabs) && old.openTabs.length > 0
      ? { tabs: old.openTabs, activeId: old.activeTabId ?? null }
      : null;

  return {
    tabsByProject: old.tabsByProject ?? {},
    activeTabByProject: old.activeTabByProject ?? {},
    legacyTabsMigration: old.legacyTabsMigration ?? legacy,
  };
}

function errorMessage(err: unknown): string {
  if (err && typeof err === "object" && "message" in err && typeof (err as { message: unknown }).message === "string") {
    return (err as { message: string }).message;
  }
  return String(err);
}

export const useConversationStore = create<ConversationStore>()(
  persist(
    immer((set) => ({
      conversationsByProject: {},
      tabsByProject: {},
      activeTabByProject: {},
      legacyTabsMigration: null,
      messagesByConversation: {},
      loading: false,
      error: null,

      loadConversations: async (projectId: string) => {
        set((s) => {
          s.loading = true;
          s.error = null;
        });
        try {
          const convs = await conversationList(projectId);
          set((s) => {
            s.conversationsByProject[projectId] = convs;
          });
          return convs;
        } catch (err) {
          set((s) => {
            s.error = errorMessage(err);
          });
          return null;
        } finally {
          set((s) => {
            s.loading = false;
          });
        }
      },

      createConversation: async (projectId: string, agentType: string) => {
        set((s) => {
          s.loading = true;
          s.error = null;
        });
        try {
          const conv = await conversationCreate(projectId, agentType);
          set((s) => {
            if (!s.conversationsByProject[projectId]) s.conversationsByProject[projectId] = [];
            s.conversationsByProject[projectId].unshift(conv);
            const tabs = s.tabsByProject[projectId] ?? [];
            tabs.push(conv.id);
            s.tabsByProject[projectId] = tabs;
            s.activeTabByProject[projectId] = conv.id;
          });
          return conv;
        } catch (err) {
          set((s) => {
            s.error = errorMessage(err);
          });
          throw err;
        } finally {
          set((s) => {
            s.loading = false;
          });
        }
      },

      switchTab: (id: string) => {
        const projectId = useProjectStore.getState().activeProjectId;
        if (!projectId) return;
        set((s) => {
          s.activeTabByProject[projectId] = id;
        });
      },

      closeTab: (id: string) => {
        const projectId = useProjectStore.getState().activeProjectId;
        if (!projectId) return;
        set((s) => {
          const tabs = (s.tabsByProject[projectId] ?? []).filter((t) => t !== id);
          s.tabsByProject[projectId] = tabs;
          if (s.activeTabByProject[projectId] === id) {
            s.activeTabByProject[projectId] = tabs[tabs.length - 1] || null;
          }
        });
      },

      renameConversation: async (conversationId, title) => {
        const trimmed = title.trim();
        if (!trimmed) return;
        await conversationUpdateTitle(conversationId, trimmed);
        set((s) => {
          for (const list of Object.values(s.conversationsByProject)) {
            const conv = list.find((c) => c.id === conversationId);
            if (conv) {
              conv.title = trimmed;
              conv.updated_at = Date.now();
              break;
            }
          }
        });
      },

      autoTitleFromFirstMessage: (conversationId, text) => {
        let shouldRename = false;
        for (const list of Object.values(useConversationStore.getState().conversationsByProject)) {
          const conv = list.find((c) => c.id === conversationId);
          if (conv) {
            shouldRename = conv.title === DEFAULT_CONVERSATION_TITLE;
            break;
          }
        }
        if (!shouldRename) return;
        const next = deriveConversationTitle(text);
        if (next === DEFAULT_CONVERSATION_TITLE) return;
        void useConversationStore.getState().renameConversation(conversationId, next);
      },

      loadMessages: async (conversationId: string) => {
        set((s) => {
          s.loading = true;
          s.error = null;
        });
        try {
          const msgs = await conversationGetMessages(conversationId);
          set((s) => {
            s.messagesByConversation[conversationId] = msgs;
          });
        } catch (err) {
          set((s) => {
            s.error = errorMessage(err);
          });
        } finally {
          set((s) => {
            s.loading = false;
          });
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

      restoreTabs: (projectId, candidateTabs, candidateActiveId, validIds) => {
        set((s) => {
          const valid = candidateTabs.filter((id) => validIds.has(id));
          s.tabsByProject[projectId] = valid;
          s.activeTabByProject[projectId] =
            candidateActiveId && valid.includes(candidateActiveId)
              ? candidateActiveId
              : (valid[valid.length - 1] ?? null);
        });
      },

      clearLegacyTabsMigration: () => {
        set((s) => {
          s.legacyTabsMigration = null;
        });
      },
    })),
    {
      name: "nex-conversations",
      version: 1,
      migrate: (persistedState, version) => migrateConversationPersist(persistedState, version),
      partialize: (s) => ({
        tabsByProject: s.tabsByProject,
        activeTabByProject: s.activeTabByProject,
        legacyTabsMigration: s.legacyTabsMigration,
      }),
    },
  ),
);
