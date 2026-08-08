import { useCallback, useEffect, useState } from "react";
import { FolderOpen, Plus, RefreshCw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
  nativeAgentSetConfig,
  nativeAgentSetMcpEnabled,
  nativeAgentSetSkillEnabled,
  nativeAgentUpsertMcp,
  type NativeAgentConfig,
  type NativeAgentModel,
  type NativeAgentProvider,
  type NativeMcpServerInfo,
  type NativeSkillInfo,
} from "../../../bridge/tauri";
import { SECTION_HEADER } from "./_shared";

type SubTab = "providers" | "mcp" | "skills" | "advanced";

function errorMessage(err: unknown): string {
  if (err && typeof err === "object" && "message" in err && typeof (err as { message: unknown }).message === "string") {
    return (err as { message: string }).message;
  }
  return String(err);
}

/** Frontend mirror of backend `capabilities::detect` for newly typed model ids. */
const REASONING_HINT = /reason|r1|thinking|o1|o3|o4|gpt-5|claude-4|gemini-2\.5|kimi-k2|qwq|qwen3/i;
const VISION_HINT = /vision|\bvl\b|gpt-4o|gpt-4\.1|gpt-5|claude-|gemini|pixtral/i;

function detectModel(id: string): NativeAgentModel {
  const reasoning = REASONING_HINT.test(id);
  const vision = VISION_HINT.test(id);
  const reasoningLevels = reasoning
    ? /gpt-5|o3|o4/i.test(id)
      ? ["off", "minimal", "low", "medium", "high", "xhigh"]
      : ["off", "low", "medium", "high"]
    : [];
  return {
    id,
    reasoningSupport: reasoning ? "yes" : "unknown",
    capabilities: { tools: true, vision, reasoning },
    reasoningLevels,
  };
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
        if (!cancelled) setConfig(cfg);
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

  const setProviders = (updater: (ps: NativeAgentProvider[]) => NativeAgentProvider[]) => {
    setConfig((cfg) => (cfg ? { ...cfg, providers: updater(cfg.providers) } : cfg));
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

  const saveProvider = (provider: NativeAgentProvider, isNew: boolean) => {
    setProviders((ps) => {
      if (isNew) return [...ps, provider];
      return ps.map((p) => (p.id === provider.id ? provider : p));
    });
    setEditor(null);
  };

  const removeProvider = (pid: string) => {
    setProviders((ps) => ps.filter((p) => p.id !== pid));
    setConfig((cfg) => {
      if (!cfg?.defaultModel?.startsWith(`${pid}/`)) return cfg;
      return { ...cfg, defaultModel: null };
    });
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
        <Label className="text-xs font-medium uppercase tracking-wide">Nex 智能体（内置原生 agent）</Label>
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
        <div className="space-y-3">
          {config.providers.map((p) => {
            const modelSummary =
              p.models.length === 0
                ? "暂无模型"
                : p.models.length <= 3
                  ? p.models.map((m) => m.id).join(" · ")
                  : `${p.models
                      .slice(0, 3)
                      .map((m) => m.id)
                      .join(" · ")} 等 ${p.models.length} 个`;
            const isDefault = config.defaultModel?.startsWith(`${p.id}/`);
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => setEditor({ mode: "edit", provider: structuredClone(p) })}
                className={`w-full rounded-[var(--radius-md)] border px-3 py-2.5 text-left transition-colors hover:bg-[var(--overlay-hover)] ${
                  isDefault
                    ? "border-[var(--accent)]/50 bg-[var(--accent)]/5"
                    : "border-[color:var(--border-subtle)]"
                }`}
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-sm font-medium text-[var(--text-primary)]">{p.name || "未命名供应商"}</span>
                  <span className="shrink-0 text-[10px] text-[var(--text-tertiary)]">
                    {p.models.length} 模型{isDefault ? " · 默认" : ""}
                  </span>
                </div>
                <p className="mt-0.5 truncate text-xs text-[var(--text-tertiary)]">{modelSummary}</p>
              </button>
            );
          })}
          <Button
            size="sm"
            variant="outline"
            onClick={() => setEditor({ mode: "add", provider: freshProvider() })}
          >
            <Plus size={14} /> 添加供应商
          </Button>
        </div>
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
          <div className="space-y-1">
            <Label htmlFor="nex-max-steps" className="text-sm">最大步数</Label>
            <Input
              id="nex-max-steps"
              type="number"
              min={0}
              value={config.agent.maxSteps}
              onChange={(e) =>
                setConfig({
                  ...config,
                  agent: { ...config.agent, maxSteps: Math.max(0, Number(e.target.value) || 0) },
                })
              }
            />
            <p className="text-xs text-[var(--text-tertiary)]">
              单轮「模型 ↔ 工具」循环上限。0 表示不限制（推荐）。
            </p>
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
              0 表示关闭上下文压缩。API Key 明文保存在应用数据目录的 nex-agent.json 中。
            </p>
          </div>
          <div className="space-y-1">
            <Label className="text-sm">默认模型</Label>
            <select
              className="h-8 w-full rounded-[var(--radius-sm)] border border-[color:var(--border-subtle)] bg-transparent px-2 text-sm"
              value={config.defaultModel ?? ""}
              onChange={(e) =>
                setConfig({ ...config, defaultModel: e.target.value || null })
              }
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

      {(tab === "providers" || tab === "advanced") && (
        <div className="flex items-center gap-2">
          <Button size="sm" disabled={saving} onClick={() => void handleSave()}>
            {saving ? "保存中…" : "保存"}
          </Button>
          {saved && <span className="text-xs text-[var(--text-tertiary)]">已保存</span>}
        </div>
      )}

      {editor && (
        <ProviderEditorDialog
          mode={editor.mode}
          provider={editor.provider}
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
  onClose,
  onSave,
  onDelete,
}: {
  mode: "add" | "edit";
  provider: NativeAgentProvider;
  onClose: () => void;
  onSave: (p: NativeAgentProvider) => void;
  onDelete?: () => void;
}) {
  const [p, setP] = useState(initial);
  const [modelDraft, setModelDraft] = useState("");
  const [fetching, setFetching] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);

  const addModel = (raw: string) => {
    const id = raw.trim();
    if (!id || p.models.some((m) => m.id === id)) return;
    setP({ ...p, models: [...p.models, detectModel(id)] });
    setModelDraft("");
  };

  const fetchModels = async () => {
    setFetching(true);
    setFetchError(null);
    try {
      const ids = await nativeAgentListModels(p.baseUrl, p.apiKey);
      const seen = new Set(p.models.map((m) => m.id));
      const added = ids.filter((id) => !seen.has(id)).map(detectModel);
      setP({ ...p, models: [...p.models, ...added] });
    } catch (err) {
      setFetchError(errorMessage(err));
    } finally {
      setFetching(false);
    }
  };

  const redetectAll = () => {
    setP({ ...p, models: p.models.map((m) => detectModel(m.id)) });
  };

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-lg max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{mode === "add" ? "添加供应商" : "编辑供应商"}</DialogTitle>
          <DialogDescription>配置 OpenAI 兼容端点与模型列表。</DialogDescription>
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
            <div className="flex flex-wrap gap-1.5">
              {p.models.map((m) => (
                <span
                  key={m.id}
                  className="inline-flex items-center gap-1 rounded-full border border-[color:var(--border-subtle)] px-2 py-0.5 text-xs"
                >
                  {m.id}
                  {m.capabilities.reasoning && (
                    <span className="text-[var(--text-tertiary)]">推理</span>
                  )}
                  {m.capabilities.vision && (
                    <span className="text-[var(--text-tertiary)]">视觉</span>
                  )}
                  <button
                    type="button"
                    aria-label={`删除 ${m.id}`}
                    className="text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
                    onClick={() => setP({ ...p, models: p.models.filter((x) => x.id !== m.id) })}
                  >
                    ×
                  </button>
                </span>
              ))}
              {p.models.length === 0 && (
                <span className="text-xs text-[var(--text-tertiary)]">暂无模型</span>
              )}
            </div>
            <div className="flex gap-2">
              <Input
                placeholder="手动添加模型 id"
                value={modelDraft}
                onChange={(e) => setModelDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") addModel(modelDraft);
                }}
                className="flex-1"
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
              <Button size="sm" variant="ghost" className="text-[var(--error)]" onClick={onDelete}>
                <Trash2 size={14} /> 删除供应商
              </Button>
            )}
          </div>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={onClose}>取消</Button>
            <Button size="sm" onClick={() => onSave(p)} disabled={!p.name.trim()}>
              {mode === "add" ? "添加" : "确定"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
