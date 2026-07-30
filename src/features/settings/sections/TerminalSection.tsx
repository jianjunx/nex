import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { useSettingsStore } from "../../../stores/settings.store";
import { SECTION_HEADER } from "./_shared";

export function TerminalSection() {
  const {
    terminalShell,
    terminalFontSize,
    terminalFontFamily,
    terminalScrollback,
    setTerminalShell,
    setTerminalFontSize,
    setTerminalFontFamily,
    setTerminalScrollback,
  } = useSettingsStore();

  return (
    // ② Terminal — values persist now; xterm wiring follows in task 8.
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
  );
}
