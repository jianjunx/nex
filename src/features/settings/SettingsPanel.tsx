import { useEffect, useState } from "react";
import { RefreshCw, X } from "lucide-react";
import { Button, Input, Label, RadioGroup, RadioGroupItem, Slider, Switch, Textarea } from "@glinui/ui";
import { useSettingsStore, type Theme } from "../../stores/settings.store";
import { useAgentStore } from "../../stores/agent.store";
import { useUiStore } from "../../stores/ui.store";

// Backend errors arrive as { type, message }; fall back to String(err).
function errorMessage(err: unknown): string {
  if (err && typeof err === "object" && "message" in err && typeof (err as { message: unknown }).message === "string") {
    return (err as { message: string }).message;
  }
  return String(err);
}

const SECTION_HEADER = "text-xs font-medium text-[var(--text-secondary)] uppercase tracking-wide mb-2";

export function SettingsPanel() {
  const {
    theme,
    terminalShell,
    terminalFontSize,
    terminalFontFamily,
    terminalScrollback,
    editorAutoSave,
    setTheme,
    setTerminalShell,
    setTerminalFontSize,
    setTerminalFontFamily,
    setTerminalScrollback,
    setEditorAutoSave,
  } = useSettingsStore();
  const { servers, serversLoading, loadServers, refreshRegistry, upsertCustom, deleteCustom } = useAgentStore();
  const resetLayoutDims = useUiStore((s) => s.resetLayoutDims);

  const [showForm, setShowForm] = useState(false);
  const [customName, setCustomName] = useState("");
  const [customCommand, setCustomCommand] = useState("");
  const [customEnv, setCustomEnv] = useState("");
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The side panel only mounts this tab when it is active; load the merged
  // agent list on mount (idempotent if another surface already loaded it).
  useEffect(() => { void loadServers(); }, [loadServers]);

  const handleAddCustom = async () => {
    const name = customName.trim();
    const command = customCommand.trim();
    if (!name || !command) {
      setError("A name and a command are required for a custom server.");
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
    <div className="h-full overflow-y-auto pb-8 space-y-6">
      {/* ① Appearance — CSS-only this commit; OS glass re-tint lands later. */}
      <section>
        <div className={SECTION_HEADER}>外观</div>
        <div className="space-y-1.5">
          <Label>主题</Label>
          <RadioGroup
            value={theme}
            onValueChange={(v) => setTheme(v as Theme)}
            orientation="horizontal"
            className="flex gap-4"
          >
            <div className="flex items-center gap-2">
              <RadioGroupItem value="light" id="theme-light" />
              <Label htmlFor="theme-light">浅色</Label>
            </div>
            <div className="flex items-center gap-2">
              <RadioGroupItem value="dark" id="theme-dark" />
              <Label htmlFor="theme-dark">深色</Label>
            </div>
          </RadioGroup>
          <p className="text-xs text-[var(--text-tertiary)]">v1 暂不支持跟随系统</p>
        </div>
      </section>

      <section>
        <div className={SECTION_HEADER}>编辑器</div>
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <Label htmlFor="editor-autosave">自动保存</Label>
            <p className="text-xs text-[var(--text-tertiary)]">停止输入约 1.5 秒后写入磁盘</p>
          </div>
          <Switch
            id="editor-autosave"
            checked={editorAutoSave}
            onCheckedChange={setEditorAutoSave}
          />
        </div>
      </section>

      {/* ② Terminal — values persist now; xterm wiring follows in task 8. */}
      <section>
        <div className={SECTION_HEADER}>终端</div>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>Shell</Label>
            <Input value={terminalShell} onChange={(e) => setTerminalShell(e.target.value)} placeholder="系统默认" />
            <p className="text-xs text-[var(--text-tertiary)]">仅对新打开的终端生效</p>
          </div>
          <div className="space-y-1.5">
            <Label>字号</Label>
            <div className="flex items-center gap-3">
              <Slider
                min={10}
                max={24}
                step={1}
                value={[terminalFontSize]}
                onValueChange={(v) => setTerminalFontSize(v[0])}
                className="flex-1"
              />
              <span className="text-xs text-[var(--text-secondary)] w-8 text-right">{terminalFontSize}</span>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>字体</Label>
            <Input
              value={terminalFontFamily}
              onChange={(e) => setTerminalFontFamily(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label>滚动缓冲</Label>
            <div className="flex items-center gap-3">
              <Slider
                min={0}
                max={5000}
                step={250}
                value={[terminalScrollback]}
                onValueChange={(v) => setTerminalScrollback(v[0])}
                className="flex-1"
              />
              <span className="text-xs text-[var(--text-secondary)] w-8 text-right">{terminalScrollback}</span>
            </div>
          </div>
        </div>
      </section>

      {/* ③ Agents — reuses the agent store; no new backend. */}
      <section>
        <div className={`flex items-center justify-between ${SECTION_HEADER}`}>
          <Label className="text-xs font-medium uppercase tracking-wide">智能体</Label>
          <Button
            variant="ghost"
            size="sm"
            title="Refresh agent registry"
            onClick={() => void refreshRegistry()}
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
                  {s.version && <span className="text-xs text-[var(--text-tertiary)]">v{s.version}</span>}
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--overlay-ghost)] text-[var(--text-tertiary)]">
                    {s.kind === "custom" ? "自定义" : "注册表"}
                  </span>
                </div>
                {s.description && (
                  <div className="mt-0.5 text-xs text-[var(--text-tertiary)] truncate">{s.description}</div>
                )}
              </div>
              {s.kind === "custom" && (
                <button
                  onClick={() => void deleteCustom(s.id)}
                  title="Remove custom server"
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
                variant="glass"
                value={customName}
                onChange={(e) => setCustomName(e.target.value)}
                placeholder="名称"
                disabled={adding}
              />
              <Input
                variant="glass"
                value={customCommand}
                onChange={(e) => setCustomCommand(e.target.value)}
                placeholder="命令（如 npx -y my-agent --acp）"
                disabled={adding}
              />
              <Textarea
                variant="glass"
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

      {/* ④ Layout — sizes only; panel visibility is never touched. */}
      <section>
        <div className={SECTION_HEADER}>布局</div>
        <div className="space-y-1.5">
          <Button variant="outline" size="sm" onClick={resetLayoutDims}>恢复默认</Button>
          <p className="text-xs text-[var(--text-tertiary)]">
            侧栏 320px · 终端 200px · 编辑器 480px（仅重置尺寸，不影响显示状态）
          </p>
        </div>
      </section>
    </div>
  );
}
