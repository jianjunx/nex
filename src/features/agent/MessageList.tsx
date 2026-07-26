import ReactMarkdown from "react-markdown";
import { Wrench } from "lucide-react";
import { Card, CardContent, Chip } from "@glinui/ui";
import { useProjectStore } from "../../stores/project.store";
import { selectProjectActiveTabId, useConversationStore } from "../../stores/conversation.store";

export function MessageList() {
  const activeProjectId = useProjectStore((s) => s.activeProjectId);
  const activeTabId = useConversationStore((s) => selectProjectActiveTabId(s, activeProjectId));
  const messagesByConversation = useConversationStore((s) => s.messagesByConversation);
  const messages = activeTabId ? (messagesByConversation[activeTabId] || []) : [];

  return (
    <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
      {messages.length === 0 && (
        <div className="flex items-center justify-center h-full text-[var(--text-tertiary)] text-sm">
          Start a conversation
        </div>
      )}
      {messages.map((msg) =>
        msg.tool_summary ? (
          <div key={msg.id} className="flex justify-start">
            <Chip className="gap-2 px-3 font-normal text-[var(--text-tertiary)]">
              <Wrench size={12} />
              <span className="font-mono">{msg.tool_summary}</span>
            </Chip>
          </div>
        ) : (
          <div key={msg.id} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
            <Card
              variant={msg.role === "user" ? "matte" : "glass"}
              className={
                msg.role === "user"
                  ? "max-w-[80%] px-4 py-2 text-sm bg-none bg-[var(--accent)]/15 border-[var(--accent)]/30 dark:bg-none dark:bg-[var(--accent)]/15 dark:border-[var(--accent)]/30"
                  : "max-w-[80%] px-4 py-2 text-sm"
              }
            >
              <CardContent>
                {msg.role === "assistant" ? (
                  <div className="[&_pre]:overflow-x-auto [&_code]:text-[0.85em] [&_p]:my-1">
                    <ReactMarkdown>{msg.content}</ReactMarkdown>
                  </div>
                ) : (
                  <p className="whitespace-pre-wrap">{msg.content}</p>
                )}
              </CardContent>
            </Card>
          </div>
        )
      )}
    </div>
  );
}
