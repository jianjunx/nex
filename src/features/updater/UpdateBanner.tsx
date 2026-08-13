import { Download, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useUpdateStore } from "../../stores/update.store";
import { useUiStore } from "../../stores/ui.store";

/**
 * Bottom-right toast shown when the startup auto-check finds a new release.
 * "查看" jumps straight to the About settings section; the installer itself is
 * triggered from there so users see download progress.
 */
export function UpdateBanner() {
  const status = useUpdateStore((s) => s.status);
  const info = useUpdateStore((s) => s.info);
  const dismissed = useUpdateStore((s) => s.bannerDismissed);
  const dismissBanner = useUpdateStore((s) => s.dismissBanner);

  if (status !== "available" || dismissed || !info) return null;

  return (
    <div
      data-testid="update-banner"
      className="fixed bottom-4 right-4 z-50 flex items-center gap-3 rounded-[calc(var(--radius-md)+2px)] border border-[color:var(--hairline-soft)] nex-material-floating px-4 py-3"
    >
      <div className="text-sm">
        <div className="font-medium text-[var(--text-primary)]">发现新版本 v{info.latest_version}</div>
        <div className="text-xs text-[var(--text-tertiary)]">当前 v{info.current_version}</div>
      </div>
      <Button
        size="sm"
        variant="outline"
        onClick={() => {
          useUiStore.getState().setSettingsSection("about");
          useUiStore.getState().openSettings();
        }}
      >
        <Download size={14} />
        更新
      </Button>
      <button
        type="button"
        aria-label="忽略"
        className="nex-interactive-chrome rounded-[var(--radius-sm)] p-1 text-[var(--text-tertiary)] hover:bg-[var(--overlay-hover)] hover:text-[var(--text-primary)]"
        onClick={dismissBanner}
      >
        <X size={14} />
      </button>
    </div>
  );
}
