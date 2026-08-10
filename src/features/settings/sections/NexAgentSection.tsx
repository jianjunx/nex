import { useCallback, useEffect, useState } from "react";
import { ChevronDown, ChevronRight, FolderOpen, Plus, RefreshCw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  nativeAgentDeleteMcp,
  nativeAgentDeleteSkill,
  nativeAgentGetConfig,
  nativeAgentListMcp,
  nativeAgentListModels,
  nativeAgentListSkills,
  nativeAgentOpenSkillsDir,
  nativeAgentProbeMcp,
  nativeAgentProbeReasoning,
  nativeAgentSetConfig,
  nativeAgentSetMcpEnabled,
  nativeAgentSetSkillEnabled,
  nativeAgentUpsertMcp,
  type NativeAgentConfig,
  type NativeAgentModel,
  type NativeAgentProvider,
  type NativeMcpServerInfo,
  type NativeSkillInfo,
  type ReasoningSource,
} from "../../../bridge/tauri";
import { useAgentStore } from "../../../stores/agent.store";
import { SECTION_HEADER } from "./_shared";

type SubTab = "providers" | "mcp" | "skills" | "advanced";

function errorMessage(err: unknown): string {
  if (err && typeof err === "object" && "message" in err && typeof (err as { message: unknown }).message === "string") {
    return (err as { message: string }).message;
  }
  return String(err);
}

/** Frontend mirror of backend `capabilities::detect` for newly typed model ids. */
const VISION_HINT =
  /vision|\bvl\b|gpt-4o|gpt-4\.1|gpt-5|claude-|gemini|pixtral|minimax-m/i;

function heuristicContextWindow(id: string): number | undefined {
  const lower = id.toLowerCase();
  const suffix = lower.match(/-(\d+)([km])$/);
  if (suffix) {
    const n = Number(suffix[1]);
    return suffix[2] === "m" ? n * 1_000_000 : n * 1_000;
  }
  if (/deepseek-v4/.test(lower)) return 1_000_000;
  if (/kimi-k3/.test(lower)) return 1_000_000;
  if (/kimi/.test(lower)) return 262_144;
  if (/minimax/.test(lower)) return /m3|m2\.5/.test(lower) ? 645_000 : 327_680;
  if (/gemini/.test(lower)) return 1_048_576;
  if (/claude/.test(lower)) return 200_000;
  if (/gpt-4\.1|gpt-4\.5/.test(lower)) return 1_047_576;
  if (/gpt-4o|gpt-4-turbo|gpt-5/.test(lower)) return 128_000;
  if (/o1|o3|o4/.test(lower)) return 200_000;
  if (/deepseek|qwen|qwq/.test(lower)) return 128_000;
  return undefined;
}

/** Family-specific ladders — keep in sync with `capabilities::reasoning_levels_for`. */
function reasoningLevelsFor(id: string): string[] {
  const lower = id.toLowerCase();
  if (/deepseek-v4/.test(lower)) {
    return /flash/.test(lower) ? ["off", "low", "high", "max"] : ["off", "high", "max"];
  }
  if (/deepseek-reasoner|deepseek-r1|deepseek-chat|deepseek-v3\.[12]|deepseek-v3-[12]/.test(lower)) {
    return ["off", "low", "high", "max"];
  }
  if (/minimax/.test(lower) && /m3/.test(lower)) return ["off", "high"];
  if (/minimax/.test(lower) && /m[12]/.test(lower)) return ["off", "low", "medium", "high"];
  if (/gpt-5|gpt5/.test(lower)) {
    if (/pro/.test(lower) && !/5\.[23]/.test(lower)) return ["high"];
    if (/codex/.test(lower)) {
      if (/5\.1/.test(lower) && /max/.test(lower)) return ["medium", "high", "xhigh"];
      if (/5\.[23]/.test(lower)) return ["low", "medium", "high", "xhigh"];
      return ["low", "medium", "high"];
    }
    if (/5\.1/.test(lower)) return ["off", "low", "medium", "high"];
    return ["off", "minimal", "low", "medium", "high", "xhigh"];
  }
  if (/o3|o4/.test(lower)) return ["off", "minimal", "low", "medium", "high", "xhigh"];
  if (/o1/.test(lower)) return ["low", "medium", "high"];
  if (/claude/.test(lower)) {
    if (/4\.6|4-6/.test(lower)) return ["off", "low", "medium", "high", "xhigh"];
    if (/claude-4|opus-4|sonnet-4|3\.7|3-7|thinking/.test(lower)) {
      return ["off", "low", "medium", "high"];
    }
    return [];
  }
  if (/gemini-(3|2\.5)/.test(lower)) return ["off", "low", "medium", "high"];
  if (/kimi-k3|kimi\/k3/.test(lower)) return ["off", "low", "high", "max"];
  if (/kimi-k2|kimi\/k2|kimi-k2\.5/.test(lower)) return ["off", "high"];
  if (/grok-3-mini|grok-4/.test(lower) && !/non-reasoning/.test(lower)) return ["off", "low", "high"];
  if (/qwq|qwen3/.test(lower)) return ["off", "low", "medium", "high"];
  if (/reason|thinking|r1|hunyuan-t1|glm-zero/.test(lower)) return ["off", "low", "medium", "high"];
  return [];
}

const ALL_EFFORTS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

function detectModel(id: string): NativeAgentModel {
  const reasoningLevels = reasoningLevelsFor(id);
  const reasoning = reasoningLevels.length > 0;
  const vision = VISION_HINT.test(id);
  return {
    id,
    reasoningSupport: reasoning ? "yes" : "unknown",
    capabilities: { tools: true, vision, reasoning },
    reasoningLevels,
    contextWindow: heuristicContextWindow(id) ?? null,
    reasoningManual: false,
    reasoningSource: reasoning ? "heuristic" : "none",
  };
}

function sourceLabel(source?: ReasoningSource, manual?: boolean): string {
  if (manual || source === "manual") return "手动";
  if (source === "api") return "API";
  if (source === "probe") return "探测";
  if (source === "heuristic") return "启发式";
  return "—";
}

/** Format tokens as `128K` / `1M` for the settings table. */
function formatContextWindow(tokens: number | null | undefined): string {
  if (tokens == null || tokens <= 0) return "—";
  if (tokens >= 1_000_000) {
    const m = tokens / 1_000_000;
    return `${Number.isInteger(m) ? m : m.toFixed(1)}M`;
  }
  if (tokens >= 1_000) {
    const k = tokens / 1_000;
    return `${Number.isInteger(k) ? k : Math.round(k)}K`;
  }
  return String(tokens);
}

function parseContextWindowInput(raw: string): number | null {
  const t = raw.trim().toLowerCase();
  if (!t) return null;
  const m = t.match(/^(\d+(?:\.\d+)?)\s*([km])?$/);
  if (!m) {
    const n = Number(t);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
  }
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (m[2] === "m") return Math.floor(n * 1_000_000);
  if (m[2] === "k") return Math.floor(n * 1_000);
  return Math.floor(n);
}

function FeatureTag({ label }: { label: string }) {
  return (
    <span className="rounded border border-[color:var(--border-subtle)] px-1.5 py-0.5 text-[10px] text-[var(--text-secondary)]">
      {label}
    </span>
  );
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

function configsEqual(a: NativeAgentConfig, b: NativeAgentConfig): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

const SUB_TABS: { id: SubTab; label: string }[] = [
  { id: "providers", label: "模型供应商" },
  { id: "mcp", label: "MCP" },
  { id: "skills", label: "技能" },
  { id: "advanced", label: "高级" },
];

/**
 * Settings panel for the built-in in-process Nex native agent.
 */
export function NexAgentSection() {
  const [config, setConfig] = useState<NativeAgentConfig | null>(null);
  const [savedConfig, setSavedConfig] = useState<NativeAgentConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [tab, setTab] = useState<SubTab>("providers");
  const [editor, setEditor] = useState<{ mode: "add" | "edit"; provider: NativeAgentProvider } | null>(null);

  const [mcpList, setMcpList] = useState<NativeMcpServerInfo[]>([]);
  const [mcpStatus, setMcpStatus] = useState<Record<string, string>>({});
  const [mcpEditor, setMcpEditor] = useState<null | { name: string; command: string; args: string }>(null);
  const [skills, setSkills] = useState<NativeSkillInfo[]>([]);

  const reloadExtras = useCallback(async () => {
    try {
      const [m, s] = await Promise.all([nativeAgentListMcp(), nativeAgentListSkills()]);
      setMcpList(m);
      setSkills(s);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void nativeAgentGetConfig()
      .then((cfg) => {
        if (!cancelled) {
          setConfig(cfg);
          setSavedConfig(cfg);
        }
      })
      .catch((err) => {
        if (!cancelled) setError(errorMessage(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    void reloadExtras();
    return () => {
      cancelled = true;
    };
  }, [reloadExtras]);

  const persistConfig = async (configToSave: NativeAgentConfig, options?: { syncDraft?: boolean }) => {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await nativeAgentSetConfig(configToSave);
      setSavedConfig(configToSave);
      if (options?.syncDraft) setConfig(configToSave);
      await useAgentStore.getState().refreshNativeAutoReview();
      setSaved(true);
    } catch (err) {
      setError(errorMessage(err));
      throw err;
    } finally {
      setSaving(false);
    }
  };

  const updateAdvancedConfig = async (updater: (cfg: NativeAgentConfig) => NativeAgentConfig) => {
    if (!config || !savedConfig) return;
    const currentConfig = config;
    const nextSavedConfig = updater(savedConfig);
    const nextDraftConfig = updater(currentConfig);
    setConfig(nextDraftConfig);
    try {
      await persistConfig(nextSavedConfig);
      setConfig(nextDraftConfig);
      setSaved(configsEqual(nextDraftConfig, nextSavedConfig));
    } catch {
      setConfig(currentConfig);
    }
  };

  const saveProvider = async (provider: NativeAgentProvider, isNew: boolean) => {
    if (!config || !savedConfig) return;
    const nextProviders = isNew
      ? [...savedConfig.providers, provider]
      : savedConfig.providers.map((p) => (p.id === provider.id ? provider : p));
    const nextSavedConfig: NativeAgentConfig = {
      ...savedConfig,
      providers: nextProviders,
    };
    const nextDraftConfig: NativeAgentConfig = {
      ...config,
      providers: isNew
        ? [...config.providers, provider]
        : config.providers.map((p) => (p.id === provider.id ? provider : p)),
    };
    await persistConfig(nextSavedConfig);
    setConfig(nextDraftConfig);
    setSaved(configsEqual(nextDraftConfig, nextSavedConfig));
    setEditor(null);
  };

  const removeProvider = async (pid: string) => {
    if (!config || !savedConfig) return;
    const nextSavedConfig: NativeAgentConfig = {
      ...savedConfig,
      providers: savedConfig.providers.filter((p) => p.id !== pid),
      defaultModel: savedConfig.defaultModel?.startsWith(`${pid}/`) ? null : savedConfig.defaultModel,
    };
    const nextDraftConfig: NativeAgentConfig = {
      ...config,
      providers: config.providers.filter((p) => p.id !== pid),
      defaultModel: config.defaultModel?.startsWith(`${pid}/`) ? null : config.defaultModel,
    };
    await persistConfig(nextSavedConfig);
    setConfig(nextDraftConfig);
    setSaved(configsEqual(nextDraftConfig, nextSavedConfig));
    setEditor(null);
  };

  if (loading) {
    return <p className="text-sm text-[var(--text-tertiary)]">正在加载配置…</p>;
  }
  if (!config) {
    return <p className="text-sm text-[var(--error)]">{error ?? "配置加载失败"}</p>;
  }

  return (
    <section className="space-y-4">
      <div className={SECTION_HEADER}>
        <Label className="text-xs font-medium uppercase tracking-wide">Nex 智能体</Label>
      </div>

      <div className="flex gap-1 rounded-[var(--radius-md)] border border-[color:var(--border-subtle)] p-0.5">
        {SUB_TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={`flex-1 rounded-[var(--radius-sm)] px-2 py-1.5 text-xs transition-colors ${
              tab === t.id
                ? "bg-[var(--accent)]/15 text-[var(--accent)]"
                : "text-[var(--text-secondary)] hover:bg-[var(--overlay-hover)]"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "providers" && (
        <ProvidersModelTable
          providers={config.providers}
          defaultModel={config.defaultModel}
          onEdit={(p) => setEditor({ mode: "edit", provider: structuredClone(p) })}
          onAdd={() => setEditor({ mode: "add", provider: freshProvider() })}
        />
      )}

      {tab === "mcp" && (
        <McpPane
          list={mcpList}
          status={mcpStatus}
          onRefresh={() => void reloadExtras()}
          onProbe={async (name) => {
            setMcpStatus((s) => ({ ...s, [name]: "探测中…" }));
            try {
              const r = await nativeAgentProbeMcp(name);
              setMcpStatus((s) => ({ ...s, [name]: r }));
            } catch (err) {
              setMcpStatus((s) => ({ ...s, [name]: `error:${errorMessage(err)}` }));
            }
          }}
          onToggle={async (name, enabled) => {
            await nativeAgentSetMcpEnabled(name, enabled);
            await reloadExtras();
          }}
          onDelete={async (name) => {
            await nativeAgentDeleteMcp(name);
            await reloadExtras();
          }}
          onAdd={() => setMcpEditor({ name: "", command: "", args: "" })}
        />
      )}

      {tab === "skills" && (
        <SkillsPane
          list={skills}
          onRefresh={() => void reloadExtras()}
          onToggle={async (name, enabled) => {
            await nativeAgentSetSkillEnabled(name, enabled);
            await reloadExtras();
          }}
          onDelete={async (name) => {
            await nativeAgentDeleteSkill(name);
            await reloadExtras();
          }}
          onOpenDir={async () => {
            await nativeAgentOpenSkillsDir();
            await reloadExtras();
          }}
        />
      )}

      {tab === "advanced" && (
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-3 rounded-[var(--radius-md)] border border-[color:var(--border-subtle)] px-3 py-2.5">
            <div className="min-w-0 space-y-0.5">
              <Label htmlFor="nex-auto-review" className="text-sm">任务后自动 Review</Label>
              <p className="text-xs text-[var(--text-tertiary)]">
                开启后，NexAgent 在有写文件/改代码等变更的回合结束后，自动再发一轮可见的 /review。
              </p>
            </div>
            <Switch
              id="nex-auto-review"
              checked={!!config.agent.autoReview}
              disabled={saving}
              onCheckedChange={(checked) => {
                void updateAdvancedConfig((cfg) => ({
                  ...cfg,
                  agent: { ...cfg.agent, autoReview: checked },
                }));
              }}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="nex-max-steps" className="text-sm">最大步数</Label>
            <Input
              id="nex-max-steps"
              type="number"
              min={0}
              disabled={saving}
              value={config.agent.maxSteps}
              onChange={(e) => {
                const value = Math.max(0, Number(e.target.value) || 0);
                void updateAdvancedConfig((cfg) => ({
                  ...cfg,
                  agent: { ...cfg.agent, maxSteps: value },
                }));
              }}
            />
            <p className="text-xs text-[var(--text-tertiary)]">
              单轮「模型 ↔ 工具」循环上限。0 表示不限制（推荐）。
            </p>
          </div>
          <div className="space-y-1">
            <Label htmlFor="nex-context-window" className="text-sm">全局上下文窗口（token）</Label>
            <Input
              id="nex-context-window"
              type="number"
              min={0}
              disabled={saving}
              value={config.agent.contextWindow}
              onChange={(e) => {
                const value = Math.max(0, Number(e.target.value) || 0);
                void updateAdvancedConfig((cfg) => ({
                  ...cfg,
                  agent: { ...cfg.agent, contextWindow: value },
                }));
              }}
            />
            <p className="text-xs text-[var(--text-tertiary)]">
              仅当所选模型未设置上下文窗口时生效。0 表示不限制、关闭压缩。优先使用模型级窗口。
            </p>
          </div>
          <div className="space-y-1">
            <Label className="text-sm">默认模型</Label>
            <select
              className="h-8 w-full rounded-[var(--radius-sm)] border border-[color:var(--border-subtle)] bg-transparent px-2 text-sm"
              value={config.defaultModel ?? ""}
              disabled={saving}
              onChange={(e) => {
                const value = e.target.value || null;
                void updateAdvancedConfig((cfg) => ({ ...cfg, defaultModel: value }));
              }}
            >
              <option value="">（自动：第一个可用模型）</option>
              {config.providers.flatMap((p) =>
                p.models.map((m) => (
                  <option key={`${p.id}/${m.id}`} value={`${p.id}/${m.id}`}>
                    {p.name} / {m.id}
                  </option>
                )),
              )}
            </select>
          </div>
        </div>
      )}

      {error && <p className="text-xs text-[var(--error)]">{error}</p>}

      {editor && (
        <ProviderEditorDialog
          mode={editor.mode}
          provider={editor.provider}
          saving={saving}
          onClose={() => setEditor(null)}
          onSave={(p) => saveProvider(p, editor.mode === "add")}
          onDelete={editor.mode === "edit" ? () => removeProvider(editor.provider.id) : undefined}
        />
      )}

      {mcpEditor && (
        <McpEditorDialog
          draft={mcpEditor}
          onClose={() => setMcpEditor(null)}
          onSave={async (d) => {
            await nativeAgentUpsertMcp({
              name: d.name.trim(),
              command: d.command.trim() || null,
              args: d.args.trim() ? d.args.trim().split(/\s+/) : [],
              env: {},
            });
            setMcpEditor(null);
            await reloadExtras();
          }}
        />
      )}
    </section>
  );
}

function ProviderEditorDialog({
  mode,
  provider: initial,
  saving,
  onClose,
  onSave,
  onDelete,
}: {
  mode: "add" | "edit";
  provider: NativeAgentProvider;
  saving: boolean;
  onClose: () => void;
  onSave: (p: NativeAgentProvider) => Promise<void>;
  onDelete?: () => Promise<void>;
}) {
  const [p, setP] = useState(initial);
  const [modelDraft, setModelDraft] = useState("");
  const [windowDraft, setWindowDraft] = useState("");
  const [fetching, setFetching] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [probingId, setProbingId] = useState<string | null>(null);
  const [probeError, setProbeError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const patchModel = (modelId: string, patch: Partial<NativeAgentModel>) => {
    setP((prev) => ({
      ...prev,
      models: prev.models.map((m) => (m.id === modelId ? { ...m, ...patch } : m)),
    }));
  };

  const addModel = (raw: string) => {
    const id = raw.trim();
    setP((prev) => {
      if (!id || prev.models.some((m) => m.id === id)) return prev;
      const entry = detectModel(id);
      const manual = parseContextWindowInput(windowDraft);
      if (manual != null) entry.contextWindow = manual;
      return { ...prev, models: [...prev.models, entry] };
    });
    setModelDraft("");
    setWindowDraft("");
  };

  const fetchModels = async () => {
    setFetching(true);
    setFetchError(null);
    const baseUrl = p.baseUrl;
    const apiKey = p.apiKey;
    try {
      const listed = await nativeAgentListModels(baseUrl, apiKey);
      setP((prev) => {
        const byId = new Map(listed.map((m) => [m.id, m]));
        const merged = prev.models.map((m) => {
          const fresh = byId.get(m.id);
          if (!fresh) return m;
          if (m.reasoningManual) {
            return {
              ...m,
              contextWindow: m.contextWindow ?? fresh.contextWindow,
              capabilities: {
                ...m.capabilities,
                vision: m.capabilities.vision || fresh.capabilities.vision,
              },
            };
          }
          if (fresh.reasoningSource === "api") {
            return {
              ...fresh,
              contextWindow: m.contextWindow ?? fresh.contextWindow,
            };
          }
          return m;
        });
        const seen = new Set(prev.models.map((m) => m.id));
        const added = listed.filter((m) => !seen.has(m.id));
        return { ...prev, models: [...merged, ...added] };
      });
    } catch (err) {
      setFetchError(errorMessage(err));
    } finally {
      setFetching(false);
    }
  };

  const redetectAll = () => {
    setP((prev) => ({
      ...prev,
      models: prev.models.map((m) => {
        if (m.reasoningManual) return m;
        const next = detectModel(m.id);
        if (m.contextWindow != null && m.contextWindow > 0) {
          next.contextWindow = m.contextWindow;
        }
        return next;
      }),
    }));
  };

  const updateModelWindow = (modelId: string, raw: string) => {
    const parsed = parseContextWindowInput(raw);
    patchModel(modelId, { contextWindow: parsed });
  };

  const setReasoningEnabled = (modelId: string, enabled: boolean) => {
    setP((prev) => ({
      ...prev,
      models: prev.models.map((m) => {
        if (m.id !== modelId) return m;
        if (enabled) {
          const levels =
            m.reasoningLevels.length > 0 ? m.reasoningLevels : ["off", "low", "medium", "high"];
          return {
            ...m,
            capabilities: { ...m.capabilities, reasoning: true },
            reasoningLevels: levels,
            reasoningSupport: "yes" as const,
            reasoningManual: true,
            reasoningSource: "manual" as const,
          };
        }
        return {
          ...m,
          capabilities: { ...m.capabilities, reasoning: false },
          reasoningLevels: [],
          reasoningSupport: "no" as const,
          reasoningManual: true,
          reasoningSource: "manual" as const,
        };
      }),
    }));
  };

  const toggleEffort = (modelId: string, effort: string) => {
    setP((prev) => ({
      ...prev,
      models: prev.models.map((m) => {
        if (m.id !== modelId) return m;
        const has = m.reasoningLevels.includes(effort);
        const next = ALL_EFFORTS.filter((e) =>
          has ? e !== effort && m.reasoningLevels.includes(e) : e === effort || m.reasoningLevels.includes(e),
        );
        return {
          ...m,
          capabilities: { ...m.capabilities, reasoning: next.length > 0 },
          reasoningLevels: [...next],
          reasoningSupport: next.length > 0 ? ("yes" as const) : ("no" as const),
          reasoningManual: true,
          reasoningSource: "manual" as const,
        };
      }),
    }));
  };

  const probeModel = async (modelId: string) => {
    setProbingId(modelId);
    setProbeError(null);
    const baseUrl = p.baseUrl;
    const apiKey = p.apiKey;
    try {
      const probed = await nativeAgentProbeReasoning(baseUrl, apiKey, modelId);
      setP((prev) => ({
        ...prev,
        models: prev.models.map((m) => {
          if (m.id !== modelId) return m;
          return {
            ...probed,
            contextWindow: m.contextWindow ?? probed.contextWindow,
            reasoningManual: false,
          };
        }),
      }));
      setExpandedId(modelId);
    } catch (err) {
      setProbeError(`${modelId}: ${errorMessage(err)}`);
    } finally {
      setProbingId(null);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o && !saving) onClose();
      }}
    >
      <DialogContent className="sm:max-w-2xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{mode === "add" ? "添加供应商" : "编辑供应商"}</DialogTitle>
          <DialogDescription>
            配置 OpenAI 兼容端点与模型列表。点击模型名可设置思考档位；支持从 API 声明、探测或手动指定。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1">
            <Label className="text-sm">名称</Label>
            <Input
              value={p.name}
              onChange={(e) => setP({ ...p, name: e.target.value })}
              placeholder="如 DeepSeek"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-sm">API Key</Label>
            <Input
              type="password"
              autoComplete="off"
              value={p.apiKey}
              onChange={(e) => setP({ ...p, apiKey: e.target.value })}
              placeholder="sk-…"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-sm">Base URL</Label>
            <Input
              value={p.baseUrl}
              onChange={(e) => setP({ ...p, baseUrl: e.target.value })}
              placeholder="https://api.openai.com/v1"
            />
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <Label className="text-sm">模型</Label>
              <Button type="button" size="sm" variant="ghost" onClick={redetectAll}>
                <RefreshCw size={12} /> 重新检测能力
              </Button>
            </div>
            <div className="overflow-hidden rounded-[var(--radius-md)] border border-[color:var(--border-subtle)]">
              <div className="grid grid-cols-[1fr_5.5rem_7rem_1.5rem] gap-2 border-b border-[color:var(--border-subtle)] bg-[var(--overlay-hover)]/40 px-2 py-1.5 text-[10px] uppercase tracking-wide text-[var(--text-tertiary)]">
                <span>名称</span>
                <span>上下文</span>
                <span>功能</span>
                <span />
              </div>
              {p.models.length === 0 && (
                <p className="px-2 py-3 text-xs text-[var(--text-tertiary)]">暂无模型</p>
              )}
              {p.models.map((m) => {
                const open = expandedId === m.id;
                return (
                  <div
                    key={m.id}
                    className="border-b border-[color:var(--border-subtle)] last:border-b-0"
                  >
                    <div className="grid grid-cols-[1fr_5.5rem_7rem_1.5rem] items-center gap-2 px-2 py-1.5">
                      <button
                        type="button"
                        className="truncate text-left text-xs text-[var(--text-primary)] hover:underline"
                        title={`${m.id} · 点击展开思考设置`}
                        onClick={() => setExpandedId(open ? null : m.id)}
                      >
                        {m.id}
                      </button>
                      <Input
                        className="h-7 px-1.5 text-xs"
                        placeholder="—"
                        defaultValue={
                          m.contextWindow != null && m.contextWindow > 0
                            ? formatContextWindow(m.contextWindow)
                            : ""
                        }
                        onBlur={(e) => updateModelWindow(m.id, e.target.value)}
                        title="可填 128K / 1M / 128000；留空不限制"
                      />
                      <div className="flex flex-wrap gap-1">
                        {m.capabilities.tools && <FeatureTag label="工具" />}
                        {m.capabilities.vision && <FeatureTag label="视觉" />}
                        {m.capabilities.reasoning && <FeatureTag label="推理" />}
                      </div>
                      <button
                        type="button"
                        aria-label={`删除 ${m.id}`}
                        className="text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
                        onClick={() =>
                          setP((prev) => ({
                            ...prev,
                            models: prev.models.filter((x) => x.id !== m.id),
                          }))
                        }
                      >
                        ×
                      </button>
                    </div>
                    {open && (
                      <div className="space-y-2 border-t border-[color:var(--border-subtle)] bg-[var(--overlay-hover)]/20 px-3 py-2">
                        <div className="flex flex-wrap items-center gap-3">
                          <div className="flex items-center gap-2">
                            <Switch
                              checked={m.capabilities.reasoning}
                              onCheckedChange={(v) => setReasoningEnabled(m.id, v)}
                            />
                            <span className="text-xs text-[var(--text-secondary)]">支持思考</span>
                          </div>
                          <span className="text-[10px] text-[var(--text-tertiary)]">
                            来源：{sourceLabel(m.reasoningSource, m.reasoningManual)}
                          </span>
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            className="h-7 text-xs"
                            disabled={probingId === m.id || !p.baseUrl.trim() || !p.apiKey}
                            onClick={() => void probeModel(m.id)}
                          >
                            {probingId === m.id ? "探测中…" : "探测档位"}
                          </Button>
                        </div>
                        {m.capabilities.reasoning && (
                          <div className="flex flex-wrap gap-1.5">
                            {ALL_EFFORTS.map((effort) => {
                              const on = m.reasoningLevels.includes(effort);
                              return (
                                <button
                                  key={effort}
                                  type="button"
                                  className={
                                    on
                                      ? "rounded px-1.5 py-0.5 text-[10px] bg-[var(--accent)]/15 text-[var(--accent)] border border-[color:var(--accent)]/40"
                                      : "rounded px-1.5 py-0.5 text-[10px] text-[var(--text-tertiary)] border border-[color:var(--border-subtle)]"
                                  }
                                  onClick={() => toggleEffort(m.id, effort)}
                                >
                                  {/* 显示档位原值（off/low/…），不翻译成中文 */}
                                  {effort}
                                </button>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            {probeError && <p className="text-xs text-[var(--error)]">{probeError}</p>}
            <div className="flex gap-2">
              <Input
                placeholder="模型 id"
                value={modelDraft}
                onChange={(e) => setModelDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") addModel(modelDraft);
                }}
                className="flex-1"
              />
              <Input
                placeholder="上下文(可选)"
                value={windowDraft}
                onChange={(e) => setWindowDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") addModel(modelDraft);
                }}
                className="w-28"
                title="如 128K、1M；留空则尝试自动检测，检测不到则不限制"
              />
              <Button size="sm" variant="outline" onClick={() => addModel(modelDraft)}>
                添加
              </Button>
            </div>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={fetching || !p.baseUrl.trim() || !p.apiKey}
                onClick={() => void fetchModels()}
              >
                {fetching ? "获取中…" : "获取模型"}
              </Button>
              {fetchError && <span className="text-xs text-[var(--error)]">{fetchError}</span>}
            </div>
          </div>
        </div>

        <DialogFooter className="gap-2 sm:justify-between">
          <div>
            {onDelete && (
              <Button
                size="sm"
                variant="ghost"
                className="text-[var(--error)]"
                disabled={saving}
                onClick={() => {
                  setSaveError(null);
                  void onDelete().catch((err) => setSaveError(errorMessage(err)));
                }}
              >
                <Trash2 size={14} /> 删除供应商
              </Button>
            )}
          </div>
          <div className="flex flex-col items-end gap-2">
            {saveError && <p className="text-xs text-[var(--error)]">{saveError}</p>}
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={onClose} disabled={saving}>取消</Button>
              <Button
                size="sm"
                onClick={() => {
                  setSaveError(null);
                  void onSave(p).catch((err) => setSaveError(errorMessage(err)));
                }}
                disabled={saving || !p.name.trim()}
              >
                {saving ? "保存中…" : mode === "add" ? "添加供应商" : "保存供应商"}
              </Button>
            </div>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ProvidersModelTable({
  providers,
  defaultModel,
  onEdit,
  onAdd,
}: {
  providers: NativeAgentProvider[];
  defaultModel?: string | null;
  onEdit: (p: NativeAgentProvider) => void;
  onAdd: () => void;
}) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  return (
    <div className="space-y-3">
      <div className="overflow-hidden rounded-[var(--radius-md)] border border-[color:var(--border-subtle)]">
        <div className="grid grid-cols-[minmax(0,1fr)_5rem_8rem] gap-2 border-b border-[color:var(--border-subtle)] px-3 py-2 text-xs text-[var(--text-tertiary)]">
          <span>名称</span>
          <span>上下文大小</span>
          <span>功能</span>
        </div>
        {providers.length === 0 && (
          <p className="px-3 py-4 text-sm text-[var(--text-tertiary)]">尚未配置供应商</p>
        )}
        {providers.map((p) => {
          const open = !collapsed[p.id];
          const isDefault = defaultModel?.startsWith(`${p.id}/`);
          return (
            <div key={p.id} className="border-b border-[color:var(--border-subtle)] last:border-b-0">
              <button
                type="button"
                className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-[var(--overlay-hover)]"
                onClick={() => setCollapsed((c) => ({ ...c, [p.id]: open }))}
              >
                {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-[var(--text-primary)]">
                  {p.name || "未命名供应商"}
                  {isDefault ? (
                    <span className="ml-2 text-[10px] font-normal text-[var(--accent)]">默认</span>
                  ) : null}
                </span>
                <span className="shrink-0 text-[10px] text-[var(--text-tertiary)]">
                  {p.models.length} 模型
                </span>
                <span
                  role="link"
                  tabIndex={0}
                  className="shrink-0 text-[10px] text-[var(--accent)] hover:underline"
                  onClick={(e) => {
                    e.stopPropagation();
                    onEdit(p);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.stopPropagation();
                      onEdit(p);
                    }
                  }}
                >
                  编辑
                </span>
              </button>
              {open &&
                p.models.map((m) => (
                  <div
                    key={m.id}
                    className="grid grid-cols-[minmax(0,1fr)_5rem_8rem] items-center gap-2 py-1.5 pl-9 pr-3 text-xs hover:bg-[var(--overlay-hover)]/50"
                  >
                    <span className="truncate text-[var(--text-primary)]" title={m.id}>
                      {m.id}
                    </span>
                    <span className="text-[var(--text-secondary)]">
                      {formatContextWindow(m.contextWindow)}
                    </span>
                    <div className="flex flex-wrap gap-1">
                      {m.capabilities.tools && <FeatureTag label="工具" />}
                      {m.capabilities.vision && <FeatureTag label="视觉" />}
                      {m.capabilities.reasoning && <FeatureTag label="推理" />}
                    </div>
                  </div>
                ))}
              {open && p.models.length === 0 && (
                <p className="px-9 py-2 text-xs text-[var(--text-tertiary)]">暂无模型 — 点编辑添加</p>
              )}
            </div>
          );
        })}
      </div>
      <Button size="sm" variant="outline" onClick={onAdd}>
        <Plus size={14} /> 添加供应商
      </Button>
    </div>
  );
}

function McpPane({
  list,
  status,
  onRefresh,
  onProbe,
  onToggle,
  onDelete,
  onAdd,
}: {
  list: NativeMcpServerInfo[];
  status: Record<string, string>;
  onRefresh: () => void;
  onProbe: (name: string) => void;
  onToggle: (name: string, enabled: boolean) => Promise<void>;
  onDelete: (name: string) => Promise<void>;
  onAdd: () => void;
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs text-[var(--text-tertiary)]">全局 ~/.nex/mcp.json</p>
        <Button size="sm" variant="ghost" onClick={onRefresh}>
          <RefreshCw size={12} /> 刷新
        </Button>
      </div>
      {list.length === 0 && (
        <p className="text-sm text-[var(--text-tertiary)]">尚未配置 MCP 服务器</p>
      )}
      {list.map((s) => {
        const st = status[s.name] ?? "";
        const ok = st.startsWith("connected");
        const bad = st.startsWith("error");
        return (
          <div
            key={s.name}
            className="space-y-1.5 rounded-[var(--radius-md)] border border-[color:var(--border-subtle)] px-3 py-2"
          >
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="truncate text-sm font-medium">{s.name}</div>
                <div className="truncate text-xs text-[var(--text-tertiary)]">
                  {s.command ?? s.url ?? "—"}
                  {s.args?.length ? ` ${s.args.join(" ")}` : ""}
                </div>
              </div>
              <span
                className={`shrink-0 text-[10px] ${
                  !s.enabled
                    ? "text-[var(--text-tertiary)]"
                    : ok
                      ? "text-[var(--accent)]"
                      : bad
                        ? "text-[var(--error)]"
                        : "text-[var(--text-tertiary)]"
                }`}
              >
                {!s.enabled ? "已禁用" : st || "未知"}
              </span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              <Button size="sm" variant="outline" onClick={() => onProbe(s.name)}>探测</Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => void onToggle(s.name, !s.enabled)}
              >
                {s.enabled ? "禁用" : "启用"}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="text-[var(--error)]"
                onClick={() => void onDelete(s.name)}
              >
                删除
              </Button>
            </div>
          </div>
        );
      })}
      <Button size="sm" variant="outline" onClick={onAdd}>
        <Plus size={14} /> 添加 MCP
      </Button>
    </div>
  );
}

function McpEditorDialog({
  draft,
  onClose,
  onSave,
}: {
  draft: { name: string; command: string; args: string };
  onClose: () => void;
  onSave: (d: { name: string; command: string; args: string }) => Promise<void>;
}) {
  const [d, setD] = useState(draft);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>添加 MCP 服务器</DialogTitle>
          <DialogDescription>stdio 命令型服务器（写入 ~/.nex/mcp.json）。</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label className="text-sm">名称</Label>
            <Input value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} placeholder="filesystem" />
          </div>
          <div className="space-y-1">
            <Label className="text-sm">Command</Label>
            <Input value={d.command} onChange={(e) => setD({ ...d, command: e.target.value })} placeholder="npx" />
          </div>
          <div className="space-y-1">
            <Label className="text-sm">Args（空格分隔）</Label>
            <Input
              value={d.args}
              onChange={(e) => setD({ ...d, args: e.target.value })}
              placeholder="-y @modelcontextprotocol/server-filesystem /tmp"
            />
          </div>
          {err && <p className="text-xs text-[var(--error)]">{err}</p>}
        </div>
        <DialogFooter>
          <Button size="sm" variant="outline" onClick={onClose}>取消</Button>
          <Button
            size="sm"
            disabled={busy || !d.name.trim() || !d.command.trim()}
            onClick={() => {
              setBusy(true);
              void onSave(d)
                .catch((e) => setErr(errorMessage(e)))
                .finally(() => setBusy(false));
            }}
          >
            添加
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SkillsPane({
  list,
  onRefresh,
  onToggle,
  onDelete,
  onOpenDir,
}: {
  list: NativeSkillInfo[];
  onRefresh: () => void;
  onToggle: (name: string, enabled: boolean) => Promise<void>;
  onDelete: (name: string) => Promise<void>;
  onOpenDir: () => Promise<void>;
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-[var(--text-tertiary)]">全局 ~/.nex/skills</p>
        <div className="flex gap-1">
          <Button size="sm" variant="ghost" onClick={onRefresh}>
            <RefreshCw size={12} /> 刷新
          </Button>
          <Button size="sm" variant="outline" onClick={() => void onOpenDir()}>
            <FolderOpen size={12} /> 打开目录
          </Button>
        </div>
      </div>
      {list.length === 0 && (
        <p className="text-sm text-[var(--text-tertiary)]">暂无技能（可打开目录添加 SKILL.md）</p>
      )}
      {list.map((sk) => (
        <div
          key={sk.name}
          className="flex items-start justify-between gap-2 rounded-[var(--radius-md)] border border-[color:var(--border-subtle)] px-3 py-2"
        >
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="truncate text-sm font-medium">{sk.name}</span>
              <span className="shrink-0 text-[10px] text-[var(--text-tertiary)]">
                {sk.source === "builtin" ? "内置" : "用户"}
                {!sk.enabled ? " · 已禁用" : ""}
              </span>
            </div>
            {sk.description && (
              <p className="mt-0.5 line-clamp-2 text-xs text-[var(--text-tertiary)]">{sk.description}</p>
            )}
          </div>
          <div className="flex shrink-0 flex-col gap-1">
            <Button size="sm" variant="outline" onClick={() => void onToggle(sk.name, !sk.enabled)}>
              {sk.enabled ? "禁用" : "启用"}
            </Button>
            {sk.source !== "builtin" && (
              <Button
                size="sm"
                variant="ghost"
                className="text-[var(--error)]"
                onClick={() => void onDelete(sk.name)}
              >
                删除
              </Button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
