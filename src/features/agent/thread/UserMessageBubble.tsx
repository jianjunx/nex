import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { formatTokensForDisplay } from "../composerTokens";
import { MessageContextMenu } from "./MessageContextMenu";
import { ThreadImageThumb } from "./ThreadImageThumb";
import { USER_MESSAGE_COLLAPSE_HEIGHT } from "./stickyUserMessage";
import type { UserMessageEntry } from "./types";

export const USER_MESSAGE_EXPANDED_MAX_HEIGHT = 360;

/**
 * 用户气泡：超长内容折叠到 150px，由父级控制展开态以便列表实例与吸顶克隆共用。
 */
export function UserMessageBubble({
  entry,
  expanded,
  onToggleExpand,
  floating = false,
}: {
  entry: UserMessageEntry;
  expanded: boolean;
  onToggleExpand: () => void;
  floating?: boolean;
}) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const [overflows, setOverflows] = useState(false);

  const measure = useCallback(() => {
    const el = bodyRef.current;
    if (!el) return;
    setOverflows(el.scrollHeight > USER_MESSAGE_COLLAPSE_HEIGHT + 1);
  }, []);

  useLayoutEffect(() => {
    measure();
  }, [measure, entry.text, entry.images, expanded]);

  const collapsed = overflows && !expanded;
  const expandedScrollable = overflows && expanded;

  return (
    <div className="ml-auto flex min-w-0 max-w-[80%] justify-end">
      <MessageContextMenu textContent={entry.text ?? ""}>
        <Card
          className={cn(
            "relative min-w-0 max-w-full gap-0 overflow-hidden rounded-[calc(var(--radius-lg)+2px)] border px-3 py-1.5 text-sm shadow-[inset_0_1px_0_0_rgba(255,255,255,0.1)] backdrop-blur-[calc(var(--blur-floating)*0.35)]",
            floating
              ? "border-[color:var(--accent)]/24 bg-[color:color-mix(in_srgb,var(--accent)_10%,var(--material-floating))] shadow-[0_12px_28px_-12px_rgba(0,0,0,0.42),inset_0_1px_0_0_rgba(255,255,255,0.12)]"
              : "border-[color:var(--hairline-soft)] bg-[color:color-mix(in_srgb,var(--accent)_8%,var(--material-floating))]",
          )}
        >
          <CardContent className="min-w-0 px-0">
            <div
              ref={bodyRef}
              data-user-msg-body=""
              className={collapsed ? "overflow-hidden" : expandedScrollable ? "overflow-y-auto" : undefined}
              style={
                collapsed
                  ? { maxHeight: USER_MESSAGE_COLLAPSE_HEIGHT }
                  : expandedScrollable
                    ? { maxHeight: USER_MESSAGE_EXPANDED_MAX_HEIGHT }
                    : undefined
              }
            >
              {entry.images && entry.images.length > 0 && (
                <div className="mb-2 flex flex-wrap gap-2">
                  {entry.images.map((img, i) => (
                    <ThreadImageThumb key={i} image={img} />
                  ))}
                </div>
              )}
              {!entry.images?.length && entry.imageCount && entry.imageCount > 0 && (
                <p className="mb-1 text-xs text-[var(--text-tertiary)]">
                  图片 ×{entry.imageCount}
                </p>
              )}
              {entry.text ? (
                <p className="min-w-0 whitespace-pre-wrap wrap-anywhere">
                  {formatTokensForDisplay(entry.text)}
                </p>
              ) : null}
            </div>
            {overflows && (
              <div
                className={
                  collapsed
                    ? "pointer-events-none absolute inset-x-0 bottom-0 flex justify-center bg-gradient-to-t from-[color:color-mix(in_srgb,var(--accent)_8%,var(--material-floating))] from-35% via-[color:color-mix(in_srgb,var(--accent)_5%,var(--material-floating))] via-65% to-transparent pt-9 pb-1"
                    : "flex justify-center pt-1"
                }
              >
                <button
                  type="button"
                  className="pointer-events-auto inline-flex cursor-pointer items-center gap-0.5 rounded-[var(--radius-sm)] border border-[color:var(--hairline-soft)] bg-[color:color-mix(in_srgb,var(--material-floating)_78%,transparent)] px-1.5 py-0.5 text-[11px] text-[var(--text-secondary)] shadow-[inset_0_1px_0_0_var(--edge-highlight-soft)] hover:text-[var(--text-primary)]"
                  aria-expanded={expanded}
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggleExpand();
                  }}
                >
                  {expanded ? "收起" : "展开"}
                  {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                </button>
              </div>
            )}
          </CardContent>
        </Card>
      </MessageContextMenu>
    </div>
  );
}
