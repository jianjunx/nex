import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { cn } from "@/lib/utils";
import { Collapse } from "@/components/ui/Collapse";
import {
  Folder,
  FolderOpen,
  MessageSquarePlus,
  Plus,
  Settings,
  Sparkles,
  Trash2,
} from "lucide-react";
import SidebarNav from "@/components/agent-ui/beautiful-ui/SidebarNav";
import GlideMenu from "@/components/agent-ui/primitives/GlideMenu";
import { useUiStore } from "@/stores/ui.store";
import { useProjectStore } from "@/stores/project.store";
import { useConversationStore } from "@/stores/conversation.store";
import { activateProject } from "../projects/activateProject";
import {
  hydrateConversationTab,
  restoreProjectConversationTabs,
} from "../projects/restoreProjectConversationTabs";
import { NewConversationDropdown } from "../projects/NewConversationDropdown";
import { startNewTask } from "../projects/startTask";
import { AgentIcon } from "../agent/AgentIcon";
import { useAgentStore } from "@/stores/agent.store";
import { CloseTabConfirmDialog } from "../agent/CloseTabConfirmDialog";
import { openProjectFolder } from "../projects/openProjectFolder";
import { ProjectActionsMenu } from "../projects/ProjectActionsMenu";
import { projectInitial } from "../projects/projectInitial";
import { errorMessage } from "@/lib/errors";
import type { Project } from "@/bridge/tauri";


function ConversationRow({
  conversationId,
  title,
  agentType,
  current,
  onSelect,
  onDelete,
}: {
  conversationId: string;
  title: string;
  agentType: string;
  current: boolean;
  onSelect: () => void;
  onDelete: () => void;
}) {
  // Subscribe to this row's status only, so a streaming turn elsewhere does
  // not re-render the whole project list.
  const status = useAgentStore((s) => s.sessions[conversationId]?.status ?? null);
  return (
    <div className="nex-conversation-row" data-current={current} data-row="">
      <button
        className="nex-project-conversation"
        title={title}
        aria-current={current ? "page" : undefined}
        onClick={onSelect}
      >
        <span aria-hidden className="inline-flex shrink-0">
          <AgentIcon agentType={agentType} status={status} size={13} />
        </span>
        <span className="truncate">{title}</span>
      </button>
      <button
        className="nex-icon-btn"
        aria-label={`删除对话 ${title}`}
        title="删除对话"
        onClick={onDelete}
      >
        <Trash2 size={14} />
      </button>
    </div>
  );
}

export function WorkspaceSidebar() {
  const projects = useProjectStore((s) => s.projects);
  const projectId = useProjectStore((s) => s.activeProjectId);
  const conversations = useConversationStore((s) => s.conversationsByProject);
  const activeTabs = useConversationStore((s) => s.activeTabByProject);
  const railMode = useUiStore((s) => s.sidebarCollapsed);
  const creating = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const projectIds = projects
    .map((p) => p.id)
    .sort()
    .join("\n");
  useEffect(() => {
    // Load only metadata, never start agents or hydrate every project's history.
    let cancelled = false;
    void (async () => {
      for (const id of projectIds.split("\n").filter(Boolean)) {
        if (cancelled) return;
        if (!useConversationStore.getState().conversationsByProject[id]) {
          await useConversationStore.getState().loadConversations(id);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectIds]);

  const select = async (project: Project, conversationId?: string) => {
    setError(null);
    try {
      await activateProject(project);
      // A later click may already have moved on; don't retarget that project.
      if (useProjectStore.getState().activeProjectId !== project.id) return;
      if (conversationId) {
        const state = useConversationStore.getState();
        const tabs = state.tabsByProject[project.id] ?? [];
        if (!tabs.includes(conversationId)) {
          state.restoreTabs(
            project.id,
            [...tabs, conversationId],
            conversationId,
            new Set(
              (state.conversationsByProject[project.id] ?? []).map((c) => c.id),
            ),
          );
          await restoreProjectConversationTabs(project.id);
          if (useProjectStore.getState().activeProjectId !== project.id) return;
        }
        // activateProject 只等活动页签 hydrate 完，点中的这个可能还在惰性队列里。
        // 先补上再切，否则会看到一段空白线程。
        if (!useAgentStore.getState().entriesByConversation[conversationId]?.length) {
          await hydrateConversationTab(conversationId);
          if (useProjectStore.getState().activeProjectId !== project.id) return;
        }
        useConversationStore.getState().switchTab(conversationId);
      }
    } catch (err) {
      if (useProjectStore.getState().activeProjectId === project.id) {
        setError(errorMessage(err));
      }
    }
  };

  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const pendingStatus = useAgentStore((s) =>
    pendingDeleteId ? (s.sessions[pendingDeleteId]?.status ?? null) : null,
  );
  const confirmDelete = async () => {
    if (!pendingDeleteId || deleting) return;
    const id = pendingDeleteId;
    setDeleting(true);
    try {
      await useAgentStore.getState().removeSession(id);
      await useConversationStore.getState().removeConversation(id);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setDeleting(false);
      setPendingDeleteId(null);
    }
  };

  const createTask = async (project: Project) => {
    if (creating.current) return;
    creating.current = true;
    setError(null);
    try {
      await startNewTask(project);
    } catch (err) {
      if (useProjectStore.getState().activeProjectId === project.id) {
        setError(errorMessage(err));
      }
    } finally {
      creating.current = false;
    }
  };

  return (
    <SidebarNav className={cn("nex-workspace-sidebar", railMode && "nex-workspace-rail")}>
      {!railMode ? (
        <ExpandedSidebar
          projects={projects}
          projectId={projectId}
          conversations={conversations}
          activeTabs={activeTabs}
          error={error}
          collapsed={collapsed}
          setCollapsed={setCollapsed}
          setError={setError}
          select={select}
          createTask={createTask}
          pendingDeleteId={pendingDeleteId}
          setPendingDeleteId={setPendingDeleteId}
          deleting={deleting}
          pendingStatus={pendingStatus}
          confirmDelete={confirmDelete}
        />
      ) : (
        <>
          <NewConversationDropdown triggerSize="icon-sm" compact />
          <nav aria-label="项目" className="nex-rail-projects">
            {projects.map((project) => (
              <button
                key={project.id}
                title={project.name}
                aria-label={project.name}
                aria-current={projectId === project.id ? "page" : undefined}
                className="nex-rail-project"
                onClick={() => void select(project)}
              >
                {projectInitial(project.name)}
              </button>
            ))}
          </nav>
          {error && (
            <p role="alert" className="px-1 text-center text-xs text-[var(--status-danger)]">
              {error}
            </p>
          )}
          <button
            className="nex-rail-settings"
            title="设置"
            aria-label="设置"
            onClick={() => useUiStore.getState().openSettings()}
          >
            <Settings size={16} />
          </button>
        </>
      )}
    </SidebarNav>
  );
}

function ExpandedSidebar({
  projects,
  projectId,
  conversations,
  activeTabs,
  error,
  collapsed,
  setCollapsed,
  setError,
  select,
  createTask,
  pendingDeleteId,
  setPendingDeleteId,
  deleting,
  pendingStatus,
  confirmDelete,
}: {
  projects: Project[];
  projectId: string | null;
  conversations: ReturnType<typeof useConversationStore.getState>["conversationsByProject"];
  activeTabs: ReturnType<typeof useConversationStore.getState>["activeTabByProject"];
  error: string | null;
  collapsed: Record<string, boolean>;
  setCollapsed: Dispatch<SetStateAction<Record<string, boolean>>>;
  setError: (error: string | null) => void;
  select: (project: Project, conversationId?: string) => Promise<void>;
  createTask: (project: Project) => Promise<void>;
  pendingDeleteId: string | null;
  setPendingDeleteId: (id: string | null) => void;
  deleting: boolean;
  pendingStatus: "starting" | "idle" | "running" | "waiting" | null;
  confirmDelete: () => Promise<void>;
}) {
  const [openingFolder, setOpeningFolder] = useState(false);
  return (
    <>
      <div className="nex-workspace-brand">
        <Sparkles size={19} /> Nex <small>WORKSPACE</small>
      </div>
      <NewConversationDropdown triggerSize="icon-sm" />
      <section className="nex-sidebar-recents">
        <div className="flex items-center justify-between">
          <h2>项目</h2>
          <button
            className="nex-icon-btn"
            aria-label="新增项目"
            title="打开文件夹新增项目"
            disabled={openingFolder}
            onClick={() => {
              setOpeningFolder(true);
              setError(null);
              void openProjectFolder()
                .catch((e) => setError(errorMessage(e)))
                .finally(() => setOpeningFolder(false));
            }}
          >
            <Plus size={16} />
          </button>
        </div>
        <nav aria-label="项目与会话">
          <GlideMenu
            rowSelector="[data-row]"
            fitRow
            highlightClassName="nex-glide-highlight"
            className="flex flex-col"
          >
          {projects.map((project) => {
            const expanded = !collapsed[project.id];
            const Icon = expanded ? FolderOpen : Folder;
            return (
              <div key={project.id}>
                <div className="nex-project-row" data-row="">
                  <button
                    title={project.path}
                    aria-expanded={expanded}
                    onClick={() => {
                      if (projectId === project.id)
                        setCollapsed((s) => ({ ...s, [project.id]: expanded }));
                      else {
                        setCollapsed((s) => ({ ...s, [project.id]: false }));
                        void select(project);
                      }
                    }}
                  >
                    <Icon size={15} className="shrink-0" />
                    <span className="truncate">{project.name}</span>
                  </button>
                  <ProjectActionsMenu project={project} onError={setError} />
                  <button
                    className="nex-icon-btn"
                    aria-label={`在 ${project.name} 中新建任务`}
                    title="新建任务"
                    onClick={() => {
                      setCollapsed((s) => ({ ...s, [project.id]: false }));
                      void createTask(project);
                    }}
                  >
                    <MessageSquarePlus size={15} />
                  </button>
                </div>
                <Collapse open={expanded}>
                  {(conversations[project.id] ?? []).map((c) => (
                    <ConversationRow
                      key={c.id}
                      conversationId={c.id}
                      title={c.title}
                      agentType={c.agent_type}
                      current={
                        projectId === project.id &&
                        activeTabs[project.id] === c.id
                      }
                      onSelect={() => void select(project, c.id)}
                      onDelete={() => setPendingDeleteId(c.id)}
                    />
                  ))}
                </Collapse>
              </div>
            );
          })}
          </GlideMenu>
        </nav>
        {!projects.length && (
          <p className="px-2 text-xs text-[var(--text-tertiary)]">
            打开文件夹以添加项目
          </p>
        )}
        {error && (
          <p role="alert" className="px-2 text-xs text-[var(--status-danger)]">
            {error}
          </p>
        )}
      </section>
      <CloseTabConfirmDialog
        mode="delete"
        open={pendingDeleteId !== null}
        busy={deleting}
        status={pendingStatus}
        onCancel={() => {
          if (!deleting) setPendingDeleteId(null);
        }}
        onConfirm={() => void confirmDelete()}
      />
      <button onClick={() => useUiStore.getState().openSettings()}>
        <Settings size={16} />
        设置
      </button>
    </>
  );
}
