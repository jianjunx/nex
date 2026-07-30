// src/features/settings/KeybindingsEditor.tsx
import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Pencil, RotateCcw } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { listCommands } from "../../commands/registry";
import { useKeybindingsStore, type ConflictRef } from "../../stores/keybindings.store";
import {
  comboToCanonical,
  comboToLabel,
  detectPlatform,
  eventToLogicalCombo,
  isModifierOnly,
  type KeyCombo,
  type Platform,
} from "../../commands/types";
import { setRecordingActive } from "./recordingState";

export function KeybindingsEditor() {
  const platform = detectPlatform();
  const resolve = useKeybindingsStore((s) => s.resolve);
  const overrides = useKeybindingsStore((s) => s.overrides);
  const setOverride = useKeybindingsStore((s) => s.setOverride);
  const reset = useKeybindingsStore((s) => s.reset);
  const conflictsFor = useKeybindingsStore((s) => s.conflictsFor);

  const [query, setQuery] = useState("");
  const [recordingId, setRecordingId] = useState<string | null>(null);
  const [pendingConflict, setPendingConflict] = useState<ConflictRef | null>(null);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return listCommands()
      .filter((c) => !q || c.title.toLowerCase().includes(q) || c.category.toLowerCase().includes(q) || c.id.toLowerCase().includes(q))
      .map((c) => ({ cmd: c, eff: resolve(c.id), isUser: c.id in overrides }));
  }, [query, resolve, overrides]);

  return (
    <div className="space-y-3">
      <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索命令…" />
      <div className="overflow-hidden rounded-[var(--radius-md)] border border-[color:var(--color-border)]">
        <div className="grid grid-cols-[1fr_auto_auto] gap-2 px-3 py-2 text-xs uppercase tracking-wide text-[var(--text-tertiary)] bg-[var(--overlay-ghost)]">
          <span>命令</span><span className="text-right">键位</span><span className="w-16" />
        </div>
        <div className="divide-y divide-[color:var(--border-subtle)] max-h-[50vh] overflow-y-auto">
          {rows.map(({ cmd, eff, isUser }) => {
            const canonical = comboToCanonical(eff);
            const conflict = conflictsFor(canonical, cmd.id)[0];
            const recording = recordingId === cmd.id;
            return (
              <div key={cmd.id} className="grid grid-cols-[1fr_auto_auto] items-center gap-2 px-3 py-2 text-sm hover:bg-[var(--overlay-hover)]">
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5 truncate">
                    <span className="truncate">{cmd.title}</span>
                    {conflict && (
                      <span title={`与「${conflict.commandTitle}」冲突`} className="inline-flex">
                        <AlertTriangle size={13} className="text-[var(--warning)]" />
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-[var(--text-tertiary)] truncate">{cmd.category} · {cmd.id}</div>
                </div>
                <div className="text-right">
                  {recording ? (
                    <KeyRecorder
                      platform={platform}
                      onRecord={(combo) => {
                        const { conflict: c } = setOverride(cmd.id, combo);
                        setRecordingId(null);
                        if (c) setPendingConflict(c);
                      }}
                      onCancel={() => setRecordingId(null)}
                    />
                  ) : (
                    <kbd className="font-mono text-xs px-1.5 py-0.5 rounded bg-[var(--overlay-ghost)] border border-[color:var(--color-border)]">
                      {comboToLabel(eff, platform)}
                    </kbd>
                  )}
                </div>
                <div className="flex w-16 justify-end gap-1">
                  <Button size="sm" variant="ghost" title="改键" onClick={() => { setRecordingId(cmd.id); setPendingConflict(null); }}>
                    <Pencil size={12} />
                  </Button>
                  {isUser && (
                    <Button size="sm" variant="ghost" title="重置为默认" onClick={() => reset(cmd.id)}>
                      <RotateCcw size={12} />
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
      {pendingConflict && (
        <p className="text-xs text-[var(--warning)]">
          该键位与「{pendingConflict.commandTitle}」冲突，有自定义覆盖的命令优先响应。
        </p>
      )}
    </div>
  );
}

/** Records a single combo on the next non-modifier keydown; Esc or blur cancels. */
function KeyRecorder({
  platform,
  onRecord,
  onCancel,
}: {
  platform: Platform;
  onRecord: (c: KeyCombo) => void;
  onCancel: () => void;
}) {
  // 「请按键…」常驻；hint 非空时作为子元素追加（拒绝提示不抹掉主提示，录制继续）。
  const [hint, setHint] = useState<string | null>(null);
  // autoFocus is a no-op on <span> (React only auto-focuses button/input/
  // select/textarea on mount), so focus imperatively after mount.
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    setRecordingActive(true);
    ref.current?.focus();
    return () => setRecordingActive(false);
  }, []);
  // Capture locally so the global host (which yields to dialogs) won't steal it.
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); onCancel(); return; }
    if (isModifierOnly(e)) return;
    e.preventDefault();
    // M-3: 与全局分发器共用同一归一化——录制结果即分发器能匹配的组合
    // （mac 上 Ctrl≠primary，仅 Cmd 是；录 ⌃K 不再被误存成 ⌘K）。
    const combo = eventToLogicalCombo(e, platform);
    if (!combo || combo.key === null) return;
    // C-1: 裸可打印字符（字母/数字/单字符标点）不允许无修饰绑定，避免全局吞键
    const isTypingKey =
      combo.key.length === 1 || /^key[a-z]$/.test(combo.key) || /^digit[0-9]$/.test(combo.key);
    if (isTypingKey && !combo.primary && !combo.alt) {
      setHint("快捷键需包含 Ctrl/⌘ 或 Alt，避免吞掉普通输入");
      return;
    }
    onRecord(combo);
  };
  return (
    // tabIndex + mount-time focus so it receives key events without a real
    // input element; blur cancels so a click elsewhere can't leave a
    // silent "recording" that swallows nothing (M-4).
    <span
      ref={ref}
      tabIndex={0}
      onKeyDown={onKey}
      onBlur={() => onCancel()}
      className="inline-block rounded-sm text-xs text-[var(--accent)] animate-pulse outline-none focus:ring-1 focus:ring-[var(--accent)]"
    >
      请按键…{hint && <span className="ml-2 text-[var(--warning)]">{hint}</span>}
    </span>
  );
}
