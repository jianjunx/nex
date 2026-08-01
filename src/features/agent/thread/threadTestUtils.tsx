/**
 * 线程视图的测试/开发基建。仅被 .test.tsx 与 DEV-only 动态 import 引用,
 * 不进生产 bundle。
 */
import { useAgentStore } from "../../../stores/agent.store";
import { useProjectStore } from "../../../stores/project.store";
import { useConversationStore } from "../../../stores/conversation.store";
import type { ThreadEntry } from "./types";

/** 把 ThreadView 所需的三个 store 摆成"项目 p1、指定活动 tab、给定 entries"的状态。 */
export function setupThreadStores(
  activeTabId: string,
  entriesByConversation: Record<string, ThreadEntry[]>,
) {
  useProjectStore.setState({ activeProjectId: "p1" });
  useConversationStore.setState((s) => {
    s.tabsByProject = { p1: Object.keys(entriesByConversation) };
    s.activeTabByProject = { p1: activeTabId };
  });
  useAgentStore.setState((s) => {
    s.entriesByConversation = entriesByConversation;
  });
}
