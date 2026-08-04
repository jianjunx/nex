import { useEffect, useRef, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useUiStore, type SettingsSection } from "../../stores/ui.store";
import { AppearanceSection } from "./sections/AppearanceSection";
import { EditorSection } from "./sections/EditorSection";
import { TerminalSection } from "./sections/TerminalSection";
import { AgentsSection } from "./sections/AgentsSection";
import { KeybindingsEditor } from "./KeybindingsEditor";
import { LayoutSection } from "./sections/LayoutSection";
import { AboutSection } from "./sections/AboutSection";
import { isRecordingActive } from "./recordingState";

type TabId = SettingsSection;
const TABS: { id: TabId; label: string }[] = [
  { id: "appearance", label: "外观" },
  { id: "editor", label: "编辑器" },
  { id: "terminal", label: "终端" },
  { id: "agents", label: "智能体" },
  { id: "keybindings", label: "快捷键" },
  { id: "layout", label: "布局" },
  { id: "about", label: "关于" },
];

export function SettingsDialog() {
  const open = useUiStore((s) => s.settingsOpen);
  const close = useUiStore((s) => s.closeSettings);
  const [tab, setTab] = useState<TabId>("appearance");
  const settingsSection = useUiStore((s) => s.settingsSection);
  const prevOpen = useRef(open);

  // 打开时两条路径：1) 带 settingsSection 的一次性定向（如"管理智能体…"）——
  // 落到目标页签并立即清空标志；2) 普通打开（open 由 false→true 且无定向）——
  // 重置回默认页签。组件在 App.tsx 无条件常驻挂载，useState 不随关窗重建，
  // 不重置则上次定向的页签会跨开合残留（与冒烟项 6 承诺矛盾，R2）。
  // prevOpen 用来区分"普通打开"与"定向后清空 settingsSection 引发的 effect
  // 再触发"——后者 wasOpen=true，走空分支，避免把刚定向的页签盖回外观。
  useEffect(() => {
    const wasOpen = prevOpen.current;
    prevOpen.current = open;
    if (!open) return;
    if (settingsSection) {
      setTab(settingsSection);
      useUiStore.getState().setSettingsSection(null);
    } else if (!wasOpen) {
      setTab("appearance");
    }
  }, [open, settingsSection]);

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) close(); }}>
      <DialogContent
        className="sm:max-w-3xl h-[70vh] flex flex-col p-0 gap-0 overflow-hidden"
        onEscapeKeyDown={(e) => {
          // 录制快捷键期间挂起 Esc 关窗——这一记 Esc 属于录制器（取消录制）
          if (isRecordingActive()) e.preventDefault();
        }}
      >
        <DialogHeader className="px-6 pt-5 pb-3 border-b border-[color:var(--border-subtle)]">
          <DialogTitle>设置</DialogTitle>
          <DialogDescription className="sr-only">应用设置</DialogDescription>
        </DialogHeader>
        <div className="flex flex-1 min-h-0">
          <nav className="w-40 shrink-0 border-r border-[color:var(--border-subtle)] p-2 space-y-0.5 overflow-y-auto">
            {TABS.map((t) => (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={`w-full text-left px-3 py-1.5 rounded-[var(--radius-sm)] text-sm transition-colors ${
                  tab === t.id
                    ? "bg-[var(--accent)]/15 text-[var(--accent)]"
                    : "text-[var(--text-secondary)] hover:bg-[var(--overlay-hover)]"
                }`}
              >
                {t.label}
              </button>
            ))}
          </nav>
          <div className="flex-1 min-w-0 overflow-y-auto p-6">
            {tab === "appearance" && <AppearanceSection />}
            {tab === "editor" && <EditorSection />}
            {tab === "terminal" && <TerminalSection />}
            {tab === "agents" && <AgentsSection />}
            {tab === "keybindings" && <KeybindingsEditor />}
            {tab === "layout" && <LayoutSection />}
            {tab === "about" && <AboutSection />}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
