import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useSettingsStore } from "../../../stores/settings.store";
import { SECTION_HEADER } from "./_shared";

export function EditorSection() {
  const { editorAutoSave, setEditorAutoSave } = useSettingsStore();

  return (
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
  );
}
