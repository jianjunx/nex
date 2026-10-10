import { useEffect } from "react";
import ToolChips, {
  ToolChipRow,
  type ToolChipIcon,
} from "@/components/agent-ui/beautiful-ui/ToolChips";
import type { ToolCallEntry } from "./types";
import { formatToolRawInput } from "./applySessionUpdate";
import { entryDiffs, isEditTool, toolEntryFilePath } from "./toolCallUtils";
import { ThreadDiffBlock } from "./ThreadDiffBlock";
import { useToolCardExpansionStore } from "./toolCardExpansion";
import { useAgentStore } from "../../../stores/agent.store";
import { fileBasename } from "../../editor/pathUtils";
import { looksLikeFilePath, openPathToken } from "./pathToken";
import { PermissionApproval } from "../PermissionApproval";

function prettyKind(kind: string): string {
  const trimmed = kind.trim();
  if (!trimmed) return "工具";
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

/** Verb beside the row, and the text that follows it. File tools show the basename only. */
function toolRowText(
  entry: ToolCallEntry,
  filePath: string | null,
): { label: string; chip: string } {
  const title = entry.title.trim();
  if (!filePath) return { label: prettyKind(entry.toolKind), chip: title };
  const base = fileBasename(filePath);
  let rest = title;
  if (filePath && rest.endsWith(filePath)) rest = rest.slice(0, -filePath.length).trim();
  else if (base && rest.endsWith(base)) rest = rest.slice(0, -base.length).trim();
  rest = rest.replace(/['"`]+$/g, "").trim();
  if (/[/\\]/.test(rest)) {
    rest = /^[A-Za-z][\w-]*/.exec(rest)?.[0] ?? "";
  }
  if (!rest || looksLikeFilePath(rest)) rest = prettyKind(entry.toolKind);
  return { label: rest, chip: base };
}

function iconForKind(kind: string): ToolChipIcon {
  const k = kind.toLowerCase();
  if (/(think|reason|plan)/.test(k)) return "think";
  if (/(edit|write|patch|delete|strreplace|apply)/.test(k)) return "write";
  if (/(read|search|grep|glob|list|fetch|open)/.test(k)) return "read";
  return "run";
}

function ToolCallCardContent({
  entry,
  defaultOpen,
}: {
  entry: ToolCallEntry;
  defaultOpen?: boolean;
}) {
  const isEdit = isEditTool(entry);
  const waiting = entry.status === "waiting_for_confirmation";
  const override = useToolCardExpansionStore(
    (s) => s.overrides[entry.toolCallId],
  );
  const setExpanded = useToolCardExpansionStore((s) => s.setExpanded);
  const open = override ?? defaultOpen ?? (isEdit || waiting);
  const respondPermission = useAgentStore((s) => s.respondPermission);
  const rawInputText = formatToolRawInput(entry.rawInput);
  const filePath = toolEntryFilePath(entry);
  const { label, chip } = toolRowText(entry, filePath);
  const busy =
    entry.status === "in_progress" || entry.status === "waiting_for_confirmation";

  // Permission prompts must surface even if the card started collapsed.
  useEffect(() => {
    if (waiting) setExpanded(entry.toolCallId, true);
  }, [waiting, entry.toolCallId, setExpanded]);

  const hasDetail =
    entryDiffs(entry).length > 0 ||
    entry.content.length > 0 ||
    Boolean(rawInputText);

  return (
    <ToolChips>
      <ToolChipRow
        icon={iconForKind(entry.toolKind)}
        label={label}
        chip={chip}
        mono={Boolean(filePath)}
        fitChip={Boolean(filePath)}
        open={open || waiting}
        busy={busy}
        failed={entry.status === "failed"}
        chipTitle={filePath ?? undefined}
        onChipClick={
          filePath ? () => void openPathToken(filePath) : undefined
        }
        onToggle={() => setExpanded(entry.toolCallId, !open)}
      >
        {hasDetail ? (
          <>
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
              if (c.type === "diff") return null;
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
                      className="max-h-64 max-w-full rounded-control border border-line object-contain"
                    />
                  </a>
                );
              }
              if (c.type === "terminal") {
                return (
                  <pre
                    key={i}
                    className="overflow-x-auto rounded-control bg-inset p-2 font-mono text-[11.5px] whitespace-pre-wrap text-green"
                  >
                    {c.terminalId ? `$ terminal ${c.terminalId}\n` : ""}
                    {c.text}
                  </pre>
                );
              }
              return (
                <pre
                  key={i}
                  className="overflow-x-auto rounded-control bg-inset p-2 font-mono text-[11.5px] whitespace-pre-wrap text-ink-2"
                >
                  {c.text}
                </pre>
              );
            })}
            {entry.content.length === 0 && rawInputText && (
              <pre className="overflow-x-auto rounded-control bg-inset p-2 font-mono text-[11.5px] whitespace-pre-wrap text-ink-2">
                {rawInputText}
              </pre>
            )}
          </>
        ) : null}
      </ToolChipRow>
      {waiting && entry.options && entry.permissionRequestId && (
        <div className="mt-2">
          <PermissionApproval
            title={entry.title || "需要你的确认"}
            options={entry.options}
            onRespond={(optionId) =>
              void respondPermission(entry.permissionRequestId!, optionId)
            }
          />
        </div>
      )}
    </ToolChips>
  );
}

export function ToolCallCard(props: Parameters<typeof ToolCallCardContent>[0]) {
  return <ToolCallCardContent {...props} />;
}
