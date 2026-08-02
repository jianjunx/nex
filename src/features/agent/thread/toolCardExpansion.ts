import { create } from "zustand";

interface ToolCardExpansionState {
  /** key = toolCallId(流式 upsert 的稳定键),value = 用户显式设置的展开态。 */
  overrides: Record<string, boolean>;
  setExpanded: (toolCallId: string, open: boolean) => void;
}

/**
 * 工具卡展开状态外提:虚拟化会卸载/重挂离屏行,组件内 useState 会丢。
 * 未显式设置(undefined)时由组件回退默认规则(edit/waiting 默认展开)。
 * 不 persist:展开态是会话级临时 UI 状态。
 */
export const useToolCardExpansionStore = create<ToolCardExpansionState>()((set) => ({
  overrides: {},
  setExpanded: (toolCallId, open) =>
    set((s) => ({ overrides: { ...s.overrides, [toolCallId]: open } })),
}));
