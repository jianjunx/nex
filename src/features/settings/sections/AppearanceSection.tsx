import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { useSettingsStore, type Theme } from "../../../stores/settings.store";
import { SECTION_HEADER } from "./_shared";

export function AppearanceSection() {
  const { theme, setTheme } = useSettingsStore();

  return (
    // 主题经 CSS 变量生效；系统玻璃染色的自动同步尚未实现。
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
        <p className="text-xs text-[var(--text-tertiary)]">深色主题</p>
      </div>
    </section>
  );
}
