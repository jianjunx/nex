import { memo } from "react";
import { ChevronRight, Loader2, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ProcessPart } from "./groupThreadEntries";
import { ThinkingBlock } from "./ThinkingBlock";
import { ToolCallCard } from "./ToolCallCard";
import { isEditTool } from "./toolCallUtils";
import { useToolCardExpansionStore } from "./toolCardExpansion";

function summarize(parts: ProcessPart[]) {
  let thoughts = 0;
  let tools = 0;
  let edits = 0;
  let busy = false;
  for (const p of parts) {
    if (p.type === "thought") {
      thoughts += 1;
      continue;
    }
    tools += 1;
    if (isEditTool(p.entry)) edits += 1;
    const status = p.entry.status;
    if (status === "in_progress" || status === "pending") busy = true;
  }
  return { thoughts, tools, edits, busy };
}

function doneLabel(s: ReturnType<typeof summarize>): string {
  if (s.tools === 0) return s.thoughts > 1 ? `思考过程（${s.thoughts}）` : "思考过程";
  const pieces: string[] = [];
  if (s.thoughts > 0) pieces.push(`思考 ${s.thoughts} 次`);
  pieces.push(`工具调用 ${s.tools} 次`);
  if (s.edits > 0) pieces.push(`代码修改 ${s.edits} 处`);
  return pieces.join(" · ");
}

function liveLabel(parts: ProcessPart[]): string {
  const last = parts[parts.length - 1];
  if (last.type === "thought") return "思考中…";
  const kind = isEditTool(last.entry) ? "修改代码" : "执行";
  return `${kind} · ${last.entry.title}`;
}

/**
 * Reasoning and tool calls of one agent step run, folded into one disclosure.
 * While the run is still the tail of a live turn it stays open, showing the
 * current thought and any code edits; once the agent moves on (answer text
 * arrives or the turn ends) it folds into a one-line summary. An explicit
 * user toggle always wins over the automatic state.
 */
export const ProcessGroup = memo(function ProcessGroup({
  parts,
  active,
}: {
  parts: ProcessPart[];
  active: boolean;
}) {
  const groupKey = `group:${parts[0]?.key}`;
  const override = useToolCardExpansionStore((s) => s.overrides[groupKey]);
  const setExpanded = useToolCardExpansionStore((s) => s.setExpanded);
  const open = override ?? active;
  const stats = summarize(parts);
  const label = active ? `${liveLabel(parts)}` : doneLabel(stats);
  const lastIndex = parts.length - 1;

  return (
    <div className="max-w-[96%]">
      <button
        type="button"
        aria-expanded={open}
        className="inline-flex max-w-full cursor-pointer items-center gap-1.5 text-xs text-[var(--text-tertiary)] transition-colors hover:text-[var(--text-secondary)]"
        onClick={() => setExpanded(groupKey, !open)}
      >
        {active ? (
          <Loader2 size={12} className="shrink-0 animate-spin text-[var(--accent)]" />
        ) : (
          <Sparkles size={12} className="shrink-0" />
        )}
        <span className="truncate">{label}</span>
        {active && (stats.tools > 0 || stats.thoughts > 1) && (
          <span className="shrink-0 opacity-70">· {doneLabel(stats)}</span>
        )}
        <ChevronRight
          size={12}
          className={cn("shrink-0 transition-transform", open && "rotate-90")}
        />
      </button>
      {open && (
        <div className="mt-1.5 ml-1.5 space-y-1.5 border-l border-[color:var(--hairline-soft)] pl-3">
          {parts.map((p, i) =>
            p.type === "thought" ? (
              <ThinkingBlock
                key={p.key}
                text={p.text}
                defaultOpen={active && i === lastIndex}
              />
            ) : (
              <ToolCallCard
                key={p.key}
                entry={p.entry}
                defaultOpen={active ? undefined : false}
              />
            ),
          )}
        </div>
      )}
    </div>
  );
});
