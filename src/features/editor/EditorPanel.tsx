import { useEffect, useMemo, useRef, useCallback } from "react";
import CodeMirror, { EditorView } from "@uiw/react-codemirror";
import { oneDark } from "@codemirror/theme-one-dark";
import type { Extension } from "@codemirror/state";
import { PanelRight, X } from "lucide-react";
import { registerFindBarAccessor } from "../../commands/editorKeybindings";
import { Button } from "@/components/ui/button";
import { useFsStore } from "../../stores/fs.store";
import { useUiStore } from "../../stores/ui.store";
import { useProjectStore } from "../../stores/project.store";
import { useSettingsStore } from "../../stores/settings.store";
import { fileBasename, relativeToProject } from "./pathUtils";
import { languageExtensionsForPath } from "./language";
import { editorSearchExtensions } from "./editorSearch";
import { DiffView } from "./DiffView";
import { useTabReorder } from "../layout/useTabReorder";
import { EditorContextMenu } from "./EditorContextMenu";
import FileIcon from "../files/FileIcon";

/** Shared layout chrome (height / panels / fonts). Colors come from oneDark or lightTheme. */
const editorLayoutTheme = EditorView.theme({
  "&": {
    height: "100%",
    fontSize: "13px",
  },
  ".cm-scroller": { overflow: "auto" },
  ".cm-content": { fontFamily: "JetBrains Mono, Menlo, Consolas, monospace" },
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
});

// Light theme: CSS variables resolve at paint time so switching restyles without rebuild.
const editorLightTheme = EditorView.theme({
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

function editorThemeFor(appTheme: "light" | "dark"): Extension {
  return appTheme === "dark" ? [oneDark, editorLayoutTheme] : editorLightTheme;
}

// Plan 5 行定位：搜索跳转携带 pendingLine。视图就绪后选中并滚动到目标行，
// 然后消费掉 pending 防止重复触发。两条入口：新视图走 onCreateEditor，
// 已存在视图（同文件再次跳转，不按 path 重建）走组件内 effect。
// ownerPath 是 view 所属的文件路径。切换文件时 CodeMirror 按 key 重建，
// 新视图要等下一次 commit 才创建，而组件内 effect 在本轮 commit 就带着
// 仍指向旧文件的 viewRef 跑——若只比 pending.path === activePath，跳转会
// 打到旧视图上并提前消费 pendingLine，新视图再也收不到跳转（表现为：
// 点搜索结果切对了文件但光标停在文件开头）。ownerPath 不匹配时直接
// 返回、不消费，等新视图的 onCreateEditor 来应用。
const applyPendingLine = (view: EditorView, ownerPath: string | null) => {
  const fs = useFsStore.getState();
  const pending = fs.pendingLine;
  if (!pending || pending.path !== fs.activePath || ownerPath !== pending.path) return;
  const line = Math.min(Math.max(1, pending.line), view.state.doc.lines);
  const pos = view.state.doc.line(line).from;
  view.dispatch({
    selection: { anchor: pos },
    effects: EditorView.scrollIntoView(pos, { y: "center" }),
  });
  // 跳转后目标行短暂背景高亮，帮助用户定位（CSS 动画自动淡化）。
  // 延迟到下一帧：滚动生效前目标行 DOM 可能尚未渲染（虚拟滚动）。
  requestAnimationFrame(() => {
    const domPos = view.domAtPos(pos);
    const lineEl =
      domPos.node instanceof HTMLElement
        ? domPos.node
        : domPos.node.parentElement;
    const cmLine = lineEl?.closest(".cm-line") ?? lineEl;
    if (!(cmLine instanceof HTMLElement)) return;
    cmLine.classList.remove("nex-jump-highlight");
    // force reflow so removing+re-adding restarts the animation
    void cmLine.offsetWidth;
    cmLine.classList.add("nex-jump-highlight");
    window.setTimeout(() => cmLine.classList.remove("nex-jump-highlight"), 2000);
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
  const reorderOpenFiles = useFsStore((s) => s.reorderOpenFiles);
  const reloadEditor = useFsStore((s) => s.reloadEditor);
  const dismissStale = useFsStore((s) => s.dismissStale);
  const clearError = useFsStore((s) => s.clearError);
  const projects = useProjectStore((s) => s.projects);
  const activeProjectId = useProjectStore((s) => s.activeProjectId);
  const projectPath = projects.find((p) => p.id === activeProjectId)?.path;
  const appTheme = useSettingsStore((s) => s.theme);
  const wordWrap = useSettingsStore((s) => s.editorWordWrap);
  const wrapColumn = useSettingsStore((s) => s.editorWrapColumn);
  const editorTheme = useMemo(() => editorThemeFor(appTheme), [appTheme]);
  const viewRef = useRef<EditorView | null>(null);
  // viewRef 里视图所属的文件路径（onCreateEditor 时记录）。用于识别
  // 文件切换重建期间的过期视图，见 applyPendingLine。
  const viewPathRef = useRef<string | null>(null);
  const pendingLine = useFsStore((s) => s.pendingLine);
  const openFile = useFsStore((s) => s.openFile);
  const { draggingIndex, bindTab } = useTabReorder(reorderOpenFiles);
  const tabsScrollerRef = useRef<HTMLDivElement>(null);
  const prevOpenCountRef = useRef(openFiles.length);

  const handleTabsWheel = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    if (el.scrollWidth <= el.clientWidth) return;
    if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
    e.preventDefault();
    el.scrollLeft += e.deltaY;
  }, []);

  // diff 标签用合成路径（diff: 前缀），语言检测须走载荷中的 languageHint。
  const langPath = editorFile?.diff ? editorFile.diff.languageHint : (editorFile?.path ?? "");

  const extensions = useMemo(
    () => [
      ...languageExtensionsForPath(langPath),
      ...editorSearchExtensions(),
      // 单行最大显示长度：按阈值列宽软换行。
      // 内容区宽度固定为 N ch —— 短于阈值的行不换行；视口更窄时出横向滚动条；
      // 超出阈值才在该宽度内换行。若只用 max-width，窄视口会提前按视口边缘换行。
      ...(wordWrap
        ? [
            EditorView.lineWrapping,
            EditorView.theme({
              ".cm-content": {
                width: `${wrapColumn}ch`,
                maxWidth: `${wrapColumn}ch`,
              },
            }),
          ]
        : []),
    ],
    [langPath, wordWrap, wrapColumn],
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
    if (v) applyPendingLine(v, viewPathRef.current);
  }, [pendingLine, editorFile?.path]);

  useEffect(() => {
    const el = tabsScrollerRef.current;
    if (!el) {
      prevOpenCountRef.current = openFiles.length;
      return;
    }
    if (openFiles.length > prevOpenCountRef.current) {
      requestAnimationFrame(() => {
        const node = tabsScrollerRef.current;
        if (!node) return;
        node.scrollLeft = node.scrollWidth;
      });
    }
    prevOpenCountRef.current = openFiles.length;
  }, [openFiles.length]);

  if (openFiles.length === 0) return null;

  return (
    <div className="flex flex-col h-full min-h-0" data-editor-area>
      <div
        ref={tabsScrollerRef}
        data-editor-tabs-scroller
        onWheel={handleTabsWheel}
        className="flex items-center gap-1 px-1.5 py-1 border-b border-[color:var(--border-subtle)] overflow-x-auto shrink-0"
      >
        {openFiles.map((f, index) => {
          const active = f.path === activePath;
          const drag = bindTab(index);
          return (
            <div
              key={f.path}
              data-tab-index={drag["data-tab-index"]}
              onPointerDown={drag.onPointerDown}
              className={`group/tab flex items-center gap-1 max-w-[160px] rounded-[var(--radius-sm)] border px-2 py-1 text-xs cursor-pointer shrink-0 select-none transition-colors duration-150 ${
                active
                  ? "border-[color:var(--border-default)] bg-[var(--glass-2-surface)] text-[var(--text-primary)] shadow-[inset_0_1px_0_0_var(--edge-highlight)]"
                  : "border-transparent text-[var(--text-secondary)] hover:bg-[var(--overlay-hover)] hover:text-[var(--text-primary)]"
              } ${draggingIndex === index ? "opacity-50" : ""}`}
              title={f.diff ? f.diff.title : relativeToProject(f.path, projectPath)}
              onClick={() => void switchFile(f.path)}
              onDoubleClick={() => {
                void openFile(f.path, true);
              }}
            >
              <FileIcon filename={f.diff ? "" : fileBasename(f.path)} size={14} className="shrink-0" />
              <span className={`truncate ${!f.pinned ? "italic" : ""}`}>{f.diff ? f.diff.title : fileBasename(f.path)}</span>
              {f.dirty && <span className="text-[var(--accent)]" title="未保存的修改">●</span>}
              <span
                role="button"
                data-tab-close
                className="ml-0.5 flex size-4 shrink-0 items-center justify-center rounded-sm opacity-0 transition-opacity group-hover/tab:opacity-70 hover:!opacity-100"
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
          <EditorContextMenu viewRef={viewRef} readOnly>
            <DiffView
              key={editorFile.path}
              payload={editorFile.diff}
              theme={editorTheme}
              extensions={extensions}
              onCreateEditor={(view) => { viewRef.current = view; viewPathRef.current = editorFile.path; }}
            />
          </EditorContextMenu>
        ) : editorFile?.isText ? (
          <EditorContextMenu viewRef={viewRef}>
            <div className="h-full min-h-0">
              {/* key = one EditorView per file: without it the undo stack survives a file switch and Ctrl+Z can resurrect the previous file's content — a wrong-path save hazard. Esc-hide is unaffected (same path, CSS-only hide), so undo/scroll preservation across hide/re-show still holds. */}
              <CodeMirror
                key={editorFile.path}
                value={editorFile.draft}
                onChange={setDraft}
                onCreateEditor={(view) => {
                  viewRef.current = view;
                  viewPathRef.current = editorFile.path;
                  applyPendingLine(view, editorFile.path);
                }}
                theme={editorTheme}
                extensions={extensions}
                height="100%"
                style={{ height: "100%" }}
              />
            </div>
          </EditorContextMenu>
        ) : editorFile ? (
          <div className="flex h-full items-center justify-center text-sm text-[var(--text-tertiary)]">
            二进制或超大文件 ({(editorFile.size / 1024).toFixed(1)} KB) — 暂不可编辑
          </div>
        ) : null}
      </div>
    </div>
  );
}
