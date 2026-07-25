import { useState } from "react";
import { Plus, PanelRight } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { GlassButton, GlassTab } from "../../ui";
import { useUiStore } from "../../stores/ui.store";
import { useConversationStore } from "../../stores/conversation.store";
import { useAgentStore } from "../../stores/agent.store";
import { ProjectSelector } from "../projects/ProjectSelector";
import { NewConversationModal } from "../projects/NewConversationModal";
import { WindowControls } from "./WindowControls";

const isWindows =
  typeof navigator !== "undefined" &&
  (navigator.platform.startsWith("Win") || navigator.userAgent.includes("Windows"));

export function TopBar() {
  const { toggleSidePanel, sidePanelVisible } = useUiStore();
  const { openTabs, activeTabId, conversationsByProject, switchTab, closeTab } = useConversationStore();
  const sessions = useAgentStore((s) => s.sessions);
  const removeSession = useAgentStore((s) => s.removeSession);
  const [showNewConversation, setShowNewConversation] = useState(false);

  const allConversations = Object.values(conversationsByProject).flat();

  // On Windows the native title bar is hidden, so the tab bar doubles as the
  // drag handle. We start a native drag when the user presses the left button
  // on a non-interactive part of the bar. macOS keeps its system title bar, so
  // we leave dragging to the OS there.
  const handleMouseDown = (e: React.MouseEvent) => {
    if (!isWindows) return;
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    // Don't drag when interacting with controls
    if (target.closest("button, input, select, textarea, a, [role='button']")) return;
    getCurrentWindow().startDragging();
  };

  return (
    <div
      onMouseDown={handleMouseDown}
      className="flex items-center h-10 px-3 gap-2 border-b border-[color:var(--border-subtle)] bg-[var(--glass-base-bg)] backdrop-blur-[40px]"
    >
      {/* Project selector */}
      <ProjectSelector />

      {/* New conversation */}
      <GlassButton size="sm" variant="ghost" onClick={() => setShowNewConversation(true)}>
        <Plus size={14} />
      </GlassButton>

      {/* Conversation tabs */}
      <div className="flex items-center gap-1 flex-1 overflow-x-auto">
        {openTabs.length === 0 ? (
          <span className="text-xs text-[var(--text-tertiary)] px-2">No conversations</span>
        ) : (
          openTabs.map((tabId) => (
            <GlassTab
              key={tabId}
              label={allConversations.find((c) => c.id === tabId)?.title ?? tabId}
              active={tabId === activeTabId}
              indicator={sessions[tabId]?.status ?? null}
              onClick={() => switchTab(tabId)}
              onClose={() => { removeSession(tabId); closeTab(tabId); }}
            />
          ))
        )}
      </div>

      {/* Panel toggle */}
      <GlassButton size="sm" variant="ghost" onClick={toggleSidePanel}>
        <PanelRight size={14} className={sidePanelVisible ? "text-[var(--accent)]" : ""} />
      </GlassButton>

      {/* Custom window controls (Windows only) */}
      {isWindows && <WindowControls />}

      <NewConversationModal open={showNewConversation} onClose={() => setShowNewConversation(false)} />
    </div>
  );
}
