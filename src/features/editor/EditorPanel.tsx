import { useEffect, useRef } from "react";
import CodeMirror, { EditorView } from "@uiw/react-codemirror";
import { X } from "lucide-react";
import { Button } from "@glinui/ui";
import { useFsStore } from "../../stores/fs.store";
import { useUiStore } from "../../stores/ui.store";

// CSS variables are resolved at paint time, so a light/dark theme switch
// restyles the editor with zero reconstruction — no editor re-theme needed.
const editorTheme = EditorView.theme({
  "&": { backgroundColor: "transparent", color: "var(--text-primary)", fontSize: "13px" },
  ".cm-content": { caretColor: "var(--accent)", fontFamily: "JetBrains Mono, Menlo, Consolas, monospace" },
  ".cm-cursor": { borderLeftColor: "var(--accent)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": { backgroundColor: "var(--overlay-active)" },
  ".cm-gutters": { backgroundColor: "transparent", color: "var(--text-tertiary)", borderRight: "1px solid var(--border-subtle)" },
  ".cm-activeLine": { backgroundColor: "var(--overlay-ghost)" },
});

export function EditorPanel() {
  const { editorFile, setDraft, closeEditor, saveFile, reloadEditor, dismissStale } = useFsStore();
  const editorVisible = useUiStore((s) => s.editorVisible);
  const viewRef = useRef<EditorView | null>(null);

  // CodeMirror measured at zero size while `hidden` lays out wrong when
  // re-shown; force a re-measure.
  useEffect(() => {
    if (editorVisible) viewRef.current?.requestMeasure();
  }, [editorVisible]);

  // Global keyboard-shortcut pattern (first in this codebase — copy this for
  // future app-level shortcuts): one window listener per mounted panel, live
  // state via getState() (never captured values), and YIELD to any open Radix
  // dialog — Radix does not stopPropagation on Esc, so without the role check
  // this handler would fire underneath a modal's own Esc handling.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (document.querySelector('[role="dialog"],[role="alertdialog"]')) return;
      if (e.key === "Escape") {
        // Hide only — the editor stays mounted so draft + undo history survive.
        useUiStore.getState().setEditorVisible(false);
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        const fs = useFsStore.getState();
        if (fs.editorFile?.dirty) void fs.saveFile();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  if (!editorFile) return null;

  return (
    <div className={editorVisible ? "flex flex-col h-full" : "hidden"}>
      <div className="flex items-center gap-2 px-4 py-2 border-b border-[color:var(--border-subtle)]">
        <span className="flex-1 truncate text-xs text-[var(--text-primary)]">{editorFile.path.split("/").pop()}</span>
        {editorFile.dirty && <span className="text-xs text-[var(--accent)]" title="未保存的修改">●</span>}
        <Button size="sm" variant="ghost" disabled={!editorFile.dirty || !editorFile.isText} onClick={() => void saveFile()}>保存</Button>
        <Button size="sm" variant="ghost" onClick={closeEditor}><X size={12} /></Button>
      </div>
      {editorFile.stale && (
        <div className="flex items-center gap-2 px-4 py-1.5 text-xs text-[var(--warning)] bg-[var(--warning)]/10">
          <span className="flex-1 truncate">文件在磁盘上已被修改</span>
          <Button size="sm" variant="ghost" onClick={() => void reloadEditor()}>重新加载</Button>
          <Button size="sm" variant="ghost" onClick={dismissStale}>保留</Button>
        </div>
      )}
      <div className="flex-1 overflow-hidden">
        {editorFile.isText ? (
          <CodeMirror
            value={editorFile.draft}
            onChange={setDraft}
            onCreateEditor={(view) => { viewRef.current = view; }}
            theme={editorTheme}
            height="100%"
          />
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-[var(--text-tertiary)]">
            二进制或超大文件 ({(editorFile.size / 1024).toFixed(1)} KB) — 暂不可编辑
          </div>
        )}
      </div>
    </div>
  );
}
