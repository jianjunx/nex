import { useState } from "react";
import { Plus, PanelRight } from "lucide-react";
import { GlassButton, GlassTab } from "../../ui";
import { useUiStore } from "../../stores/ui.store";
import { useConversationStore } from "../../stores/conversation.store";
import { useAgentStore } from "../../stores/agent.store";
import { ProjectSelector } from "../projects/ProjectSelector";
import { NewConversationModal } from "../projects/NewConversationModal";

export function TopBar() {
  const { toggleSidePanel, sidePanelVisible } = useUiStore();
  const { openTabs, activeTabId, conversationsByProject, switchTab, closeTab } = useConversationStore();
  const sessions = useAgentStore((s) => s.sessions);
  const removeSession = useAgentStore((s) => s.removeSession);
  const [showNewConversation, setShowNewConversation] = useState(false);

  const allConversations = Object.values(conversationsByProject).flat();

  return (
    <div className="flex items-center h-10 px-3 gap-2 border-b border-[color:var(--border-subtle)] bg-[var(--glass-base-bg)] backdrop-blur-[40px]">
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

      <NewConversationModal open={showNewConversation} onClose={() => setShowNewConversation(false)} />
    </div>
  );
}
