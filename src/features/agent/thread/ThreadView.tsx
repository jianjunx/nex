import ReactMarkdown from "react-markdown";
import { ListChecks } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { useAgentStore } from "../../../stores/agent.store";
import { useProjectStore } from "../../../stores/project.store";
import { selectProjectActiveTabId, useConversationStore } from "../../../stores/conversation.store";
import { ThinkingBlock } from "./ThinkingBlock";
import { ToolCallCard } from "./ToolCallCard";
import type { AssistantChunk, ThreadEntry } from "./types";

export function ThreadView() {
  const activeProjectId = useProjectStore((s) => s.activeProjectId);
  const activeTabId = useConversationStore((s) => selectProjectActiveTabId(s, activeProjectId));
  const entriesByConversation = useAgentStore((s) => s.entriesByConversation);
  const entries = activeTabId ? (entriesByConversation[activeTabId] ?? []) : [];

  return (
    <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
      {entries.length === 0 && (
        <div className="flex items-center justify-center h-full text-[var(--text-tertiary)] text-sm">
          Start a conversation
        </div>
      )}
      {entries.map((entry) => (
        <EntryView key={entry.id} entry={entry} />
      ))}
    </div>
  );
}

function EntryView({ entry }: { entry: ThreadEntry }) {
  switch (entry.kind) {
    case "user_message":
      return (
        <div className="flex justify-end">
          <Card
            className="max-w-[80%] gap-0 px-4 py-2 text-sm shadow-none bg-[var(--accent)]/15 border-[var(--accent)]/30"
          >
            <CardContent className="px-0">
              <p className="whitespace-pre-wrap">{entry.text}</p>
            </CardContent>
          </Card>
        </div>
      );
    case "assistant_message":
      return (
        <div className="flex flex-col gap-2 max-w-[90%]">
          {groupChunks(entry.chunks).map((g, i) =>
            g.type === "thought" ? (
              <ThinkingBlock key={i} text={g.text} />
            ) : (
              <Card key={i} className="gap-0 px-4 py-2 text-sm shadow-none">
                <CardContent className="px-0">
                  <div className="[&_pre]:overflow-x-auto [&_code]:text-[0.85em] [&_p]:my-1">
                    <ReactMarkdown>{g.text}</ReactMarkdown>
                  </div>
                </CardContent>
              </Card>
            ),
          )}
        </div>
      );
    case "tool_call":
      return (
        <div className="max-w-[90%]">
          <ToolCallCard entry={entry} />
        </div>
      );
    case "completed_plan":
      return (
        <div className="max-w-[90%] rounded-[var(--radius-md)] border border-[color:var(--border-subtle)] bg-[var(--glass-2-surface)] px-3 py-2">
          <div className="flex items-center gap-2 text-xs text-[var(--text-secondary)] mb-1">
            <ListChecks size={14} />
            <span>Completed Plan — {entry.entries.length} steps</span>
          </div>
          <ul className="text-xs space-y-1 text-[var(--text-primary)]">
            {entry.entries.map((e, i) => (
              <li key={i} className="opacity-70">
                {e.content}
              </li>
            ))}
          </ul>
        </div>
      );
  }
}

function groupChunks(chunks: AssistantChunk[]): AssistantChunk[] {
  const out: AssistantChunk[] = [];
  for (const c of chunks) {
    const last = out[out.length - 1];
    if (last && last.type === c.type) last.text += c.text;
    else out.push({ ...c });
  }
  return out;
}
