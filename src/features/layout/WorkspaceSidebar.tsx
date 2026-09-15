import { useEffect, useRef, useState } from "react";
import { Folder, FolderOpen, Settings, Sparkles, Plus } from "lucide-react";
import SidebarNav from "@/components/agent-ui/beautiful-ui/SidebarNav";
import { useUiStore } from "@/stores/ui.store";
import { useProjectStore } from "@/stores/project.store";
import { useConversationStore } from "@/stores/conversation.store";
import { activateProject } from "../projects/activateProject";
import { restoreProjectConversationTabs } from "../projects/restoreProjectConversationTabs";
import { NewConversationDropdown } from "../projects/NewConversationDropdown";
import { openProjectFolder } from "../projects/openProjectFolder";
import { errorMessage } from "@/lib/errors";
import type { Project } from "@/bridge/tauri";

export function WorkspaceSidebar() {
  const projects = useProjectStore((s) => s.projects);
  const projectId = useProjectStore((s) => s.activeProjectId);
  const conversations = useConversationStore((s) => s.conversationsByProject);
  const activeTabs = useConversationStore((s) => s.activeTabByProject);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
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
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    try {
      await activateProject(project);
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
        }
        useConversationStore.getState().switchTab(conversationId);
      }
      useUiStore.getState().setOverviewOpen(false);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };

  return (
    <SidebarNav className="nex-workspace-sidebar">
      <div className="nex-workspace-brand">
        <Sparkles size={19} /> Nex <small>WORKSPACE</small>
      </div>
      <NewConversationDropdown triggerSize="icon-sm" />
      <section className="nex-sidebar-recents" aria-busy={busy}>
        <div className="flex items-center justify-between">
          <h2>项目</h2>
          <button
            style={{ width: 28 }}
            aria-label="新增项目"
            title="打开文件夹新增项目"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              setError(null);
              void openProjectFolder()
                .catch((e) => setError(errorMessage(e)))
                .finally(() => setBusy(false));
            }}
          >
            <Plus size={15} />
          </button>
        </div>
        <nav aria-label="项目与会话">
          {projects.map((project) => {
            const expanded = !collapsed[project.id];
            const Icon = expanded ? FolderOpen : Folder;
            return (
              <div key={project.id}>
                <button
                  disabled={busy}
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
                {expanded &&
                  (conversations[project.id] ?? []).map((c) => (
                    <button
                      key={c.id}
                      disabled={busy}
                      className="nex-project-conversation"
                      title={c.title}
                      aria-current={
                        projectId === project.id &&
                        activeTabs[project.id] === c.id
                          ? "page"
                          : undefined
                      }
                      onClick={() => void select(project, c.id)}
                    >
                      <span className="truncate">{c.title}</span>
                    </button>
                  ))}
              </div>
            );
          })}
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
      <button onClick={() => useUiStore.getState().openSettings()}>
        <Settings size={16} />
        设置
      </button>
    </SidebarNav>
  );
}
