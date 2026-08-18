import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useAgentStore } from "../../stores/agent.store";
import { useConversationStore } from "../../stores/conversation.store";
import { useProjectStore } from "../../stores/project.store";
import { AgentIcon } from "../agent/AgentIcon";
import { projectSessionIndicators } from "../agent/projectSessionIndicators";
import { activateProject } from "./activateProject";

const MAX_RAIL_PROJECTS = 7;

function projectMonogram(name: string): string {
  const first = Array.from(name.trim())[0];
  return first ? first.toUpperCase() : "?";
}

/** Most recently active conversation, matching the project dropdown. */
function latestConversation<T extends { updated_at: number }>(conversations: T[]): T | undefined {
  return [...conversations].sort((a, b) => b.updated_at - a.updated_at)[0];
}

/**
 * Compact project shortcuts below Search.
 *
 * The rail deliberately keeps its order when switching between already shown
 * projects. Once a project not currently on the rail enters the dropdown's
 * first seven, the rail adopts that first-seven order as a new snapshot.
 */
export function ProjectRail() {
  const projects = useProjectStore((s) => s.projects);
  const activeProjectId = useProjectStore((s) => s.activeProjectId);
  const conversationsByProject = useConversationStore((s) => s.conversationsByProject);
  const sessions = useAgentStore((s) => s.sessions);
  const [railProjectIds, setRailProjectIds] = useState(() =>
    projects.slice(0, MAX_RAIL_PROJECTS).map((project) => project.id),
  );

  useEffect(() => {
    const dropdownIds = projects.slice(0, MAX_RAIL_PROJECTS).map((project) => project.id);
    setRailProjectIds((currentIds) => {
      const currentIdsStillAvailable = currentIds.filter((id) =>
        projects.some((project) => project.id === id),
      );
      const hasNewRailProject = dropdownIds.some((id) => !currentIdsStillAvailable.includes(id));

      // A switch only changes the dropdown's MRU order. Preserve the rail
      // until a new shortcut enters it (or an existing project disappears).
      if (
        currentIds.length === 0 ||
        currentIdsStillAvailable.length !== currentIds.length ||
        hasNewRailProject
      ) {
        return dropdownIds;
      }
      return currentIds;
    });
  }, [projects]);

  const railProjects = railProjectIds.flatMap((id) => {
    const project = projects.find((item) => item.id === id);
    return project ? [project] : [];
  });

  // The dropdown lazily loads conversation lists so it can show the latest
  // session. Do the same for the rail so its hover card is useful immediately.
  useEffect(() => {
    const store = useConversationStore.getState();
    for (const id of railProjectIds) {
      const project = projects.find((item) => item.id === id);
      if (!project) continue;
      if (!store.conversationsByProject[project.id]) {
        void store.loadConversations(project.id);
      }
    }
  }, [projects, railProjectIds]);

  if (railProjects.length === 0) return null;

  return (
    <div className="mt-1.5 flex flex-col items-center gap-2 border-t border-[color:var(--hairline-soft)] pt-2">
      {railProjects.map((project) => {
        const active = project.id === activeProjectId;
        const projectConversations = conversationsByProject[project.id] ?? [];
        const latest = latestConversation(projectConversations);
        const latestStatus = latest ? (sessions[latest.id]?.status ?? null) : null;
        const latestLabel = latest?.title ?? "暂无会话";
        const { hasRunning, hasWaiting } = projectSessionIndicators(
          projectConversations.map((conversation) => conversation.id),
          sessions,
        );
        const workStatus = hasRunning ? "running" : hasWaiting ? "waiting" : null;
        const workStatusLabel =
          workStatus === "running"
            ? "Agent 运行中"
            : workStatus === "waiting"
              ? "Agent 等待中"
              : null;

        return (
          <div key={project.id} className="group/project relative">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`切换到项目 ${project.name}，最近会话：${latestLabel}${workStatusLabel ? `，${workStatusLabel}` : ""}`}
              aria-current={active ? "page" : undefined}
              onClick={() => void activateProject(project)}
              className={cn(
                "nex-interactive-chrome nex-pressable rounded-[var(--radius-md)] border text-[11px] font-semibold",
                active
                  ? "border-[color:var(--hairline-soft)] bg-[color:color-mix(in_srgb,var(--material-elevated)_88%,transparent)] text-[var(--accent)] shadow-[inset_0_1px_0_0_var(--edge-highlight-bright),0_10px_24px_-18px_rgba(0,0,0,0.78)]"
                  : "border-transparent text-[var(--text-secondary)] hover:border-[color:var(--hairline-soft)] hover:bg-[color:color-mix(in_srgb,var(--material-floating)_72%,transparent)] hover:text-[var(--text-primary)]",
              )}
            >
              <span
                aria-hidden
                className={cn(
                  "inline-block font-bold",
                  workStatus && "animate-pulse motion-reduce:animate-none",
                  workStatus === "running" && "nex-project-running-rotate text-[var(--success)]",
                  workStatus === "waiting" && "text-[var(--warning)]",
                )}
              >
                {projectMonogram(project.name)}
              </span>
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
