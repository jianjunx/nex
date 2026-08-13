import { create } from "zustand";
import {
  updateCheckLatest,
  updateDownloadAndInstall,
  onUpdateDownloadProgress,
  type UpdateInfo,
} from "../bridge/tauri";
import { useAgentStore } from "./agent.store";

export type UpdateStatus =
  | "idle"
  | "checking"
  | "up-to-date"
  | "available"
  | "downloading"
  | "error";

interface UpdateStore {
  status: UpdateStatus;
  info: UpdateInfo | null;
  /** Download percentage 0..100; null when the server sent no Content-Length. */
  progress: number | null;
  error: string | null;
  /** User dismissed the startup banner for this detected version. */
  bannerDismissed: boolean;

  /** Query the latest GitHub release. silent=true (startup auto-check) only
   * surfaces the "available" state; manual checks also report up-to-date. */
  check: (silent?: boolean) => Promise<void>;
  /** Download the installer, quit, replace the app, and relaunch. */
  downloadAndInstall: () => Promise<void>;
  dismissBanner: () => void;
}

function errorMessage(err: unknown): string {
  if (err && typeof err === "object" && "message" in err && typeof (err as { message: unknown }).message === "string") {
    return (err as { message: string }).message;
  }
  return String(err);
}

export const useUpdateStore = create<UpdateStore>()((set, get) => ({
  status: "idle",
  info: null,
  progress: null,
  error: null,
  bannerDismissed: false,

  check: async (silent = false) => {
    const { status } = get();
    if (status === "checking" || status === "downloading") return;
    set({ status: "checking", error: null });
    try {
      const info = await updateCheckLatest();
      if (info.update_available) {
        set({ status: "available", info, bannerDismissed: false });
      } else if (!silent) {
        set({ status: "up-to-date", info });
      } else {
        set({ status: "idle", info });
      }
    } catch (err) {
      if (!silent) {
        set({ status: "error", error: errorMessage(err) });
      } else {
        // Startup check must never nag about network failures.
        set({ status: "idle", error: null });
      }
    }
  },

  downloadAndInstall: async () => {
    const info = get().info;
    if (!info?.asset_url || !info.asset_name) {
      set({
        status: "error",
        error: "该版本没有当前平台的安装包，请前往 GitHub 下载",
      });
      return;
    }
    // Persist mid-turn threads before the app exits for the installer.
    await useAgentStore.getState().flushThreadSnapshots().catch(() => {});
    set({ status: "downloading", progress: 0, error: null });
    const unlisten = await onUpdateDownloadProgress((p) => {
      set({ progress: p.percent });
    }).catch(() => null);
    try {
      await updateDownloadAndInstall(info.asset_url, info.asset_name);
      // Process should be exiting so the helper can replace the bundle.
    } catch (err) {
      set({ status: "error", error: errorMessage(err) });
    } finally {
      unlisten?.();
    }
  },

  dismissBanner: () => set({ bannerDismissed: true }),
}));
