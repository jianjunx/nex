import { useState } from "react";
import { Plus, PanelRight } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Button, Tabs, TabsList, TabsTrigger } from "@glinui/ui";
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
      data-tauri-drag-region
      onMouseDown={handleMouseDown}
      className="flex items-center h-12 px-4 gap-3 border-b border-[color:var(--border-subtle)] bg-[var(--glass-1-surface)] backdrop-blur-[40px]"
    >
      {/* Project selector */}
      <ProjectSelector />

      {/* New conversation */}
      <Button size="sm" variant="ghost" onClick={() => setShowNewConversation(true)}>
        <Plus size={14} />
      </Button>

      {/* Conversation tabs */}
      <div className="flex items-center gap-1.5 flex-1 min-w-0 overflow-x-auto">
        {openTabs.length === 0 ? (
          <span className="text-xs text-[var(--text-tertiary)] px-2">No conversations</span>
        ) : (
          <Tabs value={activeTabId ?? ""} onValueChange={switchTab} className="min-w-0">
            <TabsList className="h-8 border-transparent bg-transparent p-0">
              {openTabs.map((tabId) => {
                const status = sessions[tabId]?.status ?? null;
                return (
                  <TabsTrigger
                    key={tabId}
                    value={tabId}
                    className="gap-2 rounded-[var(--radius-sm)] font-normal text-[var(--text-secondary)] hover:text-[var(--text-primary)] data-[state=active]:bg-[var(--glass-interactive-bg)] data-[state=active]:text-[var(--text-primary)] data-[state=active]:shadow-[inset_0_-2px_0_0_var(--accent)]"
                  >
                    {status && status !== "idle" && (
                      <span
                        className={`w-2 h-2 rounded-full ${status === "running" ? "animate-pulse" : ""}`}
                        style={{ backgroundColor: status === "running" ? "var(--accent)" : "var(--warning)" }}
                      />
                    )}
                    <span className="max-w-[120px] truncate">
                      {allConversations.find((c) => c.id === tabId)?.title ?? tabId}
                    </span>
                    {/*
                      TabsTrigger renders a <button>, so the close × cannot be
                      a nested <button> (invalid HTML). It's a span[role="button"]
                      whose mousedown calls preventDefault (blocks the focus
                      move that would auto-activate the tab under Radix's
                      automatic activation) plus stopPropagation, so clicking ×
                      on an inactive tab closes it without switching to it.
                    */}
                    <span
                      role="button"
                      className="ml-1 cursor-pointer text-xs opacity-50 hover:opacity-100"
                      onMouseDown={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                      }}
                      onClick={(e) => {
                        e.stopPropagation();
                        removeSession(tabId);
                        closeTab(tabId);
                      }}
                    >
                      ×
                    </span>
                  </TabsTrigger>
                );
              })}
            </TabsList>
          </Tabs>
        )}
      </div>

      {/* Panel toggle */}
      <Button size="sm" variant="ghost" onClick={toggleSidePanel}>
        <PanelRight size={14} className={sidePanelVisible ? "text-[var(--accent)]" : ""} />
      </Button>

      {/* Custom window controls (Windows only) */}
      {isWindows && (
        <div className="flex items-center" data-tauri-drag-region>
          <WindowControls />
        </div>
      )}

      <NewConversationModal open={showNewConversation} onClose={() => setShowNewConversation(false)} />
    </div>
  );
}
