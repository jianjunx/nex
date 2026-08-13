import FileIcon from "../../files/FileIcon";
import { fileBasename, relativeToProject } from "../../editor/pathUtils";
import { openPathToken } from "./pathToken";
import type { ChangedFile } from "./filesChanged";
import { useProjectStore } from "../../../stores/project.store";
import { selectProjectActiveTabId, useConversationStore } from "../../../stores/conversation.store";
import { useAgentStore } from "../../../stores/agent.store";

const ACTION_BTN =
  "nex-interactive-chrome shrink-0 cursor-pointer rounded-[var(--radius-sm)] px-1 py-0.5 text-xs text-[var(--text-tertiary)] hover:bg-[var(--overlay-hover)] hover:text-[var(--text-primary)] disabled:cursor-default disabled:opacity-40";

function repoRelativePaths(files: ChangedFile[], projectPath: string | undefined): string[] {
  if (!projectPath) return files.map((f) => f.path.replace(/\\/g, "/"));
  return files.map((f) => relativeToProject(f.path, projectPath).replace(/\\/g, "/"));
}

function sendToSession(conversationId: string, sessionId: string, text: string) {
  useAgentStore.getState().appendUserMessage(conversationId, text);
  void useAgentStore.getState().sendPrompt(sessionId, [{ type: "text", text }]);
}

export function FilesChangedCard({ files }: { files: ChangedFile[] }) {
  const activeProjectId = useProjectStore((s) => s.activeProjectId);
  const projectPath = useProjectStore((s) => s.projects.find((p) => p.id === s.activeProjectId)?.path);
  const activeTabId = useConversationStore((s) => selectProjectActiveTabId(s, activeProjectId));
  const session = useAgentStore((s) => (activeTabId ? s.sessions[activeTabId] : undefined));
  const canPrompt = !!session?.sessionId && session.status === "idle";

  if (files.length === 0) return null;

  const rels = repoRelativePaths(files, projectPath);

  const reviewAll = () => {
    void (async () => {
      for (const f of files) await openPathToken(f.path);
      if (files[0]) await openPathToken(files[0].path);
    })();
  };

  const commitFiles = () => {
    if (!canPrompt || !activeTabId || !session?.sessionId) return;
    sendToSession(
      activeTabId,
      session.sessionId,
      `请提交这些文件，并写一条合适的 commit message：\n${rels.map((p) => `- ${p}`).join("\n")}`,
    );
  };

  const reviewFiles = () => {
    if (!canPrompt || !activeTabId || !session?.sessionId) return;
    sendToSession(activeTabId, session.sessionId, `/review ${rels.join(" ")}`.trim());
  };

  return (
    <div className="max-w-[96%] overflow-hidden rounded-[calc(var(--radius-md)+2px)] border border-[color:var(--hairline-soft)] bg-[var(--material-floating)] shadow-[inset_0_1px_0_0_var(--edge-highlight-soft)]">
      <div className="flex items-center justify-between gap-2 px-3 py-2">
        <span className="text-xs text-[var(--text-secondary)]">
          修改了 {files.length} 个文件
        </span>
        <div className="flex shrink-0 items-center gap-2.5">
          <button type="button" className={ACTION_BTN} disabled={!canPrompt} onClick={commitFiles}>
            Commit
          </button>
          <button type="button" className={ACTION_BTN} disabled={!canPrompt} onClick={reviewFiles}>
            Review
          </button>
          <button type="button" className={ACTION_BTN} onClick={reviewAll}>
            查看
          </button>
        </div>
      </div>
      <ul>
        {files.map((f) => {
          const name = fileBasename(f.path);
          return (
            <li key={f.path}>
              <button
                type="button"
                title={f.path}
                className="nex-interactive-chrome flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left hover:bg-[color:color-mix(in_srgb,var(--material-elevated)_86%,transparent)]"
                onClick={() => void openPathToken(f.path)}
              >
                <FileIcon filename={name} size={14} className="shrink-0" />
                <span className="min-w-0 flex-1 truncate text-sm text-[var(--text-primary)]">{name}</span>
                <span className="flex shrink-0 items-center gap-1.5 font-mono text-[11px] tabular-nums">
                  {f.additions > 0 && (
                    <span className="text-[var(--success)]">+{f.additions}</span>
                  )}
                  {f.deletions > 0 && (
                    <span className="text-[var(--error)]">−{f.deletions}</span>
                  )}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
