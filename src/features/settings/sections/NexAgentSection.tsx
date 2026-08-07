import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  nativeAgentGetConfig,
  nativeAgentListModels,
  nativeAgentSetConfig,
  type NativeAgentConfig,
  type NativeAgentModel,
  type NativeAgentProvider,
} from "../../../bridge/tauri";
import { SECTION_HEADER } from "./_shared";

// Backend errors arrive as { type, message }; fall back to String(err).
function errorMessage(err: unknown): string {
  if (err && typeof err === "object" && "message" in err && typeof (err as { message: unknown }).message === "string") {
    return (err as { message: string }).message;
  }
  return String(err);
}

/** Heuristic pre-marking: ids that look like reasoning models accept the
 *  `reasoning_effort` parameter; everything else stays unknown until the
 *  backend verifies it at runtime. */
const REASONING_HINT = /reason|r1|thinking/i;

function heuristicSupport(id: string): NativeAgentModel["reasoningSupport"] {
  return REASONING_HINT.test(id) ? "yes" : "unknown";
}

function freshProvider(): NativeAgentProvider {
  return {
    id: crypto.randomUUID(),
    name: "新供应商",
    baseUrl: "https://api.deepseek.com/v1",
    apiKey: "",
    models: [],
  };
}

/**
 * Settings panel for the built-in in-process Nex native agent. Manages a list
 * of OpenAI-compatible providers, each with its own model list (manually added
 * or fetched from `{baseUrl}/models`). Reasoning intensity is selected per
 * session in the Composer, not here.
 */
export function NexAgentSection() {
  const [config, setConfig] = useState<NativeAgentConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [fetching, setFetching] = useState<string | null>(null);
  const [fetchErrors, setFetchErrors] = useState<Record<string, string>>({});
  const [modelDrafts, setModelDrafts] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    void nativeAgentGetConfig()
      .then((cfg) => { if (!cancelled) setConfig(cfg); })
      .catch((err) => { if (!cancelled) setError(errorMessage(err)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const setProviders = (updater: (ps: NativeAgentProvider[]) => NativeAgentProvider[]) => {
    setConfig((cfg) => (cfg ? { ...cfg, providers: updater(cfg.providers) } : cfg));
  };

  const patchProvider = (pid: string, patch: Partial<NativeAgentProvider>) => {
    setProviders((ps) => ps.map((p) => (p.id === pid ? { ...p, ...patch } : p)));
  };

  const addProvider = () => setProviders((ps) => [...ps, freshProvider()]);

  const removeProvider = (pid: string) => setProviders((ps) => ps.filter((p) => p.id !== pid));

  const addModel = (pid: string, raw: string) => {
    const id = raw.trim();
    if (!id) return;
    setProviders((ps) =>
      ps.map((p) => {
        if (p.id !== pid || p.models.some((m) => m.id === id)) return p;
        return { ...p, models: [...p.models, { id, reasoningSupport: heuristicSupport(id) }] };
      }),
    );
    setModelDrafts((prev) => ({ ...prev, [pid]: "" }));
  };

  const removeModel = (pid: string, mid: string) => {
    setProviders((ps) =>
      ps.map((p) => (p.id !== pid ? p : { ...p, models: p.models.filter((m) => m.id !== mid) })),
    );
  };

  const fetchModels = async (p: NativeAgentProvider) => {
    setFetching(p.id);
    setFetchErrors((prev) => ({ ...prev, [p.id]: "" }));
    try {
      const ids = await nativeAgentListModels(p.baseUrl, p.apiKey);
      setProviders((ps) =>
        ps.map((prov) => {
          if (prov.id !== p.id) return prov;
          const seen = new Set(prov.models.map((m) => m.id));
          const added: NativeAgentModel[] = ids
            .filter((id) => !seen.has(id))
            .map((id) => ({ id, reasoningSupport: heuristicSupport(id) }));
          return { ...prov, models: [...prov.models, ...added] };
        }),
      );
    } catch (err) {
      setFetchErrors((prev) => ({ ...prev, [p.id]: errorMessage(err) }));
    } finally {
      setFetching(null);
    }
  };

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

  return (
    <section className="space-y-5">
      <div className={SECTION_HEADER}>
        <Label className="text-xs font-medium uppercase tracking-wide">Nex 智能体（内置原生 agent）</Label>
      </div>

      <div className="space-y-4">
        <div className="space-y-3">
          {config.providers.map((p) => (
            <div
              key={p.id}
              className="space-y-3 rounded-[var(--radius-md)] border border-[color:var(--border-subtle)] p-3"
            >
              <div className="flex items-center gap-2">
                <Input
                  aria-label="供应商名称"
                  placeholder="供应商名称，如 DeepSeek"
                  value={p.name}
                  onChange={(e) => patchProvider(p.id, { name: e.target.value })}
                  className="flex-1"
                />
                <Button size="sm" variant="ghost" onClick={() => removeProvider(p.id)}>
                  删除
                </Button>
              </div>

              <div className="space-y-1">
                <Label htmlFor={`nex-api-key-${p.id}`} className="text-sm">API Key</Label>
                <Input
                  id={`nex-api-key-${p.id}`}
                  type="password"
                  autoComplete="off"
                  placeholder="sk-…"
                  value={p.apiKey}
                  onChange={(e) => patchProvider(p.id, { apiKey: e.target.value })}
                />
              </div>

              <div className="space-y-1">
                <Label htmlFor={`nex-base-url-${p.id}`} className="text-sm">Base URL</Label>
                <Input
                  id={`nex-base-url-${p.id}`}
                  placeholder="https://api.openai.com/v1"
                  value={p.baseUrl}
                  onChange={(e) => patchProvider(p.id, { baseUrl: e.target.value })}
                />
                <p className="text-xs text-[var(--text-tertiary)]">
                  OpenAI 兼容端点（可写主机或带 /v1）。未带版本时会自动补 /v1；请求走{" "}
                  {`${p.baseUrl.replace(/\/+$/, "").replace(/\/v\d+$/, "")}/v1/chat/completions`}。
                </p>
              </div>

              <div className="space-y-1">
                <Label className="text-sm">模型</Label>
                <div className="flex flex-wrap items-center gap-1.5">
                  {p.models.map((m) => (
                    <span
                      key={m.id}
                      className="inline-flex items-center gap-1.5 rounded-full border border-[color:var(--border-subtle)] px-2 py-0.5 text-xs"
                    >
                      {m.id}
                      {m.reasoningSupport === "yes" && (
                        <span className="text-[var(--text-tertiary)]">支持推理</span>
                      )}
                      {m.reasoningSupport === "no" && (
                        <span className="text-[var(--text-tertiary)]">不支持推理</span>
                      )}
                      <button
                        type="button"
                        aria-label={`删除模型 ${m.id}`}
                        className="text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
                        onClick={() => removeModel(p.id, m.id)}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                  {p.models.length === 0 && (
                    <span className="text-xs text-[var(--text-tertiary)]">暂无模型，可手动添加或点击「获取模型」</span>
                  )}
                </div>
                <div className="flex gap-2">
                  <Input
                    aria-label="手动添加模型"
                    placeholder="手动添加模型 id，如 deepseek-chat"
                    value={modelDrafts[p.id] ?? ""}
                    onChange={(e) => setModelDrafts((prev) => ({ ...prev, [p.id]: e.target.value }))}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") addModel(p.id, modelDrafts[p.id] ?? "");
                    }}
                    className="flex-1"
                  />
                  <Button size="sm" variant="outline" onClick={() => addModel(p.id, modelDrafts[p.id] ?? "")}>
                    添加
                  </Button>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={fetching === p.id || !p.baseUrl.trim() || !p.apiKey}
                    onClick={() => void fetchModels(p)}
                  >
                    {fetching === p.id ? "获取中…" : "获取模型"}
                  </Button>
                  {fetchErrors[p.id] && (
                    <span className="text-xs text-[var(--error)]">{fetchErrors[p.id]}</span>
                  )}
                </div>
              </div>
            </div>
          ))}
          <Button size="sm" variant="outline" onClick={addProvider}>
            添加供应商
          </Button>
        </div>

        <div className="space-y-1">
          <Label htmlFor="nex-context-window" className="text-sm">上下文窗口（token）</Label>
          <Input
            id="nex-context-window"
            type="number"
            min={0}
            value={config.agent.contextWindow}
            onChange={(e) =>
              setConfig({
                ...config,
                agent: { ...config.agent, contextWindow: Math.max(0, Number(e.target.value) || 0) },
              })
            }
          />
          <p className="text-xs text-[var(--text-tertiary)]">
            0 表示关闭上下文压缩。API Key 明文保存在应用数据目录的 nex-agent.json 中；推理强度在 Composer 中按会话选择。
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
