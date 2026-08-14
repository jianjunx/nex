import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useAgentStore } from "../../stores/agent.store";
import { useConversationStore } from "../../stores/conversation.store";
import { useProjectStore } from "../../stores/project.store";
import { AgentIcon } from "../agent/AgentIcon";
import { activateProject } from "./activateProject";

const MAX_RAIL_PROJECTS = 5;

function projectMonogram(name: string): string {
  const first = Array.from(name.trim())[0];
  return first ? first.toUpperCase() : "?";
}

/** Most recently active conversation, matching the project dropdown. */
function latestConversation<T extends { updated_at: number }>(conversations: T[]): T | undefined {
  return [...conversations].sort((a, b) => b.updated_at - a.updated_at)[0];
}

/**
 * The five most recently opened projects as compact shortcuts below Search.
 * The backing store is already ordered exactly like the project dropdown.
 */
export function ProjectRail() {
  const projects = useProjectStore((s) => s.projects);
  const activeProjectId = useProjectStore((s) => s.activeProjectId);
  const conversationsByProject = useConversationStore((s) => s.conversationsByProject);
  const sessions = useAgentStore((s) => s.sessions);
  const railProjects = projects.slice(0, MAX_RAIL_PROJECTS);

  // The dropdown lazily loads conversation lists so it can show the latest
  // session. Do the same for the rail so its hover card is useful immediately.
  useEffect(() => {
    const store = useConversationStore.getState();
    for (const project of projects.slice(0, MAX_RAIL_PROJECTS)) {
      if (!store.conversationsByProject[project.id]) {
        void store.loadConversations(project.id);
      }
    }
  }, [projects]);

  if (railProjects.length === 0) return null;

  return (
    <div className="mt-1.5 flex flex-col items-center gap-2 border-t border-[color:var(--hairline-soft)] pt-2">
      {railProjects.map((project) => {
        const active = project.id === activeProjectId;
        const latest = latestConversation(conversationsByProject[project.id] ?? []);
        const latestStatus = latest ? (sessions[latest.id]?.status ?? null) : null;
        const latestLabel = latest?.title ?? "暂无会话";

        return (
          <div key={project.id} className="group/project relative">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`切换到项目 ${project.name}，最近会话：${latestLabel}`}
              aria-current={active ? "page" : undefined}
              onClick={() => void activateProject(project)}
              className={cn(
                "nex-interactive-chrome nex-pressable rounded-[var(--radius-md)] border text-[11px] font-semibold",
                active
                  ? "border-[color:var(--hairline-soft)] bg-[color:color-mix(in_srgb,var(--material-elevated)_88%,transparent)] text-[var(--accent)] shadow-[inset_0_1px_0_0_var(--edge-highlight-bright),0_10px_24px_-18px_rgba(0,0,0,0.78)]"
                  : "border-transparent text-[var(--text-secondary)] hover:border-[color:var(--hairline-soft)] hover:bg-[color:color-mix(in_srgb,var(--material-floating)_72%,transparent)] hover:text-[var(--text-primary)]",
              )}
            >
              {projectMonogram(project.name)}
            </Button>

            <div
              role="tooltip"
              className="pointer-events-none invisible absolute right-full top-1/2 z-50 mr-2 w-60 -translate-y-1/2 rounded-[calc(var(--radius-md)+2px)] border border-[color:var(--hairline-soft)] bg-[var(--material-floating)] px-3 py-2 text-right opacity-0 shadow-[0_12px_32px_-18px_rgba(0,0,0,0.72)] transition-[opacity,visibility] duration-150 group-hover/project:visible group-hover/project:opacity-100 group-focus-within/project:visible group-focus-within/project:opacity-100"
            >
              <div className="break-words text-[16px] font-bold text-[var(--text-primary)]">
                {project.name}
              </div>
              <div className="mt-0.5 flex min-w-0 items-center justify-end gap-1.5 text-[13px] leading-tight text-[var(--text-tertiary)]">
                {latest?.agent_type && (
                  <AgentIcon agentType={latest.agent_type} status={latestStatus} size={9} />
                )}
                <span className="min-w-0 truncate">{latestLabel}</span>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
