/** Explicit development-only fixture. This entry is not in the production build. */
import { createRoot } from "react-dom/client";
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { MainLayout } from "@/features/layout/MainLayout";
import { SidePanel } from "@/features/layout/SidePanel";
import { ChatArea } from "@/features/agent/ChatArea";
import { SettingsDialog } from "@/features/settings/SettingsDialog";
import { useProjectStore } from "@/stores/project.store";
import { useConversationStore } from "@/stores/conversation.store";
import { useAgentStore } from "@/stores/agent.store";
import { useUiStore } from "@/stores/ui.store";
import { useFsStore } from "@/stores/fs.store";
import "@/styles/globals.css";
import "@/components/agent-ui/styles.css";
import "@/styles/agent-ui.css";

if (!import.meta.env.DEV) throw new Error("UI preview is development-only");
mockWindows("main");
mockIPC(
  (command) => {
    if (command === "plugin:window|is_fullscreen") return false;
    if (
      command === "fs_read_tree" ||
      command === "agent_list_servers" ||
      command === "conversation_get_messages"
    )
      return [];
    if (command.startsWith("plugin:")) return null;
    throw new Error(`开发预览不执行后端命令：${command}`);
  },
  { shouldMockEvents: true },
);
const now = Math.floor(Date.now() / 1000);
useProjectStore.setState({
  activeProjectId: "preview",
  projects: [
    {
      id: "preview",
      name: "Nex · 界面预览",
      path: "/preview/nex",
      created_at: now,
      last_opened: now,
    },
  ],
});
useConversationStore.setState({
  tabsByProject: { preview: ["preview-chat"] },
  activeTabByProject: { preview: "preview-chat" },
  conversationsByProject: {
    preview: [
      {
        id: "preview-chat",
        project_id: "preview",
        title: "改造工作台界面",
        agent_type: "nex",
        status: "active",
        created_at: now,
        updated_at: now,
      },
    ],
  },
});
useUiStore.setState({
  overviewOpen: false,
  sidePanelVisible: true,
  sidePanelTab: "files",
  sidePanelWidth: 260,
  settingsOpen: false,
  terminalVisible: false,
});
useFsStore.setState({
  openFiles: [
    {
      path: "/preview/nex/src/App.tsx",
      content: "export default function App() {\n  return <Workspace />;\n}",
      draft: "export default function App() {\n  return <Workspace />;\n}",
      isText: true,
      size: 64,
      dirty: false,
      stale: false,
      pinned: true,
    },
  ],
});
useAgentStore.setState({
  sessions: {
    "preview-chat": {
      sessionId: "preview-session",
      conversationId: "preview-chat",
      status: "idle",
    },
  },
  entriesByConversation: {
    "preview-chat": [
      {
        id: "user",
        kind: "user_message",
        timestamp: now,
        text: "使用新的 20 个组件，统一改造 Nex 的工作台界面。",
      },
      {
        id: "assistant",
        kind: "assistant_message",
        timestamp: now,
        chunks: [
          {
            type: "thought",
            text: "检查界面的组件边界，将现有交互接入新的视觉组件。",
          },
          {
            type: "message",
            text: "已建立统一的工作台布局。导航、会话与编辑区域使用共享的界面规范。\n\n```tsx\nexport function Workspace() {\n  return <ChatArea />;\n}\n```\n\n接下来验证审批、文件操作和键盘交互。",
          },
        ],
      },
      {
        id: "tool",
        kind: "tool_call",
        timestamp: now,
        toolCallId: "tool",
        title: "读取 src/App.tsx",
        toolKind: "read",
        status: "completed",
        content: [{ type: "text", text: "已读取工作台入口组件。" }],
      },
    ],
  },
});
createRoot(document.getElementById("root")!).render(
  <>
    <div
      style={{
        position: "fixed",
        bottom: 0,
        right: 48,
        zIndex: 100,
        fontSize: 10,
        padding: "2px 6px",
        background: "var(--material-floating)",
        color: "var(--text-tertiary)",
      }}
    >
      开发预览 · 示例数据 · 不连接后端
    </div>
    <SettingsDialog />
    <MainLayout
      mainContent={<ChatArea />}
      editorPanel={null}
      sidePanel={<SidePanel />}
    />
  </>,
);
