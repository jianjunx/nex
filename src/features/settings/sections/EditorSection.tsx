import { useEffect, useState } from "react";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { useSettingsStore } from "../../../stores/settings.store";
import { SECTION_HEADER } from "./_shared";

/** 单行最大显示长度的合理上下界（仅防极端输入，UI 不展示为「范围」）。 */
const WRAP_COLUMN_MIN = 20;
const WRAP_COLUMN_MAX = 1000;

export function EditorSection() {
  const {
    editorAutoSave,
    setEditorAutoSave,
    editorWordWrap,
    setEditorWordWrap,
    editorWrapColumn,
    setEditorWrapColumn,
  } = useSettingsStore();
  // 本地草稿：输入过程中不即时 clamp，失焦/回车时才提交。
  const [wrapColumnDraft, setWrapColumnDraft] = useState(String(editorWrapColumn));
  useEffect(() => {
    setWrapColumnDraft(String(editorWrapColumn));
  }, [editorWrapColumn]);

  const commitWrapColumn = () => {
    const n = Number(wrapColumnDraft);
    if (Number.isFinite(n)) {
      const clamped = Math.min(WRAP_COLUMN_MAX, Math.max(WRAP_COLUMN_MIN, Math.round(n)));
      setEditorWrapColumn(clamped);
      setWrapColumnDraft(String(clamped));
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
          <Label htmlFor="editor-wordwrap">按阈值换行</Label>
          <p className="text-xs text-[var(--text-tertiary)]">
            开启后按下方字符数阈值换行；关闭则永不换行（仅横向滚动）
          </p>
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
          <p className="text-xs text-[var(--text-tertiary)]">
            单个阈值（字符数，默认 70）：未超出则单行显示，超出才自动换行
          </p>
        </div>
        <Input
          id="editor-wrap-column"
          type="number"
          inputMode="numeric"
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
