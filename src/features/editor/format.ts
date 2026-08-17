import type { EditorView } from "@codemirror/view";
import { fileBasename } from "./pathUtils";

type PrettierModule = typeof import("prettier/standalone");
type PrettierPluginModule = Record<string, unknown>;
type RustFmtModule = typeof import("@scalar/rust-fmt");
type GoFmtModule = typeof import("@wasm-fmt/gofmt");
type RuffFmtModule = typeof import("@wasm-fmt/ruff_fmt");
type ShSyntaxModule = typeof import("sh-syntax");

type LoadedPrettier = {
  prettier: PrettierModule;
  plugins: PrettierPluginModule[];
};

type ShellPrinter = (text: string, options?: Record<string, unknown>) => Promise<string>;

type LanguageFormatter =
  | { kind: "prettier"; parser: string; options?: Record<string, unknown> }
  | { kind: "rust" }
  | { kind: "go" }
  | { kind: "python" }
  | { kind: "shell" };

let prettierLoader: Promise<LoadedPrettier> | null = null;
let rustFmtLoader: Promise<RustFmtModule> | null = null;
let goFmtLoader: Promise<GoFmtModule> | null = null;
let ruffFmtLoader: Promise<RuffFmtModule> | null = null;
let shellFmtLoader: Promise<ShellPrinter> | null = null;

function pluginValue(module: PrettierPluginModule): PrettierPluginModule {
  return "default" in module && module.default && typeof module.default === "object"
    ? (module.default as PrettierPluginModule)
    : module;
}

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
      import("prettier-plugin-toml"),
      import("prettier-plugin-sql"),
    ]).then(([prettier, estree, babel, typescript, html, markdown, postcss, yaml, toml, sql]) => ({
      prettier,
      plugins: [estree, babel, typescript, html, markdown, postcss, yaml, toml, sql].map(
        pluginValue,
      ),
    }));
  }
  return prettierLoader;
}

function loadRustFmt(): Promise<RustFmtModule> {
  if (!rustFmtLoader) rustFmtLoader = import("@scalar/rust-fmt");
  return rustFmtLoader;
}

function loadGoFmt(): Promise<GoFmtModule> {
  if (!goFmtLoader) goFmtLoader = import("@wasm-fmt/gofmt");
  return goFmtLoader;
}

function loadRuffFmt(): Promise<RuffFmtModule> {
  if (!ruffFmtLoader) ruffFmtLoader = import("@wasm-fmt/ruff_fmt");
  return ruffFmtLoader;
}

function loadShellFmt(): Promise<ShellPrinter> {
  if (shellFmtLoader) return shellFmtLoader;
  shellFmtLoader = import("sh-syntax").then((shSyntax: ShSyntaxModule) => {
    // `sh-syntax` 0.6 exposes `getProcessor` rather than the older
    // `processor` export expected by prettier-plugin-sh. Use the library
    // directly so Vite dep optimization doesn't choke on that mismatch.
    const getWasm = () => import("sh-syntax/main.wasm?url").then((m) => fetch(m.default));
    const processor = shSyntax.getProcessor(getWasm);
    return (text: string, options: Record<string, unknown> = {}) =>
      processor(text, { ...options, print: true }) as Promise<string>;
  });
  return shellFmtLoader;
}

function formatterForPath(path: string): LanguageFormatter | null {
  const name = fileBasename(path).toLowerCase();
  const dot = name.lastIndexOf(".");
  const ext = dot >= 0 ? name.slice(dot + 1) : "";

  switch (ext) {
    case "ts":
    case "tsx":
    case "mts":
    case "cts":
      return { kind: "prettier", parser: "typescript" };
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
      return { kind: "prettier", parser: "babel" };
    case "json":
      return { kind: "prettier", parser: "json" };
    case "jsonc":
    case "json5":
      return { kind: "prettier", parser: "json5" };
    case "css":
      return { kind: "prettier", parser: "css" };
    case "scss":
      return { kind: "prettier", parser: "scss" };
    case "less":
      return { kind: "prettier", parser: "less" };
    case "html":
    case "htm":
      return { kind: "prettier", parser: "html" };
    case "vue":
      return { kind: "prettier", parser: "vue" };
    case "md":
    case "markdown":
      return { kind: "prettier", parser: "markdown" };
    case "mdx":
      return { kind: "prettier", parser: "mdx" };
    case "yaml":
    case "yml":
      return { kind: "prettier", parser: "yaml" };
    case "sh":
    case "bash":
    case "zsh":
    case "fish":
      return { kind: "shell" };
    case "toml":
      return { kind: "prettier", parser: "toml" };
    case "sql":
      return { kind: "prettier", parser: "sql", options: { language: "sql" } };
    case "mysql":
      return { kind: "prettier", parser: "sql", options: { language: "mysql" } };
    case "pgsql":
    case "psql":
      return { kind: "prettier", parser: "sql", options: { language: "postgresql" } };
    case "sqlite":
      return { kind: "prettier", parser: "sql", options: { language: "sqlite" } };
    case "mssql":
      return { kind: "prettier", parser: "sql", options: { language: "transactsql" } };
    case "pls":
    case "plsql":
      return { kind: "prettier", parser: "sql", options: { language: "plsql" } };
    case "rs":
      return { kind: "rust" };
    case "go":
      return { kind: "go" };
    case "py":
    case "pyw":
    case "pyi":
      return { kind: "python" };
    default:
      return null;
  }
}

export function formatParserForPath(path: string): string | null {
  const formatter = formatterForPath(path);
  if (!formatter) return null;
  if (formatter.kind === "prettier") return formatter.parser;
  return formatter.kind;
}

export function canFormatPath(path: string): boolean {
  return formatterForPath(path) !== null;
}

export async function formatTextForPath(path: string, text: string): Promise<string> {
  const formatter = formatterForPath(path);
  if (!formatter) {
    throw new Error("当前文件类型暂不支持格式化");
  }

  switch (formatter.kind) {
    case "prettier": {
      const { prettier, plugins } = await loadPrettier();
      return prettier.format(text, {
        parser: formatter.parser,
        filepath: fileBasename(path),
        plugins,
        ...(formatter.options ?? {}),
      });
    }
    case "rust": {
      const rustfmt = await loadRustFmt();
      return rustfmt.format(text, { edition: "2021", styleEdition: "2024" });
    }
    case "go": {
      const gofmt = await loadGoFmt();
      return Promise.resolve(gofmt.format(text));
    }
    case "python": {
      const ruff = await loadRuffFmt();
      return Promise.resolve(ruff.format(text, fileBasename(path)));
    }
    case "shell": {
      const shellfmt = await loadShellFmt();
      return shellfmt(text, { filepath: fileBasename(path) });
    }
  }
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
