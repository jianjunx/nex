import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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

/**
 * diff 槽实测高缓存(模块级):就绪后实测写入,占位命中即复现 →
 * 回看该卡时占位与就绪同高,虚拟器零尺寸变化。键由调用方传入(会话条目级唯一)。
 */
const diffHeights = new Map<string, number>();

/** 按 diff 行数预估就绪高度:首次揭示无缓存时贴近 CM 自然高度,压低占位↔就绪首跳。封顶 320(外层 max-h-[350px] 减去路径头/内边距)。 */
export function estimateDiffHeight(oldText?: string, newText?: string): number {
  const LINE_PX = 18;
  const MAX = 320;
  const FLOOR = 48;
  const lines = Math.max(
    oldText ? oldText.split("\n").length : 0,
    newText ? newText.split("\n").length : 0,
  );
  return Math.min(MAX, Math.max(FLOOR, lines * LINE_PX));
}

/** 对话面板内嵌的只读文件编辑 diff：按路径语言上色 + unified merge。 */
export function ThreadDiffBlock({
  cacheKey,
  path,
  oldText,
  newText,
}: {
  cacheKey: string;
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

  // 就绪且 CM 布局完成后,把槽(不含路径头)实测高写入缓存:回看时占位即可复现该高度。
  const slotRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (ready && slotRef.current) {
      const h = slotRef.current.getBoundingClientRect().height;
      if (h > 0) diffHeights.set(cacheKey, h);
    }
  }, [ready, cacheKey]);

  // 占位高度:命中缓存复现就绪高度(回看零跳);否则按行数预估(首次揭示贴近自然高度)。
  const placeholderH = diffHeights.get(cacheKey) ?? estimateDiffHeight(oldText, newText);

  return (
    <div className="rounded bg-[var(--glass-2-surface)] overflow-hidden">
      {path ? (
        <div className="px-2 py-1 text-[10px] font-mono text-[var(--text-tertiary)] truncate border-b border-[color:var(--border-subtle)]">
          {path}
        </div>
      ) : null}
      <div ref={slotRef}>
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
          <div style={{ minHeight: placeholderH }} aria-hidden="true" />
        )}
      </div>
    </div>
  );
}
