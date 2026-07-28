import { useState } from "react";
import { CheckCircle2, Circle, Loader2, Wrench } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ToolCallEntry } from "./types";
import { useAgentStore } from "../../../stores/agent.store";

export function ToolCallCard({ entry }: { entry: ToolCallEntry }) {
  const [open, setOpen] = useState(entry.status === "waiting_for_confirmation");
  const respondPermission = useAgentStore((s) => s.respondPermission);
  const waiting = entry.status === "waiting_for_confirmation";

  return (
    <div className="rounded-[var(--radius-md)] border border-[color:var(--glass-border)] bg-[var(--glass-3-surface)] overflow-hidden">
      <button
        type="button"
        className="w-full flex items-center gap-2 px-3 py-2 text-sm text-left hover:bg-[var(--glass-2-surface)]"
        onClick={() => setOpen((v) => !v)}
      >
        <Wrench size={14} className="text-[var(--text-tertiary)] shrink-0" />
        <span className="font-mono text-xs text-[var(--text-tertiary)] shrink-0">{entry.toolKind}</span>
        <span className="truncate flex-1">{entry.title}</span>
        <StatusIcon status={entry.status} />
      </button>

      {(open || waiting) && (
        <div className="px-3 pb-3 space-y-2 border-t border-[color:var(--border-subtle)]">
          {entry.content.map((c, i) =>
            c.type === "diff" ? (
              <pre
                key={i}
                className="text-xs overflow-x-auto p-2 rounded bg-[var(--glass-2-surface)] text-[var(--text-secondary)]"
              >
                {c.path ? `# ${c.path}\n` : ""}
                {c.oldText != null ? `- ${c.oldText}\n` : ""}
                {c.newText != null ? `+ ${c.newText}` : ""}
              </pre>
            ) : (
              <pre
                key={i}
                className="text-xs overflow-x-auto p-2 rounded bg-[var(--glass-2-surface)] text-[var(--text-secondary)] whitespace-pre-wrap"
              >
                {c.text}
              </pre>
            ),
          )}

          {waiting && entry.options && entry.permissionRequestId && (
            <div className="flex flex-wrap gap-2 pt-1">
              {entry.options.map((opt) => (
                <Button
                  key={opt.optionId}
                  variant="outline"
                  size="sm"
                  onClick={() => void respondPermission(entry.permissionRequestId!, opt.optionId)}
                >
                  {opt.label}
                </Button>
              ))}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void respondPermission(entry.permissionRequestId!, null)}
              >
                Deny
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function StatusIcon({ status }: { status: ToolCallEntry["status"] }) {
  if (status === "completed") return <CheckCircle2 size={14} className="text-emerald-500 shrink-0" />;
  if (status === "failed") return <Circle size={14} className="text-red-500 shrink-0" />;
  if (status === "in_progress" || status === "waiting_for_confirmation") {
    return <Loader2 size={14} className="animate-spin text-[var(--accent)] shrink-0" />;
  }
  return <Circle size={14} className="text-[var(--text-tertiary)] shrink-0" />;
}
