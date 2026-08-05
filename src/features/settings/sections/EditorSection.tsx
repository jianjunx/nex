import { useState } from "react";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { useSettingsStore } from "../../../stores/settings.store";
import { SECTION_HEADER } from "./_shared";

export function EditorSection() {
  const { editorAutoSave, setEditorAutoSave, editorWordWrap, setEditorWordWrap, editorWrapColumn, setEditorWrapColumn } = useSettingsStore();
  // 本地草稿：输入过程中不即时 clamp，失焦/回车时才提交并限制范围。
  const [wrapColumnDraft, setWrapColumnDraft] = useState(String(editorWrapColumn));
  const commitWrapColumn = () => {
    const n = Number(wrapColumnDraft);
    if (Number.isFinite(n)) {
      setEditorWrapColumn(n);
      setWrapColumnDraft(String(Math.min(400, Math.max(40, Math.round(n)))));
    } else {
      setWrapColumnDraft(String(editorWrapColumn));
    }
  };

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
      <div className="mt-4 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <Label htmlFor="editor-wordwrap">自动换行</Label>
          <p className="text-xs text-[var(--text-tertiary)]">超过单行最大显示长度时换行显示</p>
        </div>
        <Switch
          id="editor-wordwrap"
          checked={editorWordWrap}
          onCheckedChange={setEditorWordWrap}
        />
      </div>
      <div className="mt-4 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <Label htmlFor="editor-wrap-column">单行最大显示长度</Label>
          <p className="text-xs text-[var(--text-tertiary)]">按字符数限制（40–400），超出部分换行</p>
        </div>
        <Input
          id="editor-wrap-column"
          type="number"
          min={40}
          max={400}
          disabled={!editorWordWrap}
          value={wrapColumnDraft}
          onChange={(e) => setWrapColumnDraft(e.target.value)}
          onBlur={commitWrapColumn}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitWrapColumn();
          }}
          className="h-7 w-24 text-right"
        />
      </div>
    </section>
  );
}
