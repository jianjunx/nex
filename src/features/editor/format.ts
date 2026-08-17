import type { EditorView } from "@codemirror/view";
import { fileBasename } from "./pathUtils";

type PrettierModule = typeof import("prettier/standalone");
type PrettierPluginModule = Record<string, unknown>;

type LoadedPrettier = {
  prettier: PrettierModule;
  plugins: PrettierPluginModule[];
};

let prettierLoader: Promise<LoadedPrettier> | null = null;

function loadPrettier(): Promise<LoadedPrettier> {
  if (!prettierLoader) {
    prettierLoader = Promise.all([
      import("prettier/standalone"),
      import("prettier/plugins/estree"),
      import("prettier/plugins/babel"),
      import("prettier/plugins/typescript"),
      import("prettier/plugins/html"),
      import("prettier/plugins/markdown"),
      import("prettier/plugins/postcss"),
      import("prettier/plugins/yaml"),
    ]).then(([prettier, estree, babel, typescript, html, markdown, postcss, yaml]) => ({
      prettier,
      plugins: [estree, babel, typescript, html, markdown, postcss, yaml],
    }));
  }
  return prettierLoader;
}

export function formatParserForPath(path: string): string | null {
  const name = fileBasename(path).toLowerCase();
  const dot = name.lastIndexOf(".");
  const ext = dot >= 0 ? name.slice(dot + 1) : "";

  switch (ext) {
    case "ts":
    case "tsx":
    case "mts":
    case "cts":
      return "typescript";
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
      return "babel";
    case "json":
      return "json";
    case "jsonc":
    case "json5":
      return "json5";
    case "css":
      return "css";
    case "scss":
      return "scss";
    case "less":
      return "less";
    case "html":
    case "htm":
      return "html";
    case "vue":
      return "vue";
    case "md":
    case "markdown":
      return "markdown";
    case "mdx":
      return "mdx";
    case "yaml":
    case "yml":
      return "yaml";
    default:
      return null;
  }
}

export function canFormatPath(path: string): boolean {
  return formatParserForPath(path) !== null;
}

export async function formatTextForPath(path: string, text: string): Promise<string> {
  const parser = formatParserForPath(path);
  if (!parser) {
    throw new Error("当前文件类型暂不支持格式化");
  }
  const { prettier, plugins } = await loadPrettier();
  return prettier.format(text, {
    parser,
    filepath: fileBasename(path),
    plugins,
  });
}

export function replaceWholeDocument(view: EditorView, nextText: string): void {
  const { from, to } = view.state.selection.main;
  const anchor = Math.min(from, nextText.length);
  const head = Math.min(to, nextText.length);
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: nextText },
    selection: { anchor, head },
  });
}
