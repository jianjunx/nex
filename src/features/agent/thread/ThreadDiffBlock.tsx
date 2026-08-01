import { useEffect, useMemo, useState } from "react";
import { EditorView } from "@codemirror/view";
import { oneDark } from "@codemirror/theme-one-dark";
import type { Extension } from "@codemirror/state";
import { DiffView } from "../../editor/DiffView";
import { languageExtensionsForPath } from "../../editor/language";
import { useSettingsStore } from "../../../stores/settings.store";
import type { DiffPayload } from "../../../stores/fs.store";

const threadDiffLayout = EditorView.theme({
  "&": {
    fontSize: "12px",
    backgroundColor: "transparent",
  },
  ".cm-scroller": {
    overflow: "auto",
    fontFamily: "JetBrains Mono, Menlo, Consolas, monospace",
  },
  ".cm-gutters": {
    backgroundColor: "transparent",
    borderRight: "1px solid var(--border-subtle)",
  },
  ".cm-content": {
    fontFamily: "JetBrains Mono, Menlo, Consolas, monospace",
  },
});

const threadDiffLight = EditorView.theme({
  "&": {
    fontSize: "12px",
    backgroundColor: "transparent",
    color: "var(--text-primary)",
  },
  ".cm-scroller": {
    overflow: "auto",
    fontFamily: "JetBrains Mono, Menlo, Consolas, monospace",
  },
  ".cm-gutters": {
    backgroundColor: "transparent",
    color: "var(--text-tertiary)",
    borderRight: "1px solid var(--border-subtle)",
  },
  ".cm-content": {
    caretColor: "transparent",
    fontFamily: "JetBrains Mono, Menlo, Consolas, monospace",
  },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": {
    backgroundColor: "var(--overlay-active)",
  },
});

function themeFor(appTheme: "light" | "dark"): Extension {
  return appTheme === "dark" ? [oneDark, threadDiffLayout] : threadDiffLight;
}

/** 对话面板内嵌的只读文件编辑 diff：按路径语言上色 + unified merge。 */
export function ThreadDiffBlock({
  path,
  oldText,
  newText,
}: {
  path?: string;
  oldText?: string;
  newText?: string;
}) {
  const appTheme = useSettingsStore((s) => s.theme);
  const theme = useMemo(() => themeFor(appTheme), [appTheme]);
  const extensions = useMemo(() => languageExtensionsForPath(path ?? ""), [path]);
  const payload: DiffPayload = useMemo(
    () => ({
      mode: "merge",
      title: path ?? "",
      languageHint: path ?? "",
      original: oldText ?? "",
      revised: newText ?? "",
      binary: false,
    }),
    [path, oldText, newText],
  );

  // 延迟挂载:进入可视区后先占位,停留 ~120ms 再建 CodeMirror。
  // 快速滚过的行在计时器触发前已被虚拟化卸载,昂贵的 merge 计算不会发生。
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setReady(true), 120);
    return () => clearTimeout(t);
  }, []);

  return (
    <div className="rounded bg-[var(--glass-2-surface)] overflow-hidden">
      {path ? (
        <div className="px-2 py-1 text-[10px] font-mono text-[var(--text-tertiary)] truncate border-b border-[color:var(--border-subtle)]">
          {path}
        </div>
      ) : null}
      {ready ? (
        // 不传 maxHeight:卡片外层 max-h-[350px] 作唯一滚动容器,diff 自动撑高后被其封顶,
        // 避免 DiffView 内部 .cm-scroller 再起一条滚动条(双滚动条)。
        <DiffView
          payload={payload}
          theme={theme}
          extensions={extensions}
          height="auto"
        />
      ) : (
        // 占位顶满 edit 内容区封顶高度(350):使「占位帧」与「就绪帧」行高恒等(均被
        // 外层 max-h-[350px] 封顶),measureElement 在延迟挂载前后测得同高,虚拟器零尺寸
        // 变化 → 消除上滚抖动;同时快速滚过的行仍不会触发昂贵的 merge 计算。
        <div style={{ minHeight: 350 }} aria-hidden="true" />
      )}
    </div>
  );
}
