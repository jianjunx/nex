import { useEffect, useState } from "react";
import { Popover } from "radix-ui";
import { Server, Play, RotateCw, Square, ScrollText, ExternalLink, Trash2, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { serviceList, serviceAction, serviceLogs, openExternal, type LocalService } from "@/bridge/tauri";
import { useProjectStore } from "@/stores/project.store";
import { errorMessage } from "@/lib/errors";
import { toastError } from "@/stores/toast.store";

const STATUS = { starting: "启动中", running: "运行中", stopped: "已停止", failed: "启动失败" };
const ACTION_CLASS = "active:scale-100 focus-visible:outline focus-visible:outline-1 focus-visible:outline-[var(--hairline-strong)]";

export function LocalServicesMenu() {
  const projectPath = useProjectStore((s) => s.projects.find((p) => p.id === s.activeProjectId)?.path);
  const [open, setOpen] = useState(false);
  const [snapshot, setSnapshot] = useState<{ projectPath: string; services: LocalService[] }>();
  const [logId, setLogId] = useState<string | null>(null);
  const [logs, setLogs] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const services = snapshot && snapshot.projectPath === projectPath ? snapshot.services : [];
  const running = services.filter((s) => s.status === "running" || s.status === "starting").length;

  useEffect(() => {
    setLogId(null);
    setLogs("");
  }, [projectPath]);

  useEffect(() => {
    if (!projectPath) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (document.visibilityState === "hidden") {
        timer = setTimeout(poll, 5000);
        return;
      }
      setLoading(true);
      try {
        const [next, output] = await Promise.all([
          serviceList(projectPath),
          open && logId ? serviceLogs(projectPath, logId) : Promise.resolve(""),
        ]);
        if (cancelled) return;
        setSnapshot({ projectPath, services: next });
        setLogs(output);
        setLoadError(null);
      } catch (error) {
        if (!cancelled) setLoadError(errorMessage(error));
      } finally {
        if (!cancelled) {
          setLoading(false);
          timer = setTimeout(poll, open ? 2000 : 5000);
        }
      }
    };
    void poll();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [projectPath, open, logId, refresh]);

  // Repeated polling failures keep the same value, so they do not continually
  // reset the popup timer. Report background failures only when the menu opens.
  useEffect(() => {
    if (open && loadError) toastError("加载本地服务失败", loadError);
  }, [open, loadError]);

  const act = async (service: LocalService, action: "stop" | "restart" | "remove") => {
    if (!projectPath || busy) return;
    const path = projectPath;
    setBusy(service.id);
    try {
      await serviceAction(path, service.id, action);
      if (useProjectStore.getState().projects.find((p) => p.id === useProjectStore.getState().activeProjectId)?.path !== path) return;
      if (action === "remove" && logId === service.id) setLogId(null);
      setRefresh((r) => r + 1);
    } catch (error) {
      if (useProjectStore.getState().projects.find((p) => p.id === useProjectStore.getState().activeProjectId)?.path === path) {
        toastError("服务操作失败", error);
      }
    } finally { setBusy(null); }
  };

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <Button variant="ghost" size="icon-sm" disabled={!projectPath}
          title={`本地服务${running ? `（${running} 个运行中）` : ""}`} aria-label="本地服务"
          className={`relative text-[var(--text-tertiary)] ${ACTION_CLASS}`}>
          <Server size={15} />
          {running > 0 && <span className="absolute right-0 top-0.5 min-w-[14px] rounded-full bg-[var(--text-primary)] px-1 text-[9px] leading-[14px] text-[var(--material-canvas)]">{running}</span>}
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="end" sideOffset={8} aria-label="本地服务管理"
          className="z-50 w-[390px] max-w-[calc(100vw-24px)] rounded-[14px] border border-[var(--hairline-soft)] bg-[var(--material-floating)] p-3 text-[var(--text-primary)] shadow-lg outline-none">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-sm font-medium">本地服务</span>
            <Button variant="ghost" size="icon-xs" title="刷新" aria-label="刷新服务" disabled={loading} className={ACTION_CLASS} onClick={() => setRefresh((r) => r + 1)}>
              {loading ? <Loader2 className="animate-spin motion-reduce:animate-none" /> : <RotateCw />}
            </Button>
          </div>
          {services.length === 0 && <p className="py-6 text-center text-xs text-[var(--text-tertiary)]">
            {loading ? "正在获取服务…" : "暂无托管服务。让 Agent 使用本地服务工具启动服务后，会显示在这里。"}
          </p>}
          <div className="max-h-[min(520px,65vh)] overflow-y-auto">
            {services.map((service) => {
              const active = service.status === "running" || service.status === "starting";
              const pending = busy === service.id;
              return <div key={service.id} className="border-t border-[var(--hairline-soft)] py-3 first:border-t-0">
                <div className="flex items-center gap-2">
                  <span role="img" aria-label={pending ? "处理中…" : STATUS[service.status]} title={service.error || STATUS[service.status]} className={`size-1.5 shrink-0 rounded-full ${service.status === "running" ? "bg-[var(--success)]" : service.status === "failed" ? "bg-[var(--error)]" : "bg-[var(--text-tertiary)]"}`} />
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">{service.name}</span>
                  {service.port && <span className="shrink-0 text-xs text-[var(--text-tertiary)]">{service.port}</span>}
                </div>
                <div className="mt-2 flex items-center gap-1">
                  <Button variant="ghost" size="icon-sm" className={ACTION_CLASS} title={active ? "重启" : "启动"} aria-label={active ? "重启" : "启动"} disabled={!!busy || service.status === "starting"} onClick={() => void act(service, "restart")}>{active ? <RotateCw /> : <Play />}</Button>
                  {active && <Button variant="ghost" size="icon-sm" className={ACTION_CLASS} title="停止" aria-label="停止" disabled={!!busy} onClick={() => void act(service, "stop")}><Square /></Button>}
                  <Button variant="ghost" size="icon-sm" className={ACTION_CLASS} title="日志" aria-label="日志" aria-expanded={logId === service.id} onClick={() => { setLogs(""); setLogId(logId === service.id ? null : service.id); }}><ScrollText /></Button>
                  {service.port && <Button variant="ghost" size="icon-sm" className={ACTION_CLASS} title="打开服务地址" aria-label={`打开 ${service.name}`} disabled={!service.listening} onClick={() => void openExternal(`http://localhost:${service.port}`).catch((e) => toastError("打开服务地址失败", e))}><ExternalLink /></Button>}
                  {!active && <Button variant="ghost" size="icon-sm" className={`ml-auto ${ACTION_CLASS}`} title="移除记录" aria-label={`移除 ${service.name}`} disabled={!!busy} onClick={() => void act(service, "remove")}><Trash2 /></Button>}
                </div>
                {logId === service.id && <pre role="log" aria-label={`${service.name} 日志`} className="mt-2 max-h-44 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-[var(--material-canvas)] p-2 font-mono text-[11px] text-[var(--text-secondary)]">{logs || "暂无日志"}</pre>}
              </div>;
            })}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
