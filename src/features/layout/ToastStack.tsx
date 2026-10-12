import { useEffect } from "react";
import { AlertTriangle, Check, Info, X } from "lucide-react";
import { useToastStore, type AppToast, type ToastVariant } from "../../stores/toast.store";

/** 成功/信息 4s 后消失，错误留久一点（要读完原因）。 */
const AUTO_DISMISS_MS: Record<ToastVariant, number> = {
  success: 4000,
  info: 4000,
  error: 7000,
};

const VARIANT_ICON: Record<ToastVariant, typeof Check> = {
  success: Check,
  error: AlertTriangle,
  info: Info,
};

const VARIANT_COLOR: Record<ToastVariant, string> = {
  success: "text-[var(--success)]",
  error: "text-[var(--error)]",
  info: "text-[var(--text-tertiary)]",
};

function ToastCard({ t }: { t: AppToast }) {
  const dismiss = useToastStore((s) => s.dismiss);
  const Icon = VARIANT_ICON[t.variant];

  useEffect(() => {
    const timer = window.setTimeout(() => dismiss(t.id), AUTO_DISMISS_MS[t.variant]);
    return () => window.clearTimeout(timer);
  }, [t.id, t.variant, dismiss]);

  return (
    <div
      role="status"
      className="animate-in fade-in slide-in-from-top-2 duration-200 group nex-material-floating flex items-start gap-2 rounded-[var(--radius-md)] border border-[color:var(--hairline-soft)] px-3 py-2"
    >
      <Icon size={14} className={`mt-0.5 shrink-0 ${VARIANT_COLOR[t.variant]}`} />
      <div className="min-w-0 flex-1">
        <p className="text-sm text-[var(--text-primary)]">{t.message}</p>
        {t.detail && (
          <p className="mt-0.5 line-clamp-2 text-xs text-[var(--text-secondary)]">{t.detail}</p>
        )}
      </div>
      <span
        role="button"
        aria-label="关闭提示"
        className="nex-interactive-chrome shrink-0 rounded-[var(--radius-sm)] p-1 text-[var(--text-tertiary)] opacity-0 hover:bg-[var(--overlay-hover)] hover:text-[var(--text-primary)] group-hover:opacity-100"
        onClick={() => dismiss(t.id)}
      >
        <X size={13} />
      </span>
    </div>
  );
}

/**
 * 顶部居中轻提示堆栈（最新在上，最多 4 条）。
 *
 * 不放右下角：Git 面板就在右侧，失败时它会自动展开操作日志， toast 压上去正好
 * 盖住要给人看的内容；左上角已被 Agent 通知占用。顶部居中被 TopBar 托住，
 * 不挡任何控件，也不盖住会话输入框。
 */
export function ToastStack() {
  const items = useToastStore((s) => s.items);
  if (items.length === 0) return null;
  return (
    <div
      className="fixed left-1/2 top-12 z-[85] flex w-72 -translate-x-1/2 flex-col gap-2"
      data-testid="toast-stack"
    >
      {items.map((t) => (
        <ToastCard key={t.id} t={t} />
      ))}
    </div>
  );
}
