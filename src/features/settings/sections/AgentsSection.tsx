import { useEffect, useState } from "react";
import { RefreshCw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useAgentStore } from "../../../stores/agent.store";
import { SECTION_HEADER } from "./_shared";

// Backend errors arrive as { type, message }; fall back to String(err).
function errorMessage(err: unknown): string {
  if (err && typeof err === "object" && "message" in err && typeof (err as { message: unknown }).message === "string") {
    return (err as { message: string }).message;
  }
  return String(err);
}

export function AgentsSection() {
  const { servers, serversLoading, serversLoadedAt, loadAllServers, refreshRegistry, upsertCustom, deleteCustom } = useAgentStore();

  const [showForm, setShowForm] = useState(false);
  const [customName, setCustomName] = useState("");
  const [customCommand, setCustomCommand] = useState("");
  const [customEnv, setCustomEnv] = useState("");
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 页签激活才挂载本组件。60 秒内尝试过全量加载（无论成败）则跳过；
  // 白名单加载（loadServers）不打点，不构成跳过理由；手动刷新走 refreshRegistry。
  useEffect(() => {
    if (serversLoading) return;
    if (servers.length > 0 && Date.now() - serversLoadedAt < 60_000) return;
    void loadAllServers();
  }, [servers.length, serversLoading, serversLoadedAt, loadAllServers]);

  const handleAddCustom = async () => {
    const name = customName.trim();
    const command = customCommand.trim();
    if (!name || !command) {
      setError("自定义智能体需要填写名称和命令。");
      return;
    }
    // Parse "KEY=VALUE" lines into an env map; blank/malformed lines ignored.
    const env: Record<string, string> = {};
    for (const line of customEnv.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const eq = trimmed.indexOf("=");
      if (eq > 0) env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
    }
    setAdding(true);
    setError(null);
    try {
      const id = crypto.randomUUID();
      await upsertCustom({ id, name, command, env });
      setShowForm(false);
      setCustomName("");
      setCustomCommand("");
      setCustomEnv("");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setAdding(false);
    }
  };

  return (
    // 复用 agent store；无独立后端。
    <section>
      <div className={`flex items-center justify-between ${SECTION_HEADER}`}>
        <Label className="text-xs font-medium uppercase tracking-wide">智能体</Label>
        <Button
          variant="ghost"
          size="sm"
          title="刷新智能体注册表"
          onClick={() => void refreshRegistry().then(() => loadAllServers())}
          disabled={serversLoading}
        >
          <RefreshCw size={12} className={serversLoading ? "animate-spin" : ""} />
        </Button>
      </div>
      <div className="space-y-2">
        {servers.map((s) => (
          <div
            key={s.id}
            className="flex items-center gap-2 px-3 py-2 rounded-[var(--radius-md)] bg-[var(--glass-2-surface)] border border-[color:var(--color-border)]"
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="font-medium text-sm">{s.name}</span>
                {s.version && s.kind !== "native" && (
                  <span className="text-xs text-[var(--text-tertiary)]">v{s.version}</span>
                )}
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--overlay-ghost)] text-[var(--text-tertiary)]">
                  {s.kind === "custom" ? "自定义" : s.kind === "native" ? "内置" : "注册表"}
                </span>
              </div>
              {s.description && (
                <div className="mt-0.5 text-xs text-[var(--text-tertiary)] truncate">{s.description}</div>
              )}
            </div>
            {s.kind === "custom" && (
              <button
                onClick={() => void deleteCustom(s.id)}
                title="移除自定义智能体"
                className="p-1 rounded text-[var(--text-tertiary)] hover:text-[var(--error)] hover:bg-[var(--overlay-hover)]"
              >
                <X size={13} />
              </button>
            )}
          </div>
        ))}

        {showForm ? (
          <div className="space-y-2 p-3 rounded-[var(--radius-md)] bg-[var(--glass-2-surface)] border border-[color:var(--border-default)]">
            <Input
              value={customName}
              onChange={(e) => setCustomName(e.target.value)}
              placeholder="名称"
              disabled={adding}
            />
            <Input
              value={customCommand}
              onChange={(e) => setCustomCommand(e.target.value)}
              placeholder="命令（如 npx -y my-agent --acp）"
              disabled={adding}
            />
            <Textarea
              value={customEnv}
              onChange={(e) => setCustomEnv(e.target.value)}
              placeholder={"环境变量，每行 KEY=VALUE（可选）\nANTHROPIC_API_KEY=sk-…"}
              disabled={adding}
              rows={2}
              className="resize-none font-normal placeholder:text-[var(--text-tertiary)]"
            />
            <div className="flex gap-2">
              <Button size="sm" disabled={adding} onClick={handleAddCustom}>保存</Button>
              <Button size="sm" variant="ghost" disabled={adding} onClick={() => setShowForm(false)}>取消</Button>
            </div>
          </div>
        ) : (
          <Button variant="ghost" size="sm" onClick={() => { setShowForm(true); setError(null); }}>
            + 添加自定义
          </Button>
        )}

        {error && <p className="text-xs text-[var(--error)]">{error}</p>}
      </div>
    </section>
  );
}
