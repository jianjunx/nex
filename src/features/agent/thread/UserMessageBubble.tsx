import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { MessageContextMenu } from "./MessageContextMenu";
import { ThreadImageThumb } from "./ThreadImageThumb";
import { USER_MESSAGE_COLLAPSE_HEIGHT } from "./stickyUserMessage";
import type { UserMessageEntry } from "./types";

/**
 * 用户气泡：超长内容折叠到 230px，由父级控制展开态以便列表实例与吸顶克隆共用。
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

  return (
    <div className="ml-auto flex min-w-0 max-w-[80%] justify-end">
      <MessageContextMenu textContent={entry.text ?? ""}>
        <Card
          className={cn(
            "relative min-w-0 max-w-full gap-0 overflow-hidden px-3 py-1.5 text-sm border-[color:var(--accent)]/25",
            floating
              ? "bg-[color-mix(in_srgb,var(--accent)_18%,var(--background))] shadow-[0_8px_20px_-6px_rgba(0,0,0,0.45)]"
              : "bg-[var(--accent)]/15 shadow-none",
          )}
        >
          <CardContent className="min-w-0 px-0">
            <div
              ref={bodyRef}
              data-user-msg-body=""
              className={collapsed ? "overflow-hidden" : undefined}
              style={collapsed ? { maxHeight: USER_MESSAGE_COLLAPSE_HEIGHT } : undefined}
            >
              {entry.images && entry.images.length > 0 && (
                <div className="mb-2 flex flex-wrap gap-2">
                  {entry.images.map((img, i) => (
                    <ThreadImageThumb key={i} image={img} />
                  ))}
                </div>
              )}
              {entry.text ? (
                <p className="min-w-0 whitespace-pre-wrap wrap-anywhere">{entry.text}</p>
              ) : null}
            </div>
            {overflows && (
              <div
                className={
                  collapsed
                    ? "pointer-events-none absolute inset-x-0 bottom-0 flex justify-center bg-gradient-to-t from-[color-mix(in_srgb,var(--accent)_15%,var(--background))] from-40% to-transparent pt-10 pb-1"
                    : "flex justify-center pt-1"
                }
              >
                <button
                  type="button"
                  className="pointer-events-auto inline-flex cursor-pointer items-center gap-0.5 rounded-md px-1.5 py-0.5 text-[11px] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
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
