import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { persist } from "zustand/middleware";
import { errorMessage } from "../lib/errors";
  conversationList,
  conversationGetMessages,
  conversationUpdateTitle,
  conversationAppendMessage,
  type Conversation,
  type Message,
} from "../bridge/tauri";
import { useProjectStore } from "./project.store";
import { useAgentStore } from "./agent.store";
import { clearComposerDraft } from "./composerDrafts";
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
  /** Drop all in-memory state for a removed project (tabs, messages, entries). */
  removeProjectData: (projectId: string) => void;
  /** Reorder open conversation tabs for the active project. */
  reorderTabs: (fromIndex: number, toIndex: number) => void;
  /** Persist a new title and update the in-memory conversation list. */
  renameConversation: (conversationId: string, title: string) => Promise<void>;
  /**
   * If the conversation still has the default "New Chat" title, rename it from
   * the first user message. No-op once the title has been customized.
   */
  autoTitleFromFirstMessage: (conversationId: string, text: string) => void;
  loadMessages: (conversationId: string) => Promise<Message[] | null>;
  appendMessage: (conversationId: string, message: Message) => void;
  /** Persist a turn message to SQLite (and mirror into messagesByConversation). */
  persistMessage: (
    conversationId: string,
    role: "user" | "assistant",
    content: string,
  ) => Promise<void>;
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
const EMPTY_CONVERSATIONS: Conversation[] = [];

/** loadMessages 分页大小:与 bridge 默认 limit 一致,循环翻页取完全部历史。 */
const MESSAGE_PAGE_SIZE = 50;
/** 防异常超大会话把 UI 拖死；50×200 = 1 万条上限。 */
const MESSAGE_MAX_PAGES = 200;

/**
 * Per-conversation monotonic id so a slow loadMessages cannot overwrite a
 * newer load OF THE SAME conversation. A global counter used to cancel
 * concurrent loads of DIFFERENT conversations (parallel tab restore),
 * silently dropping their history.
 */
const loadMessagesGenerations = new Map<string, number>();

export function selectProjectOpenTabs(
  s: Pick<ConversationStore, "tabsByProject">,
  projectId: string | null | undefined,
): string[] {
  if (!projectId) return EMPTY_TABS;
  return s.tabsByProject[projectId] ?? EMPTY_TABS;
}

export function selectProjectConversations(
  s: Pick<ConversationStore, "conversationsByProject">,
  projectId: string | null | undefined,
): Conversation[] {
  if (!projectId) return EMPTY_CONVERSATIONS;
  return s.conversationsByProject[projectId] ?? EMPTY_CONVERSATIONS;
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
            tabs.unshift(conv.id);
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
          // 只切换激活态，不立刻重排页签顺序；恢复会话（restoreTabs）时
          // 再把最近活动的页签排到最前，避免点击时页签跳动。
          s.activeTabByProject[projectId] = id;
        });
      },

      closeTab: (id: string) => {
        const projectId = useProjectStore.getState().activeProjectId;
        if (!projectId) return;
        clearComposerDraft(id);
        set((s) => {
          const tabs = (s.tabsByProject[projectId] ?? []).filter((t) => t !== id);
          s.tabsByProject[projectId] = tabs;
          if (s.activeTabByProject[projectId] === id) {
            s.activeTabByProject[projectId] = tabs[tabs.length - 1] || null;
          }
        });
      },

      removeProjectData: (projectId) => {
        const convs = useConversationStore.getState().conversationsByProject[projectId] ?? [];
        const ids = convs.map((c) => c.id);
        for (const c of convs) {
          clearComposerDraft(c.id);
          // Close the agent session (backend + in-memory entries) if any.
          void useAgentStore.getState().removeSession(c.id);
        }
        // Sessions that never started have no in-memory session object, but
        // may still have hydrated threads — drop them unconditionally.
        useAgentStore.getState().removeConversationEntries(ids);
        set((s) => {
          delete s.conversationsByProject[projectId];
          delete s.tabsByProject[projectId];
          delete s.activeTabByProject[projectId];
          for (const c of convs) {
            delete s.messagesByConversation[c.id];
          }
        });
      },

      reorderTabs: (fromIndex, toIndex) => {
        const projectId = useProjectStore.getState().activeProjectId;
        if (!projectId) return;
        set((s) => {
          const tabs = s.tabsByProject[projectId] ?? [];
          if (fromIndex < 0 || fromIndex >= tabs.length || toIndex < 0 || toIndex >= tabs.length) return;
          if (fromIndex === toIndex) return;
          const [item] = tabs.splice(fromIndex, 1);
          tabs.splice(toIndex, 0, item);
          s.tabsByProject[projectId] = tabs;
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
        const generation = (loadMessagesGenerations.get(conversationId) ?? 0) + 1;
        loadMessagesGenerations.set(conversationId, generation);
        const isStale = () => generation !== loadMessagesGenerations.get(conversationId);
        set((s) => {
          s.loading = true;
          s.error = null;
        });
        try {
          // 分页取完全部历史:旧实现只取首页 50 条,长会话旧消息静默丢失。
          const all: Message[] = [];
          let offset = 0;
          for (let pageIdx = 0; pageIdx < MESSAGE_MAX_PAGES; pageIdx++) {
            if (isStale()) return null;
            const page = await conversationGetMessages(conversationId, MESSAGE_PAGE_SIZE, offset);
            all.push(...page);
            if (page.length < MESSAGE_PAGE_SIZE) break;
            offset += MESSAGE_PAGE_SIZE;
          }
          if (isStale()) return null;
          set((s) => {
            s.messagesByConversation[conversationId] = all;
          });
          return all;
        } catch (err) {
          if (isStale()) return null;
          set((s) => {
            s.error = errorMessage(err);
          });
          return null;
        } finally {
          if (!isStale()) {
            set((s) => {
              s.loading = false;
            });
          }
        }
      },

      appendMessage: (conversationId: string, message: Message) => {
        set((s) => {
          if (!s.messagesByConversation[conversationId]) s.messagesByConversation[conversationId] = [];
          s.messagesByConversation[conversationId].push(message);
        });
      },

      persistMessage: async (conversationId, role, content) => {
        const trimmed = content.trim();
        if (!trimmed) return;
        try {
          const msg = await conversationAppendMessage(conversationId, role, trimmed);
          set((s) => {
            if (!s.messagesByConversation[conversationId]) s.messagesByConversation[conversationId] = [];
            s.messagesByConversation[conversationId].push(msg);
          });
        } catch (err) {
          console.error("[conversation] persistMessage failed:", err);
        }
      },

      updateMessageContent: (conversationId: string, messageId: string, content: string) => {
        set((s) => {
          const msg = s.messagesByConversation[conversationId]?.find((m) => m.id === messageId);
          if (msg) msg.content = content;
        });
      },

      restoreTabs: (projectId, candidateTabs, candidateActiveId, validIds) => {
        set((s) => {
          let valid = candidateTabs.filter((id) => validIds.has(id));
          const active =
            candidateActiveId && valid.includes(candidateActiveId)
              ? candidateActiveId
              : (valid[valid.length - 1] ?? null);
          // 恢复时把最近活动的页签排到最前（点击切换时不立刻重排）。
          if (active) {
            const idx = valid.indexOf(active);
            if (idx > 0) {
              valid = [active, ...valid.filter((id) => id !== active)];
            }
          }
          s.tabsByProject[projectId] = valid;
          s.activeTabByProject[projectId] = active;
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
