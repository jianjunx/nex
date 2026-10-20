import { memo } from "react";
import ToolChips, { ToolRunHeader } from "@/components/agent-ui/beautiful-ui/ToolChips";
import { Collapse } from "@/components/ui/Collapse";
import type { ProcessPart } from "./groupThreadEntries";
import { ThinkingBlock } from "./ThinkingBlock";
import { ToolCallCard } from "./ToolCallCard";
import { isEditTool } from "./toolCallUtils";
import { useToolCardExpansionStore } from "./toolCardExpansion";

function isRunning(part: ProcessPart): boolean {
  return part.type === "tool" && (part.entry.status === "in_progress" ||
    part.entry.status === "pending" || part.entry.status === "waiting_for_confirmation");
}

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
    if (isRunning(p)) busy = true;
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
  const last = parts.at(-1)!;
  if (last.type === "thought") return "思考中…";
  const running = parts.findLast(isRunning) ?? last;
  if (running.type !== "tool") return "思考中…";
  const kind = isEditTool(running.entry) ? "修改代码" : "执行";
  return `${kind} · ${running.entry.title}`;
}

/**
 * Reasoning and tool calls of one agent step run, folded into one disclosure.
 * Keep running tools and the latest finished tool visible while working.
 * Older tools/reasoning only mount when the user expands the history.
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
  const open = override ?? false;
  const stats = summarize(parts);
  const lastIndex = parts.length - 1;
  const live = active && (stats.busy || parts[lastIndex]?.type === "thought");
  const label = live ? liveLabel(parts) : doneLabel(stats);
  const suffix =
    live && (stats.tools > 0 || stats.thoughts > 1) ? ` · ${doneLabel(stats)}` : "";
  const previous = active && stats.busy
    ? parts.findLast((p) => p.type === "tool" && !isRunning(p))
    : undefined;
  const visible = (p: ProcessPart, i: number) => active && (
    isRunning(p) || p === previous || (p.type === "thought" && i === lastIndex)
  );
  const renderPart = (p: ProcessPart, i: number) => p.type === "thought" ? (
    <ThinkingBlock
      key={p.key}
      text={p.text}
      defaultOpen={active && i === lastIndex}
      streaming={active && i === lastIndex}
    />
  ) : (
    <ToolCallCard key={p.key} entry={p.entry} defaultOpen={visible(p, i) ? undefined : false} />
  );

  return (
    <ToolChips className="max-w-[96%]">
      <ToolRunHeader
        open={open}
        busy={live}
        label={`${label}${suffix}`}
        onToggle={() => setExpanded(groupKey, !open)}
      />
      <Collapse open={open}>
        <div className="mt-1.5 flex flex-col gap-1">
          {parts.map((p, i) => !visible(p, i) ? renderPart(p, i) : null)}
        </div>
      </Collapse>
      {live && (
        <div className="mt-1.5 flex flex-col gap-1">
          {parts.map((p, i) => visible(p, i) ? renderPart(p, i) : null)}
        </div>
      )}
    </ToolChips>
  );
});
