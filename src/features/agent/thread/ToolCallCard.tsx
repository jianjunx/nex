import { useEffect } from "react";
import { CheckCircle2, ChevronRight, Circle, Loader2, Pencil, Wrench } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { ToolCallEntry } from "./types";
import { formatToolRawInput } from "./applySessionUpdate";
import { entryDiffs, isEditTool, toolEntryFilePath } from "./toolCallUtils";
import { ThreadDiffBlock } from "./ThreadDiffBlock";
import { useToolCardExpansionStore } from "./toolCardExpansion";
import { useAgentStore } from "../../../stores/agent.store";
import { fileBasename } from "../../editor/pathUtils";
import { looksLikeFilePath, openPathToken } from "./pathToken";

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
  const filePath = toolEntryFilePath(entry);
  const titleIsPath = !!filePath && looksLikeFilePath(entry.title);

  // Permission prompts must surface even if the card started collapsed.
  useEffect(() => {
    if (waiting) setExpanded(entry.toolCallId, true);
  }, [waiting, entry.toolCallId, setExpanded]);

  return (
    <div className="rounded-[var(--radius-md)] border border-[color:var(--glass-border)] bg-[var(--glass-3-surface)] overflow-hidden shadow-[inset_0_1px_0_0_var(--edge-highlight)]">
      <div className="flex items-center gap-2 px-2.5 py-1.5 text-sm hover:bg-[var(--glass-2-surface)]">
        <button
          type="button"
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left"
          onClick={() => setExpanded(entry.toolCallId, !open)}
        >
          <Icon size={14} className="text-[var(--text-tertiary)] shrink-0" />
          <span className="font-mono text-xs text-[var(--text-tertiary)] shrink-0">{entry.toolKind}</span>
          {!titleIsPath && <span className="truncate flex-1">{entry.title}</span>}
          <StatusIcon status={entry.status} />
        </button>
        {filePath && (
          <button
            type="button"
            title="在编辑器中打开"
            className="max-w-[60%] shrink cursor-pointer truncate font-mono text-xs text-[var(--accent)] underline decoration-[color:var(--accent)]/30 underline-offset-2 hover:decoration-[color:var(--accent)]"
            onClick={() => void openPathToken(filePath)}
          >
            {titleIsPath ? entry.title : fileBasename(filePath)}
          </button>
        )}
      </div>

      {(open || waiting) && (
        <div
          className={cn(
            "px-2.5 pb-2 space-y-1.5 border-t border-[color:var(--border-subtle)]",
            isEdit && "max-h-[350px] overflow-y-auto",
          )}
        >
          {/* 内嵌 diff：标准 ACP 的 diff 块 + NexAgent 从 rawInput 合成的伪 diff */}
          {entryDiffs(entry).map((d, i) => (
            <ThreadDiffBlock
              key={`diff-${i}`}
              cacheKey={`${entry.id}:diff-${i}`}
              path={d.path}
              oldText={d.oldText}
              newText={d.newText}
            />
          ))}
          {entry.content.map((c, i) => {
            if (c.type === "diff") {
              // 已在上面 entryDiffs 渲染，避免重复。
              return null;
            }
            if (c.type === "image" && c.data) {
              const src = `data:${c.mimeType || "image/png"};base64,${c.data}`;
              return (
                <a
                  key={i}
                  href={src}
                  target="_blank"
                  rel="noreferrer"
                  className="block"
                  title={c.path || "image"}
                >
                  <img
                    src={src}
                    alt={c.path || "generated"}
                    className="max-h-64 max-w-full rounded border border-[color:var(--border-subtle)] object-contain"
                  />
                </a>
              );
            }
            if (c.type === "terminal") {
              return (
                <pre
                  key={i}
                  className="text-xs overflow-x-auto p-2 rounded bg-black/80 text-emerald-200/90 whitespace-pre-wrap font-mono"
                >
                  {c.terminalId ? `$ terminal ${c.terminalId}\n` : ""}
                  {c.text}
                </pre>
              );
            }
            return (
              <pre
                key={i}
                className="text-xs overflow-x-auto p-2 rounded bg-[var(--glass-2-surface)] text-[var(--text-secondary)] whitespace-pre-wrap"
              >
                {c.text}
              </pre>
            );
          })}

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

/** Collapsed run of adjacent tool calls (edits included; permission prompts stay standalone). */
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
        className="inline-flex cursor-pointer items-center gap-1 text-xs text-[var(--text-tertiary)] transition-colors hover:text-[var(--text-secondary)]"
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
