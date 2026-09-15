import ContextCards from "@/components/agent-ui/beautiful-ui/ContextCards";
import FilterTable from "@/components/agent-ui/beautiful-ui/FilterTable";
import InsightCards, {
  type InsightPage,
} from "@/components/agent-ui/beautiful-ui/InsightCards";
import { useProjectStore } from "@/stores/project.store";
import {
  useConversationStore,
  selectProjectConversations,
} from "@/stores/conversation.store";
import { useAgentStore } from "@/stores/agent.store";
import { useFsStore } from "@/stores/fs.store";
import { useUiStore } from "@/stores/ui.store";

function WorkspaceMetrics() {
  const projectId = useProjectStore((s) => s.activeProjectId);
  const conversations = useConversationStore((s) =>
    selectProjectConversations(s, projectId),
  );
  const sessions = useAgentStore((s) => s.sessions);
  const openFiles = useFsStore((s) => s.openFiles);
  const running = conversations.filter(
    (c) => sessions[c.id]?.status === "running",
  ).length;
  return (
    <div className="grid grid-cols-3 gap-3 rounded-xl border border-[var(--hairline-soft)] bg-[var(--material-panel)] p-4">
      {[
        ["任务", conversations.length],
        ["运行中", running],
        ["已打开文件", openFiles.length],
      ].map(([label, count]) => (
        <div key={label}>
          <div className="text-2xl font-semibold tabular-nums">{count}</div>
          <div className="mt-1 text-[11px] text-[var(--text-tertiary)]">
            {label}
          </div>
        </div>
      ))}
    </div>
  );
}
const INSIGHTS: InsightPage[] = [
  {
    key: "workspace",
    prose: "当前项目的实时状态",
    Card: WorkspaceMetrics,
    pill: "本地工作区",
  },
];

export function WorkspaceOverview() {
  const project = useProjectStore((s) =>
    s.projects.find((p) => p.id === s.activeProjectId),
  );
  const conversations = useConversationStore((s) =>
    selectProjectConversations(s, project?.id),
  );
  const sessions = useAgentStore((s) => s.sessions);
  const files = useFsStore((s) => s.openFiles);
  const chunks = files
    .slice(0, 4)
    .map((f) => ({
      title: f.path.split(/[/\\]/).pop() ?? f.path,
      chars: `${f.size.toLocaleString()} B`,
      body: f.isText ? f.draft.slice(0, 240) : "二进制文件",
      source: f.path,
      badge: f.dirty ? "未保存" : "文件",
      tone: "bg-accent",
    }));
  return (
    <div className="beautiful-ui nex-workspace-overview">
      <p className="mb-3 text-xs tracking-wide">NEX / WORKSPACE</p>
      <h1>{project?.name ?? "你的 AI 工作台"}</h1>
      <p>工作台已就绪。描述任务，@ 引用文件，/ 使用命令。</p>
      <div className="nex-overview-grid">
        <section>
          <InsightCards pages={INSIGHTS} labels={{ title: "工作区概况" }} />
        </section>
        <section>
          <h2>工作区文件预览</h2>
          {chunks.length ? (
            <ContextCards
              chunks={chunks}
              labels={{ header: "已打开文件", count: `${files.length}` }}
            />
          ) : (
            <p>打开项目文件后，可在这里查看内容预览。</p>
          )}
        </section>
        <section className="col-span-full">
          <h2>项目任务</h2>
          {conversations.length ? (
            <FilterTable
              labels={{
                columns: {
                  task: "任务",
                  date: "更新时间",
                  status: "状态",
                  owner: "Agent",
                },
              }}
              onSelect={(row) => {
                if (!row.id) return;
                useConversationStore.getState().switchTab(row.id);
                useUiStore.getState().setOverviewOpen(false);
              }}
              rows={conversations.map((c) => ({
                id: c.id,
                task: c.title,
                date: new Date(c.updated_at * 1000).toLocaleDateString(),
                owner: c.agent_type,
                status:
                  sessions[c.id]?.status === "running" ||
                  sessions[c.id]?.status === "starting"
                    ? "progress"
                    : c.status === "completed"
                      ? "done"
                      : "todo",
              }))}
            />
          ) : (
            <p>点击「新建任务」选择 Agent，开始处理项目。</p>
          )}
        </section>
      </div>
    </div>
  );
}
