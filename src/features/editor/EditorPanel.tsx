import { useEffect, useRef } from "react";
import CodeMirror, { EditorView } from "@uiw/react-codemirror";
import { X } from "lucide-react";
import { Button } from "@glinui/ui";
import { useFsStore } from "../../stores/fs.store";
import { useUiStore } from "../../stores/ui.store";
import { useProjectStore } from "../../stores/project.store";
import { fileBasename, relativeToProject } from "./pathUtils";
import { languageExtensionsForPath } from "./language";

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
  const openFiles = useFsStore((s) => s.openFiles);
  const activePath = useFsStore((s) => s.activePath);
  const editorFile = openFiles.find((f) => f.path === activePath) ?? null;
  const error = useFsStore((s) => s.error);
  const setDraft = useFsStore((s) => s.setDraft);
  const switchFile = useFsStore((s) => s.switchFile);
  const closeFile = useFsStore((s) => s.closeFile);
  const saveFile = useFsStore((s) => s.saveFile);
  const reloadEditor = useFsStore((s) => s.reloadEditor);
  const dismissStale = useFsStore((s) => s.dismissStale);
  const clearError = useFsStore((s) => s.clearError);
  const editorVisible = useUiStore((s) => s.editorVisible);
  const projects = useProjectStore((s) => s.projects);
  const activeProjectId = useProjectStore((s) => s.activeProjectId);
  const projectPath = projects.find((p) => p.id === activeProjectId)?.path;
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
        const active = fs.openFiles.find((f) => f.path === fs.activePath);
        if (active?.dirty) void fs.saveFile();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  if (openFiles.length === 0) return null;

  return (
    <div className={editorVisible ? "flex flex-col h-full min-h-0" : "hidden"}>
      <div className="flex items-center gap-1 px-2 py-1.5 border-b border-[color:var(--border-subtle)] overflow-x-auto shrink-0">
        {openFiles.map((f) => {
          const active = f.path === activePath;
          return (
            <div
              key={f.path}
              className={`flex items-center gap-1 max-w-[160px] rounded-[var(--radius-sm)] px-2 py-1 text-xs cursor-pointer shrink-0 ${
                active
                  ? "bg-[var(--glass-2-surface)] text-[var(--text-primary)]"
                  : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
              }`}
              title={relativeToProject(f.path, projectPath)}
              onClick={() => void switchFile(f.path)}
            >
              <span className="truncate">{fileBasename(f.path)}</span>
              {f.dirty && <span className="text-[var(--accent)]" title="未保存的修改">●</span>}
              <span
                role="button"
                className="opacity-50 hover:opacity-100"
                onMouseDown={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                }}
                onClick={(e) => {
                  e.stopPropagation();
                  void closeFile(f.path);
                }}
              >
                <X size={12} />
              </span>
            </div>
          );
        })}
        <div className="flex-1" />
        <Button
          size="sm"
          variant="ghost"
          disabled={!editorFile?.dirty || !editorFile?.isText}
          onClick={() => void saveFile()}
        >
          保存
        </Button>
      </div>
      {error && (
        <div className="flex items-center gap-2 px-4 py-1.5 text-xs text-[var(--error)] bg-[var(--error)]/10 shrink-0">
          <span className="flex-1 truncate">{error}</span>
          <Button size="sm" variant="ghost" onClick={clearError}><X size={12} /></Button>
        </div>
      )}
      {editorFile?.stale && (
        <div className="flex items-center gap-2 px-4 py-1.5 text-xs text-[var(--warning)] bg-[var(--warning)]/10 shrink-0">
          <span className="flex-1 truncate">文件在磁盘上已被修改</span>
          <Button size="sm" variant="ghost" onClick={() => void reloadEditor()}>重新加载</Button>
          <Button size="sm" variant="ghost" onClick={dismissStale}>保留</Button>
        </div>
      )}
      <div className="flex-1 min-h-0 overflow-hidden">
        {editorFile?.isText ? (
          <>
            {/* key = one EditorView per file: without it the undo stack survives a file switch and Ctrl+Z can resurrect the previous file's content — a wrong-path save hazard. Esc-hide is unaffected (same path, CSS-only hide), so undo/scroll preservation across hide/re-show still holds. */}
            <CodeMirror
              key={editorFile.path}
              value={editorFile.draft}
              onChange={setDraft}
              onCreateEditor={(view) => { viewRef.current = view; }}
              theme={editorTheme}
              extensions={languageExtensionsForPath(editorFile.path)}
              height="100%"
            />
          </>
        ) : editorFile ? (
          <div className="flex h-full items-center justify-center text-sm text-[var(--text-tertiary)]">
            二进制或超大文件 ({(editorFile.size / 1024).toFixed(1)} KB) — 暂不可编辑
          </div>
        ) : null}
      </div>
    </div>
  );
}
