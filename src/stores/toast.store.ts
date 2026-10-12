import { create } from "zustand";
import { immer } from "zustand/middleware/immer";

/**
 * 轻提示（toast）——一次性操作的结果反馈，与 notification.store 的"Agent
 * 请求确认"是两回事：那个要点跳转、按会话去重，这个只负责告诉用户"刚才那下
 * 成没成"，到点自己消失。
 */
export type ToastVariant = "success" | "error" | "info";

export interface AppToast {
  id: string;
  variant: ToastVariant;
  /** 一句话结论，如「推送成功」。 */
  message: string;
  /** 可选补充说明（失败原因首行等）。 */
  detail?: string;
}

interface ToastStore {
  items: AppToast[];
  push: (t: Omit<AppToast, "id">) => void;
  dismiss: (id: string) => void;
}

const MAX_ITEMS = 4;

export const useToastStore = create<ToastStore>()(
  immer((set) => ({
    items: [],

    push: (t) => {
      set((s) => {
        // 同文案的连续提示合并：连点几次「刷新」不要刷出一屏。
        const dup = s.items.findIndex((x) => x.variant === t.variant && x.message === t.message);
        if (dup >= 0) s.items.splice(dup, 1);
        s.items.unshift({ ...t, id: crypto.randomUUID() });
        if (s.items.length > MAX_ITEMS) s.items.length = MAX_ITEMS;
      });
    },

    dismiss: (id) => {
      set((s) => {
        const i = s.items.findIndex((x) => x.id === id);
        if (i >= 0) s.items.splice(i, 1);
      });
    },
  })),
);

/** 非 React 代码（store 内部）推提示的便捷入口。 */
export function toast(t: Omit<AppToast, "id">): void {
  useToastStore.getState().push(t);
}
