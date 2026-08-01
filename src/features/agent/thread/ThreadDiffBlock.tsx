import { useMemo } from "react";
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

  return (
    <div className="rounded bg-[var(--glass-2-surface)] overflow-hidden">
      {path ? (
        <div className="px-2 py-1 text-[10px] font-mono text-[var(--text-tertiary)] truncate border-b border-[color:var(--border-subtle)]">
          {path}
        </div>
      ) : null}
      <DiffView
        payload={payload}
        theme={theme}
        extensions={extensions}
        height="auto"
        maxHeight="320px"
      />
    </div>
  );
}
