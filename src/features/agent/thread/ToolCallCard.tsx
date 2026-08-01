import { useEffect } from "react";
import { CheckCircle2, ChevronRight, Circle, Loader2, Pencil, Wrench } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { ToolCallEntry } from "./types";
import { formatToolRawInput } from "./applySessionUpdate";
import { isEditTool } from "./toolCallUtils";
import { ThreadDiffBlock } from "./ThreadDiffBlock";
import { useToolCardExpansionStore } from "./toolCardExpansion";
import { useAgentStore } from "../../../stores/agent.store";

export function ToolCallCard({
  entry,
  defaultOpen,
}: {
  entry: ToolCallEntry;
  defaultOpen?: boolean;
}) {
  const isEdit = isEditTool(entry);
  const waiting = entry.status === "waiting_for_confirmation";
  const override = useToolCardExpansionStore((s) => s.overrides[entry.toolCallId]);
  const setExpanded = useToolCardExpansionStore((s) => s.setExpanded);
  const open = override ?? (defaultOpen ?? (isEdit || waiting));
  const respondPermission = useAgentStore((s) => s.respondPermission);
  const Icon = isEdit ? Pencil : Wrench;
  const rawInputText = formatToolRawInput(entry.rawInput);

  // Permission prompts must surface even if the card started collapsed.
  useEffect(() => {
    if (waiting) setExpanded(entry.toolCallId, true);
  }, [waiting, entry.toolCallId, setExpanded]);

  return (
    <div className="rounded-[var(--radius-md)] border border-[color:var(--glass-border)] bg-[var(--glass-3-surface)] overflow-hidden">
      <button
        type="button"
        className="w-full flex items-center gap-2 px-2.5 py-1.5 text-sm text-left hover:bg-[var(--glass-2-surface)]"
        onClick={() => setExpanded(entry.toolCallId, !open)}
      >
        <Icon size={14} className="text-[var(--text-tertiary)] shrink-0" />
        <span className="font-mono text-xs text-[var(--text-tertiary)] shrink-0">{entry.toolKind}</span>
        <span className="truncate flex-1">{entry.title}</span>
        <StatusIcon status={entry.status} />
      </button>

      {(open || waiting) && (
        <div
          className={cn(
            "px-2.5 pb-2 space-y-1.5 border-t border-[color:var(--border-subtle)]",
            isEdit && "max-h-[350px] overflow-y-auto",
          )}
        >
          {entry.content.map((c, i) =>
            c.type === "diff" ? (
              <ThreadDiffBlock
                key={i}
                path={c.path}
                oldText={c.oldText}
                newText={c.newText}
              />
            ) : (
              <pre
                key={i}
                className="text-xs overflow-x-auto p-2 rounded bg-[var(--glass-2-surface)] text-[var(--text-secondary)] whitespace-pre-wrap"
              >
                {c.text}
              </pre>
            ),
          )}

          {entry.content.length === 0 && rawInputText && (
            <pre className="text-xs overflow-x-auto p-2 rounded bg-[var(--glass-2-surface)] text-[var(--text-secondary)] whitespace-pre-wrap">
              {rawInputText}
            </pre>
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

/** Collapsed run of adjacent non-edit tool calls. */
export function ToolCallGroup({ entries }: { entries: ToolCallEntry[] }) {
  const groupKey = `group:${entries[0]?.id}`;
  const needsPermission = entries.some((e) => e.status === "waiting_for_confirmation");
  const override = useToolCardExpansionStore((s) => s.overrides[groupKey]);
  const setExpanded = useToolCardExpansionStore((s) => s.setExpanded);
  const open = override ?? needsPermission;

  useEffect(() => {
    if (needsPermission) setExpanded(groupKey, true);
  }, [needsPermission, groupKey, setExpanded]);

  const busy = entries.some(
    (e) =>
      e.status === "in_progress" ||
      e.status === "waiting_for_confirmation" ||
      e.status === "pending",
  );

  return (
    <div className="max-w-[96%]">
      <button
        type="button"
        className="inline-flex items-center gap-1 text-xs text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] transition-colors"
        onClick={() => setExpanded(groupKey, !open)}
      >
        <span>查看工具调用（{entries.length}）</span>
        {busy && !open ? (
          <Loader2 size={12} className="animate-spin text-[var(--accent)]" />
        ) : (
          <ChevronRight
            size={12}
            className={cn("transition-transform", open && "rotate-90")}
          />
        )}
      </button>
      {open && (
        <div className="mt-2 space-y-2">
          {entries.map((e) => (
            <ToolCallCard key={e.id} entry={e} defaultOpen={false} />
          ))}
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
