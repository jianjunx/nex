import { useState } from "react";
import ToolChips, {
  ToolDiffChip,
  ToolDiffMore,
} from "@/components/agent-ui/beautiful-ui/ToolChips";
import { fileBasename, relativeToProject } from "../../editor/pathUtils";
import { openPathToken } from "./pathToken";
import { FILES_CHANGED_VISIBLE_ROWS, type ChangedFile } from "./filesChanged";
import { useProjectStore } from "../../../stores/project.store";
import { selectProjectActiveTabId, useConversationStore } from "../../../stores/conversation.store";
import { useAgentStore } from "../../../stores/agent.store";

const ACTION =
  "text-[12.5px] text-ink-3 underline decoration-transparent underline-offset-2 transition-colors duration-100 hover:text-ink-2 hover:decoration-current disabled:pointer-events-none disabled:opacity-40";

function repoRelativePaths(files: ChangedFile[], projectPath: string | undefined): string[] {
  if (!projectPath) return files.map((f) => f.path.replace(/\\/g, "/"));
  return files.map((f) => relativeToProject(f.path, projectPath).replace(/\\/g, "/"));
}

function sendToSession(conversationId: string, sessionId: string, text: string) {
  useAgentStore.getState().appendUserMessage(conversationId, text);
  void useAgentStore.getState().sendPrompt(sessionId, [{ type: "text", text }]);
}

function FilesChangedCardContent({ files }: { files: ChangedFile[] }) {
  const activeProjectId = useProjectStore((s) => s.activeProjectId);
  const projectPath = useProjectStore((s) => s.projects.find((p) => p.id === s.activeProjectId)?.path);
  const activeTabId = useConversationStore((s) => selectProjectActiveTabId(s, activeProjectId));
  const session = useAgentStore((s) => (activeTabId ? s.sessions[activeTabId] : undefined));
  const canPrompt = !!session?.sessionId && session.status === "idle";
  const [showAll, setShowAll] = useState(false);

  if (files.length === 0) return null;

  const rels = repoRelativePaths(files, projectPath);
  const hidden = Math.max(0, files.length - FILES_CHANGED_VISIBLE_ROWS);
  const shown = showAll || hidden === 0 ? files : files.slice(0, FILES_CHANGED_VISIBLE_ROWS);

  const reviewAll = () => {
    void (async () => {
      for (const f of files) await openPathToken(f.path);
      if (files[0]) await openPathToken(files[0].path);
    })();
  };

  const commitAndPush = () => {
    if (!canPrompt || !activeTabId || !session?.sessionId) return;
    sendToSession(activeTabId, session.sessionId, "Commit & Push");
  };

  const reviewFiles = () => {
    if (!canPrompt || !activeTabId || !session?.sessionId) return;
    sendToSession(activeTabId, session.sessionId, `/review ${rels.join(" ")}`.trim());
  };

  return (
    <ToolChips className="max-w-[96%]">
      <div className="flex flex-wrap items-center gap-x-1.5 text-[12.5px] text-ink-2">
        <span>修改了 {files.length} 个文件</span>
        <span aria-hidden>·</span>
        <button type="button" className={ACTION} disabled={!canPrompt} onClick={commitAndPush}>
          Commit & Push
        </button>
        <span aria-hidden>·</span>
        <button type="button" className={ACTION} disabled={!canPrompt} onClick={reviewFiles}>
          Review
        </button>
        <span aria-hidden>·</span>
        <button type="button" className={ACTION} onClick={reviewAll}>
          查看
        </button>
      </div>
      <div
        data-testid="files-changed-list"
        className="mt-1.5 flex max-w-full flex-wrap gap-1.5"
      >
        {shown.map((f) => (
          <ToolDiffChip
            key={f.path.replace(/\\/g, "/")}
            file={fileBasename(f.path)}
            add={f.additions}
            del={f.deletions}
            title={f.path}
            onClick={() => void openPathToken(f.path)}
          />
        ))}
        {!showAll && hidden > 0 && (
          <ToolDiffMore hidden={hidden} onClick={() => setShowAll(true)} />
        )}
      </div>
    </ToolChips>
  );
}

export function FilesChangedCard(props: Parameters<typeof FilesChangedCardContent>[0]) {
  return <FilesChangedCardContent {...props} />;
}
