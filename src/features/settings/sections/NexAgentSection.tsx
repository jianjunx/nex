import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  nativeAgentGetConfig,
  nativeAgentSetConfig,
  type NativeAgentConfig,
} from "../../../bridge/tauri";
import { SECTION_HEADER } from "./_shared";

// Backend errors arrive as { type, message }; fall back to String(err).
function errorMessage(err: unknown): string {
  if (err && typeof err === "object" && "message" in err && typeof (err as { message: unknown }).message === "string") {
    return (err as { message: string }).message;
  }
  return String(err);
}

const REASONING_OPTIONS = [
  { value: "off", label: "关闭" },
  { value: "low", label: "低" },
  { value: "medium", label: "中" },
  { value: "high", label: "高" },
];

/**
 * Settings panel for the built-in in-process Nex native agent. Reads/writes
 * `nex-agent.json` through the native_agent_get_config/set_config commands.
 * Phase 0 exposes provider wiring (API key / model / base URL / reasoning)
 * plus the context-window knob; later phases add more loop tuning fields.
 */
export function NexAgentSection() {
  const [config, setConfig] = useState<NativeAgentConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void nativeAgentGetConfig()
      .then((cfg) => { if (!cancelled) setConfig(cfg); })
      .catch((err) => { if (!cancelled) setError(errorMessage(err)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const handleSave = async () => {
    if (!config) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await nativeAgentSetConfig(config);
      setSaved(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <p className="text-sm text-[var(--text-tertiary)]">正在加载配置…</p>;
  }
  if (!config) {
    return <p className="text-sm text-[var(--error)]">{error ?? "配置加载失败"}</p>;
  }

  const setProvider = (patch: Partial<NativeAgentConfig["provider"]>) =>
    setConfig({ ...config, provider: { ...config.provider, ...patch } });
  const setAgent = (patch: Partial<NativeAgentConfig["agent"]>) =>
    setConfig({ ...config, agent: { ...config.agent, ...patch } });

  return (
    <section className="space-y-5">
      <div className={SECTION_HEADER}>
        <Label className="text-xs font-medium uppercase tracking-wide">Nex 智能体（内置原生 agent）</Label>
      </div>

      <div className="space-y-3">
        <div className="space-y-1">
          <Label htmlFor="nex-api-key" className="text-sm">API Key</Label>
          <Input
            id="nex-api-key"
            type="password"
            autoComplete="off"
            placeholder="sk-…"
            value={config.provider.apiKey}
            onChange={(e) => setProvider({ apiKey: e.target.value })}
          />
          <p className="text-xs text-[var(--text-tertiary)]">
            明文保存在应用数据目录的 nex-agent.json 中。
          </p>
        </div>

        <div className="space-y-1">
          <Label htmlFor="nex-model" className="text-sm">模型</Label>
          <Input
            id="nex-model"
            placeholder="deepseek-chat"
            value={config.provider.model}
            onChange={(e) => setProvider({ model: e.target.value })}
          />
        </div>

        <div className="space-y-1">
          <Label htmlFor="nex-base-url" className="text-sm">Base URL</Label>
          <Input
            id="nex-base-url"
            placeholder="https://api.deepseek.com"
            value={config.provider.baseUrl}
            onChange={(e) => setProvider({ baseUrl: e.target.value })}
          />
          <p className="text-xs text-[var(--text-tertiary)]">
            OpenAI 兼容端点，无需带 /chat/completions。
          </p>
        </div>

        <div className="space-y-1">
          <Label htmlFor="nex-reasoning" className="text-sm">推理强度</Label>
          <select
            id="nex-reasoning"
            className="w-full rounded-[var(--radius-sm)] border border-[color:var(--border-subtle)] bg-transparent px-2 py-1.5 text-sm"
            value={config.provider.reasoning}
            onChange={(e) => setProvider({ reasoning: e.target.value })}
          >
            {REASONING_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>

        <div className="space-y-1">
          <Label htmlFor="nex-context-window" className="text-sm">上下文窗口（token）</Label>
          <Input
            id="nex-context-window"
            type="number"
            min={0}
            value={config.agent.contextWindow}
            onChange={(e) => setAgent({ contextWindow: Math.max(0, Number(e.target.value) || 0) })}
          />
          <p className="text-xs text-[var(--text-tertiary)]">
            0 表示关闭上下文压缩（阶段 2 生效）。
          </p>
        </div>
      </div>

      {error && <p className="text-xs text-[var(--error)]">{error}</p>}

      <div className="flex items-center gap-2">
        <Button size="sm" disabled={saving} onClick={() => void handleSave()}>
          {saving ? "保存中…" : "保存"}
        </Button>
        {saved && <span className="text-xs text-[var(--text-tertiary)]">已保存</span>}
      </div>
    </section>
  );
}
