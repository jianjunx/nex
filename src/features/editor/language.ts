import type { Extension } from "@codemirror/state";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { rust } from "@codemirror/lang-rust";
import { go } from "@codemirror/lang-go";
import { yaml } from "@codemirror/lang-yaml";
import { vue } from "@codemirror/lang-vue";
import { php } from "@codemirror/lang-php";
import { StreamLanguage } from "@codemirror/language";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { toml } from "@codemirror/legacy-modes/mode/toml";
import {
  c,
  cpp,
  java,
  csharp,
  kotlin,
  scala,
  dart,
  objectiveC,
} from "@codemirror/legacy-modes/mode/clike";
import {
  standardSQL,
  mySQL,
  pgSQL,
  sqlite,
  msSQL,
  plSQL,
} from "@codemirror/legacy-modes/mode/sql";
import { xml } from "@codemirror/legacy-modes/mode/xml";
import { ruby } from "@codemirror/legacy-modes/mode/ruby";
import { swift } from "@codemirror/legacy-modes/mode/swift";
import { lua } from "@codemirror/legacy-modes/mode/lua";
import { r } from "@codemirror/legacy-modes/mode/r";
import { perl } from "@codemirror/legacy-modes/mode/perl";
import { dockerFile } from "@codemirror/legacy-modes/mode/dockerfile";
import { fileBasename } from "./pathUtils";

export function languageExtensionsForPath(path: string): Extension[] {
  const name = fileBasename(path);
  const lowerName = name.toLowerCase();
  // Dockerfile has no extension.
  if (lowerName === "dockerfile" || lowerName.startsWith("dockerfile.")) {
    return [StreamLanguage.define(dockerFile)];
  }
  const dot = name.lastIndexOf(".");
  const ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
  switch (ext) {
    case "ts":
    case "tsx":
    case "mts":
    case "cts":
      return [javascript({ typescript: true, jsx: ext === "tsx" })];
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
      return [javascript({ jsx: ext === "jsx" })];
    case "json":
    case "jsonc":
      return [json()];
    case "css":
    case "scss":
    case "less":
      return [css()];
    case "html":
    case "htm":
    case "svelte":
      return [html()];
    case "vue":
      return [vue()];
    case "php":
    case "phtml":
      return [php()];
    case "md":
    case "markdown":
    case "mdx":
      return [markdown()];
    case "py":
    case "pyw":
    case "pyi":
      return [python()];
    case "rs":
      return [rust()];
    case "go":
      return [go()];
    case "toml":
      return [StreamLanguage.define(toml)];
    case "yml":
    case "yaml":
      return [yaml()];
    case "sh":
    case "bash":
    case "zsh":
    case "fish":
      return [StreamLanguage.define(shell)];
    case "c":
    case "h":
      return [StreamLanguage.define(c)];
    case "cpp":
    case "cc":
    case "cxx":
    case "hpp":
    case "hh":
    case "hxx":
      return [StreamLanguage.define(cpp)];
    case "java":
      return [StreamLanguage.define(java)];
    case "cs":
      return [StreamLanguage.define(csharp)];
    case "kt":
    case "kts":
      return [StreamLanguage.define(kotlin)];
    case "scala":
    case "sc":
      return [StreamLanguage.define(scala)];
    case "dart":
      return [StreamLanguage.define(dart)];
    case "m":
      return [StreamLanguage.define(objectiveC)];
    case "sql":
      return [StreamLanguage.define(standardSQL)];
    case "mysql":
      return [StreamLanguage.define(mySQL)];
    case "pgsql":
    case "psql":
      return [StreamLanguage.define(pgSQL)];
    case "sqlite":
      return [StreamLanguage.define(sqlite)];
    case "mssql":
      return [StreamLanguage.define(msSQL)];
    case "pls":
    case "plsql":
      return [StreamLanguage.define(plSQL)];
    case "xml":
    case "xsl":
    case "xsd":
    case "svg":
      return [StreamLanguage.define(xml)];
    case "rb":
    case "ruby":
      return [StreamLanguage.define(ruby)];
    case "swift":
      return [StreamLanguage.define(swift)];
    case "lua":
      return [StreamLanguage.define(lua)];
    case "r":
      return [StreamLanguage.define(r)];
    case "pl":
    case "pm":
      return [StreamLanguage.define(perl)];
    default:
      return [];
  }
}
