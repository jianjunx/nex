import { useCallback, useEffect, useState } from "react";
import { Activity, ChevronDown, ChevronRight, FolderOpen, Loader2, Plus, RefreshCw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
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
  nativeAgentOpenLogsDir,
  nativeAgentProbeMcp,
  nativeAgentProbeReasoning,
  nativeAgentSetConfig,
  nativeAgentSetMcpEnabled,
  nativeAgentSetProjectMcpEnabled,
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
import { useProjectStore } from "../../../stores/project.store";
import { SECTION_HEADER } from "./_shared";
import { DEFAULT_MCP_JSON, parseMcpServersJson } from "./mcpJson";

type SubTab = "providers" | "mcp" | "skills" | "advanced";
type ScopeTab = "system" | "project";

function mcpStatusKey(source: NativeMcpServerInfo["source"], name: string): string {
  return `${source}:${name}`;
}

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
    apiMode: "auto",
    models: [],
  };
}

const SUB_TABS: { id: SubTab; label: string }[] = [
  { id: "providers", label: "模型供应商" },
  { id: "mcp", label: "MCP" },
  { id: "skills", label: "技能" },
  { id: "advanced", label: "高级" },
];

const SCOPE_TABS: { id: ScopeTab; label: string }[] = [
  { id: "system", label: "系统级" },
  { id: "project", label: "项目级" },
];

function scopeTabClass(active: boolean): string {
  return `flex-1 rounded-[var(--radius-sm)] px-2 py-1 text-xs transition-colors ${
    active
      ? "bg-[var(--accent)]/15 text-[var(--accent)]"
      : "text-[var(--text-secondary)] hover:bg-[var(--overlay-hover)]"
  }`;
}

function ScopeTabBar({
  value,
  onChange,
  systemCount,
  projectCount,
}: {
  value: ScopeTab;
  onChange: (next: ScopeTab) => void;
  systemCount: number;
  projectCount: number;
}) {
  return (
    <div className="flex gap-1 rounded-[var(--radius-md)] border border-[color:var(--border-subtle)] p-0.5">
      {SCOPE_TABS.map((t) => (
        <button
          key={t.id}
          type="button"
          onClick={() => onChange(t.id)}
          className={scopeTabClass(value === t.id)}
        >
          {t.label}
          <span className="ml-1 tabular-nums text-[10px] opacity-70">
            {t.id === "system" ? systemCount : projectCount}
          </span>
        </button>
      ))}
    </div>
  );
}

/**
 * Settings panel for the built-in in-process Nex native agent.
 */
export function NexAgentSection() {
  const activeProjectPath = useProjectStore((state) => {
    const project = state.projects.find((p) => p.id === state.activeProjectId);
    return project?.path ?? null;
  });
  const [config, setConfig] = useState<NativeAgentConfig | null>(null);
  const [savedConfig, setSavedConfig] = useState<NativeAgentConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<SubTab>("providers");
  const [scope, setScope] = useState<ScopeTab>("system");
  const [editor, setEditor] = useState<{ mode: "add" | "edit"; provider: NativeAgentProvider } | null>(null);

  const [mcpList, setMcpList] = useState<NativeMcpServerInfo[]>([]);
  const [mcpStatus, setMcpStatus] = useState<Record<string, string>>({});
  const [mcpEditorOpen, setMcpEditorOpen] = useState(false);
  const [skills, setSkills] = useState<NativeSkillInfo[]>([]);

  const probeMcp = useCallback(async (name: string, source: NativeMcpServerInfo["source"]) => {
    const key = mcpStatusKey(source, name);
    setMcpStatus((s) => ({ ...s, [key]: "探测中…" }));
    try {
      const r = await nativeAgentProbeMcp(name, source, activeProjectPath);
      setMcpStatus((s) => ({ ...s, [key]: r }));
    } catch (err) {
      setMcpStatus((s) => ({ ...s, [key]: `error:${errorMessage(err)}` }));
    }
  }, [activeProjectPath]);

  const probeEnabledMcps = useCallback(
    (servers: NativeMcpServerInfo[]) => {
      for (const server of servers) {
        if (server.enabled) void probeMcp(server.name, server.source);
      }
    },
    [probeMcp],
  );

  const reloadExtras = useCallback(async () => {
    try {
      const [m, s] = await Promise.all([
        nativeAgentListMcp(activeProjectPath),
        nativeAgentListSkills(activeProjectPath),
      ]);
      setMcpList(m);
      setSkills(s);
      return m;
    } catch (err) {
      setError(errorMessage(err));
      return [] as NativeMcpServerInfo[];
    }
  }, [activeProjectPath]);

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
    void reloadExtras().then((m) => {
      if (!cancelled) probeEnabledMcps(m);
    });
    return () => {
      cancelled = true;
    };
  }, [probeEnabledMcps, reloadExtras]);

  const persistConfig = async (configToSave: NativeAgentConfig, options?: { syncDraft?: boolean }) => {
    setSaving(true);
    setError(null);
    try {
      await nativeAgentSetConfig(configToSave);
      setSavedConfig(configToSave);
      if (options?.syncDraft) setConfig(configToSave);
      await useAgentStore.getState().refreshNativeAutoReview();
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
          projectPath={activeProjectPath}
          scope={scope}
          onScopeChange={setScope}
          onRefresh={() => {
            void reloadExtras().then((m) => probeEnabledMcps(m));
          }}
          onProbe={(source, name) => void probeMcp(name, source)}
          onToggle={async (source, name, enabled) => {
            if (source === "project") {
              if (!activeProjectPath) throw new Error("请先打开项目，再批准项目 MCP 服务器");
              await nativeAgentSetProjectMcpEnabled(activeProjectPath, name, enabled);
            } else {
              await nativeAgentSetMcpEnabled(name, enabled);
            }
            await reloadExtras();
            if (enabled) void probeMcp(name, source);
            else {
              setMcpStatus((s) => {
                const next = { ...s };
                delete next[mcpStatusKey(source, name)];
                return next;
              });
            }
          }}
          onDelete={async (source, name) => {
            if (source !== "global") return;
            await nativeAgentDeleteMcp(name);
            setMcpStatus((s) => {
              const next = { ...s };
              delete next[mcpStatusKey(source, name)];
              return next;
            });
            await reloadExtras();
          }}
          onAdd={() => setMcpEditorOpen(true)}
        />
      )}

      {tab === "skills" && (
        <SkillsPane
          list={skills}
          projectPath={activeProjectPath}
          scope={scope}
          onScopeChange={setScope}
          onRefresh={() => void reloadExtras()}
          onToggle={async (name, enabled) => {
            await nativeAgentSetSkillEnabled(name, enabled);
            await reloadExtras();
          }}
          onDelete={async (name) => {
            await nativeAgentDeleteSkill(name);
            await reloadExtras();
          }}
          onOpenDir={async (cwd) => {
            await nativeAgentOpenSkillsDir(cwd);
            await reloadExtras();
          }}
        />
      )}

      {tab === "advanced" && (
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-3 rounded-[var(--radius-md)] border border-[color:var(--border-subtle)] px-3 py-2.5">
            <div className="min-w-0 space-y-0.5">
              <Label className="text-sm">诊断日志</Label>
              <p className="text-xs text-[var(--text-tertiary)]">
                卡住、忽然停下或报错时，打开 ~/.nex/logs/nex.log 查看执行时间线（模型流、工具、授权等待、停止原因）。
              </p>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="nex-pressable shrink-0"
              onClick={() => {
                void nativeAgentOpenLogsDir();
              }}
            >
              <FolderOpen className="size-3.5" />
              打开日志目录
            </Button>
          </div>
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
            <Label htmlFor="nex-shell-sandbox" className="text-sm">Shell 沙箱</Label>
            <select
              id="nex-shell-sandbox"
              className="h-9 w-full rounded-[var(--radius-md)] border border-[color:var(--border-subtle)] bg-[var(--surface-input)] px-3 text-sm text-[var(--text-primary)]"
              disabled={saving}
              value={config.agent.shellSandbox ?? "approvalOnly"}
              onChange={(event) => {
                const shellSandbox = event.target.value as NonNullable<
                  NativeAgentConfig["agent"]["shellSandbox"]
                >;
                void updateAdvancedConfig((cfg) => ({
                  ...cfg,
                  agent: { ...cfg.agent, shellSandbox },
                }));
              }}
            >
              <option value="approvalOnly">仅审批（兼容模式）</option>
              <option value="workspaceWrite">仅工作区可写</option>
              <option value="workspaceWriteNoNetwork">仅工作区可写 + 禁止网络</option>
            </select>
            <p className="text-xs text-[var(--text-tertiary)]">
              macOS 使用系统 sandbox；Linux 需要 bwrap。严格模式不可用时会拒绝执行，不会静默降级。
            </p>
          </div>
          <HooksEditor
            hooks={config.agent.hooks ?? []}
            disabled={saving}
            onSave={async (hooks) => {
              await updateAdvancedConfig((cfg) => ({
                ...cfg,
                agent: { ...cfg.agent, hooks },
              }));
            }}
          />
          <div className="space-y-1">
            <Label htmlFor="nex-max-steps" className="text-sm">最大步数</Label>
            <Input
              id="nex-max-steps"
              type="number"
              min={1}
              disabled={saving}
              value={config.agent.maxSteps}
              onChange={(e) => {
                const value = Math.max(1, Number(e.target.value) || 1);
                void updateAdvancedConfig((cfg) => ({
                  ...cfg,
                  agent: { ...cfg.agent, maxSteps: value },
                }));
              }}
            />
            <p className="text-xs text-[var(--text-tertiary)]">
              单轮「模型 ↔ 工具」循环上限。默认 64；至少为 1，用于阻止无限工具循环。
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
              未设置模型级窗口时使用。默认 200000。0 表示关闭压缩（不限制）。优先使用模型级窗口。
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

      {mcpEditorOpen && (
        <McpEditorDialog
          onClose={() => setMcpEditorOpen(false)}
          onSave={async (text) => {
            const servers = parseMcpServersJson(text);
            await Promise.all(
              servers.map((s) =>
                nativeAgentUpsertMcp({
                  name: s.name,
                  command: s.command,
                  args: s.args,
                  env: s.env,
                  url: s.url,
                  headers: s.headers,
                }),
              ),
            );
            setMcpEditorOpen(false);
            const listed = await reloadExtras();
            probeEnabledMcps(listed);
          }}
        />
      )}
    </section>
  );
}

type NativeHook = NonNullable<NativeAgentConfig["agent"]["hooks"]>[number];

function HooksEditor({
  hooks,
  disabled,
  onSave,
}: {
  hooks: NativeHook[];
  disabled: boolean;
  onSave: (hooks: NativeHook[]) => Promise<void>;
}) {
  const serialized = JSON.stringify(hooks, null, 2);
  const [draft, setDraft] = useState(serialized);
  const [lastSerialized, setLastSerialized] = useState(serialized);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (serialized !== lastSerialized && !saving) {
      setLastSerialized(serialized);
      setDraft(serialized);
    }
  }, [lastSerialized, saving, serialized]);

  const save = async () => {
    setError(null);
    let parsed: unknown;
    try {
      parsed = JSON.parse(draft);
    } catch (err) {
      setError(`JSON 格式错误：${errorMessage(err)}`);
      return;
    }
    if (
      !Array.isArray(parsed) ||
      parsed.some(
        (hook) =>
          !hook ||
          typeof hook !== "object" ||
          !["before_turn", "after_turn"].includes(String((hook as NativeHook).event)) ||
          typeof (hook as NativeHook).command !== "string" ||
          !(hook as NativeHook).command.trim(),
      )
    ) {
      setError("每个钩子都必须包含 event（before_turn/after_turn）和非空 command。");
      return;
    }
    setSaving(true);
    try {
      await onSave(parsed as NativeHook[]);
      const next = JSON.stringify(parsed, null, 2);
      setDraft(next);
      setLastSerialized(next);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <div>
          <Label htmlFor="nex-lifecycle-hooks" className="text-sm">生命周期钩子</Label>
          <p className="text-xs text-[var(--text-tertiary)]">
            全局用户配置；通过 stdin 接收本轮 JSON。before_turn 可设置 failClosed 阻止执行。
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={disabled || saving || draft === lastSerialized}
          onClick={() => void save()}
        >
          {saving ? "保存中…" : "应用"}
        </Button>
      </div>
      <Textarea
        id="nex-lifecycle-hooks"
        className="min-h-32 font-mono text-xs"
        spellCheck={false}
        disabled={disabled || saving}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        placeholder={'[{"event":"before_turn","command":"policy-check","failClosed":true}]'}
      />
      {error && <p className="text-xs text-[var(--error)]">{error}</p>}
    </div>
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
  const hasCredential = Boolean(
    p.apiKey.trim() || p.apiKeyEnv?.trim() || p.apiKeyCredential?.trim(),
  );

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
      const listed = await nativeAgentListModels(
        baseUrl,
        apiKey,
        p.apiKeyEnv,
        p.apiKeyCredential,
      );
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
      const probed = await nativeAgentProbeReasoning(
        baseUrl,
        apiKey,
        modelId,
        p.apiKeyEnv,
        p.apiKeyCredential,
      );
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
              onChange={(e) =>
                setP({
                  ...p,
                  apiKey: e.target.value,
                  apiKeyEnv: null,
                  apiKeyCredential: e.target.value ? null : p.apiKeyCredential,
                })
              }
              placeholder={
                p.apiKeyEnv
                  ? `由 ${p.apiKeyEnv} 提供`
                  : p.apiKeyCredential
                    ? "已安全保存在系统凭据库"
                    : "sk-…"
              }
            />
            <p className="text-[10px] text-[var(--text-tertiary)]">
              直接填写会优先迁移到系统凭据库；也可用下方环境变量引用，避免配置文件保存明文密钥。
            </p>
          </div>
          <div className="space-y-1">
            <Label className="text-sm">API Key 环境变量</Label>
            <Input
              autoComplete="off"
              value={p.apiKeyEnv ?? ""}
              onChange={(e) =>
                setP({
                  ...p,
                  apiKeyEnv: e.target.value || null,
                  apiKey: e.target.value.trim() ? "" : p.apiKey,
                  apiKeyCredential: e.target.value.trim() ? null : p.apiKeyCredential,
                })
              }
              placeholder="如 OPENAI_API_KEY"
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
          <div className="space-y-1">
            <Label className="text-sm">API 协议</Label>
            <select
              className="h-9 w-full rounded-[var(--radius-md)] border border-[color:var(--border-subtle)] bg-[var(--surface-input)] px-3 text-sm text-[var(--text-primary)]"
              value={p.apiMode ?? "auto"}
              onChange={(event) =>
                setP({
                  ...p,
                  apiMode: event.target.value as NonNullable<NativeAgentProvider["apiMode"]>,
                })
              }
            >
              <option value="auto">自动（OpenAI 使用 Responses）</option>
              <option value="responses">Responses API</option>
              <option value="chatCompletions">Chat Completions</option>
            </select>
            <p className="text-[10px] text-[var(--text-tertiary)]">
              Responses 会保留 typed output items 与加密推理上下文；兼容网关可固定使用 Chat Completions。
            </p>
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
                            disabled={probingId === m.id || !p.baseUrl.trim() || !hasCredential}
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
                disabled={fetching || !p.baseUrl.trim() || !hasCredential}
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

function mcpStatusLabel(raw: string): string {
  if (raw.startsWith("error:")) return raw.slice(6);
  return raw;
}

function McpPane({
  list,
  status,
  projectPath,
  scope,
  onScopeChange,
  onRefresh,
  onProbe,
  onToggle,
  onDelete,
  onAdd,
}: {
  list: NativeMcpServerInfo[];
  status: Record<string, string>;
  projectPath: string | null;
  scope: ScopeTab;
  onScopeChange: (next: ScopeTab) => void;
  onRefresh: () => void;
  onProbe: (source: NativeMcpServerInfo["source"], name: string) => void;
  onToggle: (source: NativeMcpServerInfo["source"], name: string, enabled: boolean) => Promise<void>;
  onDelete: (source: NativeMcpServerInfo["source"], name: string) => Promise<void>;
  onAdd: () => void;
}) {
  const systemList = list.filter((s) => s.source !== "project");
  const projectList = list.filter((s) => s.source === "project");
  const visible = scope === "system" ? systemList : projectList;
  const projectScope = scope === "project";

  return (
    <div className="space-y-3">
      <ScopeTabBar
        value={scope}
        onChange={onScopeChange}
        systemCount={systemList.length}
        projectCount={projectList.length}
      />
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-[var(--text-tertiary)]">
          {projectScope ? "项目 .nex/mcp.json" : "全局 ~/.nex/mcp.json"}
        </p>
        <Button size="sm" variant="ghost" onClick={onRefresh}>
          <RefreshCw size={12} /> 刷新
        </Button>
      </div>
      {projectScope && !projectPath && (
        <p className="text-sm text-[var(--text-tertiary)]">请先打开项目，以查看项目级 MCP</p>
      )}
      {projectScope && projectPath && visible.length === 0 && (
        <p className="text-sm text-[var(--text-tertiary)]">
          当前项目尚未配置 MCP 服务器。在仓库的 .nex/mcp.json 中添加后，可在此批准并探测。
        </p>
      )}
      {!projectScope && visible.length === 0 && (
        <p className="text-sm text-[var(--text-tertiary)]">尚未配置 MCP 服务器</p>
      )}
      {visible.map((s) => {
        const projectServer = s.source === "project";
        const envKeys = Object.keys(s.env).sort();
        const headerKeys = Object.keys(s.headers).sort();
        const st = status[mcpStatusKey(s.source, s.name)] ?? "";
        const probing = st === "探测中…";
        const ok = st.startsWith("connected");
        const bad = st.startsWith("error");
        const label = !s.enabled
          ? projectServer
            ? "未批准（项目配置不会连接或执行）"
            : "已禁用"
          : mcpStatusLabel(st) || "未知";
        return (
          <div
            key={mcpStatusKey(s.source, s.name)}
            className="flex items-center justify-between gap-2 rounded-[var(--radius-md)] border border-[color:var(--border-subtle)] px-3 py-2"
          >
            <div className="min-w-0">
              <div className="truncate text-sm font-medium">{s.name}</div>
              <div className="truncate text-xs text-[var(--text-tertiary)]">
                {s.command ?? s.url ?? "—"}
                {s.args?.length ? ` ${s.args.join(" ")}` : ""}
              </div>
              {(envKeys.length > 0 || headerKeys.length > 0) && (
                <div className="truncate text-[10px] text-[var(--text-tertiary)]">
                  {envKeys.length > 0 ? `环境变量：${envKeys.join(", ")}` : ""}
                  {envKeys.length > 0 && headerKeys.length > 0 ? "；" : ""}
                  {headerKeys.length > 0 ? `请求头：${headerKeys.join(", ")}` : ""}
                  （值已隐藏）
                </div>
              )}
              <div
                className={`mt-0.5 truncate text-[10px] ${
                  !s.enabled
                    ? "text-[var(--text-tertiary)]"
                    : ok
                      ? "text-[var(--success)]"
                      : bad
                        ? "text-[var(--error)]"
                        : "text-[var(--text-tertiary)]"
                }`}
              >
                {label}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <Switch
                size="sm"
                checked={s.enabled}
                onCheckedChange={(v) => void onToggle(s.source, s.name, v)}
                aria-label={`${projectServer ? "批准" : "启用"} ${s.name}`}
              />
              <Button
                size="icon-xs"
                variant="ghost"
                title="探测"
                aria-label={`探测 ${s.name}`}
                disabled={!s.enabled || probing}
                onClick={() => onProbe(s.source, s.name)}
              >
                {probing ? <Loader2 size={13} className="animate-spin" /> : <Activity size={13} />}
              </Button>
              {!projectServer && (
                <Button
                  size="icon-xs"
                  variant="ghost"
                  className="text-[var(--error)]"
                  title="删除"
                  aria-label={`删除 ${s.name}`}
                  onClick={() => void onDelete(s.source, s.name)}
                >
                  <Trash2 size={13} />
                </Button>
              )}
            </div>
          </div>
        );
      })}
      {!projectScope && (
        <Button size="sm" variant="outline" onClick={onAdd}>
          <Plus size={14} /> 添加 MCP
        </Button>
      )}
    </div>
  );
}

function McpEditorDialog({
  onClose,
  onSave,
}: {
  onClose: () => void;
  onSave: (text: string) => Promise<void>;
}) {
  const [text, setText] = useState(DEFAULT_MCP_JSON);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>添加 MCP 服务器</DialogTitle>
          <DialogDescription>
            直接编辑 JSON（Claude 兼容的 mcpServers），写入 ~/.nex/mcp.json。
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Textarea
            aria-label="MCP JSON"
            value={text}
            onChange={(e) => setText(e.target.value)}
            spellCheck={false}
            className="min-h-48 font-mono text-xs"
          />
          {err && <p className="text-xs text-[var(--error)]">{err}</p>}
        </div>
        <DialogFooter>
          <Button size="sm" variant="outline" onClick={onClose}>取消</Button>
          <Button
            size="sm"
            disabled={busy || !text.trim()}
            onClick={() => {
              setBusy(true);
              setErr(null);
              void onSave(text)
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

function skillSourceLabel(source: NativeSkillInfo["source"]): string {
  if (source === "builtin") return "内置";
  if (source === "project") return "项目";
  return "用户";
}

function SkillsPane({
  list,
  projectPath,
  scope,
  onScopeChange,
  onRefresh,
  onToggle,
  onDelete,
  onOpenDir,
}: {
  list: NativeSkillInfo[];
  projectPath: string | null;
  scope: ScopeTab;
  onScopeChange: (next: ScopeTab) => void;
  onRefresh: () => void;
  onToggle: (name: string, enabled: boolean) => Promise<void>;
  onDelete: (name: string) => Promise<void>;
  onOpenDir: (cwd?: string | null) => Promise<void>;
}) {
  const systemList = list.filter((sk) => sk.source !== "project");
  const projectList = list.filter((sk) => sk.source === "project");
  const visible = scope === "system" ? systemList : projectList;
  const projectScope = scope === "project";

  return (
    <div className="space-y-3">
      <ScopeTabBar
        value={scope}
        onChange={onScopeChange}
        systemCount={systemList.length}
        projectCount={projectList.length}
      />
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-[var(--text-tertiary)]">
          {projectScope ? "项目 .nex/skills（同名覆盖系统级）" : "全局 ~/.nex/skills"}
        </p>
        <div className="flex flex-wrap justify-end gap-1">
          <Button size="sm" variant="ghost" onClick={onRefresh}>
            <RefreshCw size={12} /> 刷新
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={projectScope && !projectPath}
            title={
              projectScope
                ? projectPath
                  ? "打开项目 .nex/skills"
                  : "请先打开项目"
                : "打开全局 ~/.nex/skills"
            }
            onClick={() => {
              if (projectScope) {
                if (projectPath) void onOpenDir(projectPath);
                return;
              }
              void onOpenDir();
            }}
          >
            <FolderOpen size={12} /> 打开目录
          </Button>
        </div>
      </div>
      {projectScope && !projectPath && (
        <p className="text-sm text-[var(--text-tertiary)]">请先打开项目，以查看项目级技能</p>
      )}
      {projectScope && projectPath && visible.length === 0 && (
        <p className="text-sm text-[var(--text-tertiary)]">
          当前项目暂无技能（可打开目录添加 SKILL.md）
        </p>
      )}
      {!projectScope && visible.length === 0 && (
        <p className="text-sm text-[var(--text-tertiary)]">暂无技能（可打开目录添加 SKILL.md）</p>
      )}
      {visible.map((sk) => (
        <div
          key={`${sk.source}:${sk.name}`}
          className="flex items-start justify-between gap-2 rounded-[var(--radius-md)] border border-[color:var(--border-subtle)] px-3 py-2"
        >
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="truncate text-sm font-medium">{sk.name}</span>
              {!projectScope && (
                <span className="shrink-0 text-[10px] text-[var(--text-tertiary)]">
                  {skillSourceLabel(sk.source)}
                </span>
              )}
            </div>
            {sk.description && (
              <p className="mt-0.5 line-clamp-2 text-xs text-[var(--text-tertiary)]">{sk.description}</p>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Switch
              size="sm"
              checked={sk.enabled}
              onCheckedChange={(v) => void onToggle(sk.name, v)}
              aria-label={`启用 ${sk.name}`}
            />
            {sk.source === "user" && (
              <Button
                size="icon-xs"
                variant="ghost"
                className="text-[var(--error)]"
                title="删除"
                aria-label={`删除 ${sk.name}`}
                onClick={() => void onDelete(sk.name)}
              >
                <Trash2 size={13} />
              </Button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
