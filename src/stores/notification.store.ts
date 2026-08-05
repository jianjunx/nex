import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { fsWatchStart } from "../bridge/tauri";
import { useProjectStore } from "./project.store";
import { useConversationStore } from "./conversation.store";
import { useFsStore } from "./fs.store";
import { useClipboardStore } from "./clipboard.store";

/** 软件内通知（Agent 请求确认等），从左上角滑入，点击跳转到对应项目会话。 */
export interface AppNotification {
  id: string;
  title: string;
  body: string;
  projectId: string | null;
  conversationId: string;
}

interface NotificationStore {
  items: AppNotification[];
  push: (n: Omit<AppNotification, "id">) => void;
  dismiss: (id: string) => void;
  /** 点击通知：切换到目标项目并激活目标会话。 */
  activate: (id: string) => void;
}

const MAX_ITEMS = 5;

export const useNotificationStore = create<NotificationStore>()(
  immer((set, get) => ({
    items: [],

    push: (n) => {
      set((s) => {
        s.items.unshift({ ...n, id: crypto.randomUUID() });
        if (s.items.length > MAX_ITEMS) s.items.length = MAX_ITEMS;
      });
    },

    dismiss: (id) => {
      set((s) => {
        const i = s.items.findIndex((x) => x.id === id);
        if (i >= 0) s.items.splice(i, 1);
      });
    },

    activate: (id) => {
      const n = get().items.find((x) => x.id === id);
      get().dismiss(id);
      if (!n) return;
      const conv = useConversationStore.getState();
      const activeProjectId = useProjectStore.getState().activeProjectId;
      // 同项目：直接切页签。
      if (!n.projectId || n.projectId === activeProjectId) {
        conv.switchTab(n.conversationId);
        return;
      }
      // 跨项目：复用 ProjectSelector 的切换流程（不裁剪线程缓存，避免依赖 agent.store 造成循环导入）。
      const projectId = n.projectId;
      const conversationId = n.conversationId;
      void (async () => {
        const fs = useFsStore.getState();
        const oldId = useProjectStore.getState().activeProjectId;
        if (oldId && oldId !== projectId) {
          await fs.saveCurrentEditorState(oldId);
        }
        const project = useProjectStore.getState().projects.find((p) => p.id === projectId);
        useProjectStore.getState().switchProject(projectId);
        fs.clearTreeExcept(project?.path ?? "");
        useClipboardStore.getState().clear();
        fs.switchSearchProject(projectId);
        await Promise.all([
          fs.loadEditorState(projectId),
          (async () => {
            const c = useConversationStore.getState();
            const convs = await c.loadConversations(projectId);
            const tabs = useConversationStore.getState().tabsByProject[projectId] ?? [];
            // 目标会话未在页签内（如页签已关）则补开一个。
            if (convs && !tabs.includes(conversationId)) {
              const valid = new Set(convs.map((x) => x.id));
              if (valid.has(conversationId)) {
                c.restoreTabs(projectId, [...tabs, conversationId], conversationId, valid);
              }
            }
          })(),
          fsWatchStart(project?.path ?? "").catch(() => {}),
        ]);
        useConversationStore.getState().switchTab(conversationId);
      })();
    },
  })),
);
