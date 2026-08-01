import CodeMirror from "@uiw/react-codemirror";
import { EditorState, RangeSetBuilder, type Extension } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { unifiedMergeView } from "@codemirror/merge";
import type { DiffPayload } from "../../stores/fs.store";

/** 补丁文本逐行分类：+ 新增 / - 删除 / 其余（头行、@@、上下文）为 null。导出供测试。 */
// 简报要求纯函数与本组件同文件导出；抑制 only-export-components 以守住 lint 警告基线。
// oxlint-disable-next-line react/only-export-components
export function patchLineClasses(text: string): ("add" | "del" | null)[] {
  return text.split("\n").map((line) => {
    if (line.startsWith("+")) return "add";
    if (line.startsWith("-")) return "del";
    return null;
  });
}

const patchTheme = EditorView.baseTheme({
  ".cm-patch-add": { backgroundColor: "color-mix(in srgb, var(--success) 14%, transparent)" },
  ".cm-patch-del": { backgroundColor: "color-mix(in srgb, var(--error) 14%, transparent)" },
});

function buildPatchDecorations(state: EditorState): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const classes = patchLineClasses(state.doc.toString());
  for (let i = 0; i < classes.length; i++) {
    const cls = classes[i];
    if (!cls) continue;
    const line = state.doc.line(i + 1);
    builder.add(line.from, line.from, Decoration.line({ class: cls === "add" ? "cm-patch-add" : "cm-patch-del" }));
  }
  return builder.finish();
}

const patchHighlight = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildPatchDecorations(view.state);
    }
    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = buildPatchDecorations(update.state);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

interface DiffViewProps {
  payload: DiffPayload;
  theme: Extension;
  /** 语言高亮 + 搜索扩展，由 EditorPanel 统一构造传入。 */
  extensions: Extension[];
  onCreateEditor?: (view: EditorView) => void;
  /** 默认 100%（编辑器面板）；对话内嵌可用 auto + maxHeight。 */
  height?: string;
  maxHeight?: string;
}

/** 只读 diff 标签内容：merge = 统一合并视图（双全文档），patch = 行着色补丁全文。 */
export function DiffView({
  payload,
  theme,
  extensions,
  onCreateEditor,
  height = "100%",
  maxHeight,
}: DiffViewProps) {
  if (payload.binary) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-[var(--text-tertiary)]">
        二进制文件 — 无法显示文本差异
      </div>
    );
  }

  const sizeStyle = { height, maxHeight };

  if (payload.mode === "patch") {
    return (
      <CodeMirror
        value={payload.revised}
        theme={theme}
        extensions={[...extensions, EditorState.readOnly.of(true), patchHighlight, patchTheme]}
        onCreateEditor={(view) => onCreateEditor?.(view)}
        height={height}
        maxHeight={maxHeight}
        style={sizeStyle}
      />
    );
  }

  return (
    <CodeMirror
      value={payload.revised}
      theme={theme}
      extensions={[
        ...extensions,
        EditorState.readOnly.of(true),
        unifiedMergeView({
          original: payload.original,
          highlightChanges: true,
          gutter: true,
          mergeControls: false, // 只读视图不需要接受/拒绝控件
          collapseUnchanged: { margin: 3, minSize: 8 },
        }),
      ]}
      onCreateEditor={(view) => onCreateEditor?.(view)}
      height={height}
      maxHeight={maxHeight}
      style={sizeStyle}
    />
  );
}
