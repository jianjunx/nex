import { useEffect, useMemo, useRef } from "react";
import CodeMirror, { EditorView } from "@uiw/react-codemirror";
import { PanelRight, X } from "lucide-react";
import { registerFindBarAccessor } from "../../commands/editorKeybindings";
import { Button } from "@/components/ui/button";
import { useFsStore } from "../../stores/fs.store";
import { useUiStore } from "../../stores/ui.store";
import { useProjectStore } from "../../stores/project.store";
import { fileBasename, relativeToProject } from "./pathUtils";
import { languageExtensionsForPath } from "./language";
import { editorSearchExtensions } from "./editorSearch";
import { DiffView } from "./DiffView";

// CSS variables are resolved at paint time, so a light/dark theme switch
// restyles the editor with zero reconstruction — no editor re-theme needed.
// height/overflow on & + .cm-scroller is required for mouse-wheel scrolling
// when the parent gives a fixed flex height (otherwise the doc grows the view).
const editorTheme = EditorView.theme({
  "&": {
    height: "100%",
    backgroundColor: "transparent",
    color: "var(--text-primary)",
    fontSize: "13px",
  },
  ".cm-scroller": { overflow: "auto" },
  ".cm-content": { caretColor: "var(--accent)", fontFamily: "JetBrains Mono, Menlo, Consolas, monospace" },
  ".cm-cursor": { borderLeftColor: "var(--accent)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": { backgroundColor: "var(--overlay-active)" },
  ".cm-gutters": { backgroundColor: "transparent", color: "var(--text-tertiary)", borderRight: "1px solid var(--border-subtle)" },
  ".cm-activeLine": { backgroundColor: "var(--overlay-ghost)" },
  // Host the custom find bar at the top without CodeMirror's default panel chrome.
  ".cm-panels.cm-panels-top": {
    backgroundColor: "transparent",
    borderBottom: "1px solid var(--border-subtle)",
  },
  ".cm-panel": {
    backgroundColor: "transparent",
    padding: "0",
    boxShadow: "none",
  },
  ".cm-searchMatch": { backgroundColor: "color-mix(in srgb, var(--accent) 28%, transparent)" },
  ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "color-mix(in srgb, var(--accent) 55%, transparent)" },
});

// Plan 5 行定位：搜索跳转携带 pendingLine。视图就绪后选中并滚动到目标行，
// 然后消费掉 pending 防止重复触发。两条入口：新视图走 onCreateEditor，
// 已存在视图（同文件再次跳转，不按 path 重建）走组件内 effect。
const applyPendingLine = (view: EditorView) => {
  const fs = useFsStore.getState();
  const pending = fs.pendingLine;
  if (!pending || pending.path !== fs.activePath) return;
  const line = Math.min(Math.max(1, pending.line), view.state.doc.lines);
  const pos = view.state.doc.line(line).from;
  view.dispatch({
    selection: { anchor: pos },
    effects: EditorView.scrollIntoView(pos, { y: "center" }),
  });
  fs.consumePendingLine();
};

export function EditorPanel() {
  const openFiles = useFsStore((s) => s.openFiles);
  const activePath = useFsStore((s) => s.activePath);
  const editorFile = openFiles.find((f) => f.path === activePath) ?? null;
  const error = useFsStore((s) => s.error);
  const setDraft = useFsStore((s) => s.setDraft);
  const switchFile = useFsStore((s) => s.switchFile);
  const closeFile = useFsStore((s) => s.closeFile);
  const reloadEditor = useFsStore((s) => s.reloadEditor);
  const dismissStale = useFsStore((s) => s.dismissStale);
  const clearError = useFsStore((s) => s.clearError);
  const projects = useProjectStore((s) => s.projects);
  const activeProjectId = useProjectStore((s) => s.activeProjectId);
  const projectPath = projects.find((p) => p.id === activeProjectId)?.path;
  const viewRef = useRef<EditorView | null>(null);
  const pendingLine = useFsStore((s) => s.pendingLine);

  // diff 标签用合成路径（diff: 前缀），语言检测须走载荷中的 languageHint。
  const langPath = editorFile?.diff ? editorFile.diff.languageHint : (editorFile?.path ?? "");

  const extensions = useMemo(
    () => [...languageExtensionsForPath(langPath), ...editorSearchExtensions()],
    [langPath],
  );

  // CodeMirror measured at zero size while hidden; force a re-measure on mount.
  useEffect(() => {
    viewRef.current?.requestMeasure();
  }, []);

  useEffect(() => {
    registerFindBarAccessor(() => viewRef.current);
    return () => registerFindBarAccessor(null);
  }, []);

  useEffect(() => {
    const v = viewRef.current;
    if (v) applyPendingLine(v);
  }, [pendingLine, editorFile?.path]);

  if (openFiles.length === 0) return null;

  return (
    <div className="flex flex-col h-full min-h-0">
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
              title={f.diff ? f.diff.title : relativeToProject(f.path, projectPath)}
              onClick={() => void switchFile(f.path)}
            >
              <span className={`truncate ${!f.pinned ? "italic" : ""}`}>{f.diff ? f.diff.title : fileBasename(f.path)}</span>
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
          title="收起面板"
          onClick={() => useUiStore.getState().setEditorVisible(false)}
        >
          <PanelRight size={14} />
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
        {editorFile?.diff ? (
          <DiffView
            key={editorFile.path}
            payload={editorFile.diff}
            theme={editorTheme}
            extensions={extensions}
            onCreateEditor={(view) => { viewRef.current = view; }}
          />
        ) : editorFile?.isText ? (
          <div className="h-full min-h-0">
            {/* key = one EditorView per file: without it the undo stack survives a file switch and Ctrl+Z can resurrect the previous file's content — a wrong-path save hazard. Esc-hide is unaffected (same path, CSS-only hide), so undo/scroll preservation across hide/re-show still holds. */}
            <CodeMirror
              key={editorFile.path}
              value={editorFile.draft}
              onChange={setDraft}
              onCreateEditor={(view) => { viewRef.current = view; applyPendingLine(view); }}
              theme={editorTheme}
              extensions={extensions}
              height="100%"
              style={{ height: "100%" }}
            />
          </div>
        ) : editorFile ? (
          <div className="flex h-full items-center justify-center text-sm text-[var(--text-tertiary)]">
            二进制或超大文件 ({(editorFile.size / 1024).toFixed(1)} KB) — 暂不可编辑
          </div>
        ) : null}
      </div>
    </div>
  );
}
