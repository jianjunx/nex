import { useEffect } from "react";
import { BellRing, X } from "lucide-react";
import { useNotificationStore, type AppNotification } from "../../stores/notification.store";

/** 通知 8 秒后自动消失；点击卡片跳转到对应项目会话。 */
const AUTO_DISMISS_MS = 8000;

function NotificationCard({ n }: { n: AppNotification }) {
  const dismiss = useNotificationStore((s) => s.dismiss);
  const activate = useNotificationStore((s) => s.activate);

  useEffect(() => {
    const t = window.setTimeout(() => dismiss(n.id), AUTO_DISMISS_MS);
    return () => window.clearTimeout(t);
  }, [n.id, dismiss]);

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => activate(n.id)}
      onKeyDown={(e) => {
        if (e.key === "Enter") activate(n.id);
      }}
      className="animate-in fade-in slide-in-from-left-2 duration-200 group nex-material-floating nex-interactive-chrome cursor-pointer rounded-[calc(var(--radius-md)+2px)] border border-[color:var(--hairline-soft)] px-3 py-2.5 hover:border-[color:var(--hairline-strong)] hover:bg-[color:color-mix(in_srgb,var(--material-elevated)_82%,transparent)]"
      title="点击跳转到对应会话"
    >
      <div className="flex items-center gap-2">
        <BellRing size={14} className="shrink-0 text-[var(--accent)]" />
        <span className="flex-1 truncate text-sm font-semibold text-[var(--text-primary)]">
          {n.title}
        </span>
        <span
          role="button"
          className="nex-interactive-chrome shrink-0 rounded-[var(--radius-sm)] p-1 text-[var(--text-tertiary)] opacity-0 hover:bg-[var(--overlay-hover)] hover:text-[var(--text-primary)] group-hover:opacity-100"
          onClick={(e) => {
            e.stopPropagation();
            dismiss(n.id);
          }}
        >
          <X size={13} />
        </span>
      </div>
      {n.body && (
        <p className="mt-1 line-clamp-2 text-xs text-[var(--text-secondary)]">{n.body}</p>
      )}
    </div>
  );
}

/** 左上角通知堆栈（最新在上，最多 5 条）。 */
export function NotificationStack() {
  const items = useNotificationStore((s) => s.items);
  if (items.length === 0) return null;
  return (
    <div className="fixed left-3 top-12 z-[80] flex w-80 flex-col gap-2.5">
      {items.map((n) => (
        <NotificationCard key={n.id} n={n} />
      ))}
    </div>
  );
}
