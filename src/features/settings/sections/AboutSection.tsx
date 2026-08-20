import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { Loader2, Download, ExternalLink, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { openExternal } from "../../../bridge/tauri";
import { useUpdateStore } from "../../../stores/update.store";
import { SECTION_HEADER } from "./_shared";

const GITHUB_REPO_URL = "https://github.com/jianjunx/nex";

const platform = typeof navigator !== "undefined" ? navigator.platform : "";
const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
const isWindows = platform.startsWith("Win") || ua.includes("Windows");
const isMac = platform.startsWith("Mac") || /Macintosh/.test(ua);

/** Platform-specific copy for the post-download install/relaunch step. */
function updateInstallHint(): string {
  if (isWindows) return "完成后会自动退出、静默安装并重新打开";
  if (isMac) return "完成后会自动退出、替换应用并重新打开";
  return "完成后会自动退出并完成更新，然后重新打开";
}

/** lucide 已移除品牌图标，内置 GitHub mark。 */
function GithubIcon({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.55v-2.15c-3.2.7-3.87-1.36-3.87-1.36-.53-1.33-1.28-1.69-1.28-1.69-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.23-1.28-5.23-5.68 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.18 1.18a11.1 11.1 0 0 1 5.79 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.83 1.19 3.09 0 4.41-2.69 5.38-5.25 5.66.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.55A11.51 11.51 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5Z" />
    </svg>
  );
}

export function AboutSection() {
  const [version, setVersion] = useState<string | null>(null);
  const status = useUpdateStore((s) => s.status);
  const info = useUpdateStore((s) => s.info);
  const progress = useUpdateStore((s) => s.progress);
  const error = useUpdateStore((s) => s.error);
  const check = useUpdateStore((s) => s.check);
  const downloadAndInstall = useUpdateStore((s) => s.downloadAndInstall);

  useEffect(() => {
    let alive = true;
    getVersion()
      .then((v) => alive && setVersion(v))
      .catch(() => alive && setVersion(null));
    return () => {
      alive = false;
    };
  }, []);

  const checking = status === "checking";
  const downloading = status === "downloading";
  const busy = checking || downloading;

  return (
    <section className="space-y-5">
      <div>
        <div className={SECTION_HEADER}>关于</div>
        <div className="flex items-center gap-3">
          <img src="/favicon.svg" alt="Nex" className="size-10 rounded-xl" />
          <div>
            <div className="text-sm font-semibold text-[var(--text-primary)]">Nex</div>
            <div className="text-xs text-[var(--text-tertiary)]">
              {version ? `版本 ${version}` : "AI Agent 集成环境"}
            </div>
          </div>
        </div>
      </div>

      <div>
        <div className={SECTION_HEADER}>项目</div>
        <button
          type="button"
          onClick={() => void openExternal(GITHUB_REPO_URL).catch(() => {})}
          className="inline-flex items-center gap-2 text-sm text-[var(--text-secondary)] hover:text-[var(--accent)] transition-colors"
        >
          <GithubIcon size={15} />
          <span className="underline underline-offset-2">{GITHUB_REPO_URL}</span>
          <ExternalLink size={12} className="opacity-60" />
        </button>
        <p className="mt-1.5 text-xs text-[var(--text-tertiary)]">
          源代码、问题反馈与版本发布均在 GitHub。
        </p>
      </div>

      <div>
        <div className={SECTION_HEADER}>检查更新</div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void check(false)}>
            {checking ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
            {checking ? "检查中…" : "检查更新"}
          </Button>

          {status === "available" && info && (
            <Button size="sm" disabled={downloading} onClick={() => void downloadAndInstall()}>
              {downloading ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
              {downloading
                ? progress === null
                  ? "下载中…"
                  : `下载中 ${progress}%`
                : `更新到 v${info.latest_version}`}
            </Button>
          )}
        </div>

        {downloading && progress !== null && (
          <div className="mt-2 h-1.5 w-full max-w-xs overflow-hidden rounded-full bg-[var(--glass-2-surface)]">
            <div
              className="h-full rounded-full bg-[var(--accent)] transition-[width]"
              style={{ width: `${progress}%` }}
            />
          </div>
        )}

        <p className="mt-2 text-xs text-[var(--text-tertiary)]" data-testid="update-status">
          {status === "up-to-date" && info && <>已是最新版本（v{info.latest_version}）。</>}
          {status === "available" && info && (
            <>发现新版本 v{info.latest_version}，点击右侧按钮下载；{updateInstallHint()}。若未成功，请查看应用数据目录下 <code className="text-[11px]">updater/install-and-relaunch.log</code>。</>
          )}
          {status === "error" && <span className="text-red-500">{error ?? "检查更新失败"}</span>}
          {status === "idle" && <>启动时会自动检查一次更新。</>}
          {downloading && <>正在下载安装包，{updateInstallHint()}。</>}
        </p>
      </div>
    </section>
  );
}
