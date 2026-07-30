# 搜索匹配规则与全项目替换 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付 spec F4：全局搜索的大小写/全词/正则匹配规则、按文件分组 + 命中高亮 + 行跳转的结果视图、带预览确认的全项目磁盘替换（含单条/单文件替换），并经既有 fs-changed 链路完成已打开文件的 stale/静默同步。

**Architecture:** Rust 侧把三种匹配语义统一编译为单个 `regex::Regex`（子串＝`regex::escape`、全词＝`\b(?:…)\b` 包裹、大小写＝`(?i)` 前缀），`search()` 增第三参 `Option<SearchOptions>`（None＝现状行为），新增 `search_replace`（只读预览）/`apply_replace`（原子写盘）两个 lib 函数与同名 tauri command；前端 SearchPanel 重构为工具条 + 搜索行（三枚开关）+ 替换行 + 预留过滤行 + 统计条 + 分组结果，行定位经 fs.store 的 `pendingLine` + EditorPanel 既有 `viewRef` 通道完成；`search.focus` 命令经 ui.store 自增计数触发面板聚焦，面板内 Enter/Shift+Enter/Ctrl+Alt+Enter 为本地 keydown。

**Tech Stack:** Rust（regex crate 新增、ignore、serde）+ Tauri 2 commands + React 19 + TypeScript + Zustand(immer/persist) + radix-ui（统一包 `radix-ui` 的 AlertDialog）+ CodeMirror 6（`view.dispatch` + `scrollIntoView`）+ vitest(无 globals，jsdom 需 docblock) + @testing-library/react + pnpm

## Global Constraints

1. 所有面向用户文案为简体中文；代码标识符、文件路径、提交信息 scope 保持英文。
2. 提交信息风格：英文 scope + 中文描述。
3. 门槛三件套 `pnpm lint && pnpm build && pnpm test` 全绿；`pnpm tsc --noEmit` 是 no-op，真实类型门槛是 build；lint 既有 6 条 warning 可接受，不新增 error。
4. 新增 tauri command 四处同步：fs_cmds.rs → lib.rs invoke_handler → bridge/commands.ts 常量 → bridge/tauri.ts 封装；参数 camelCase。
5. vitest 未开 globals：jsdom 文件第 1 行 `/** @vitest-environment jsdom */` docblock + 显式 `afterEach(() => cleanup())`；模块 mock 用模块级可变 let + vi.mock 闭包延迟读取模式。
6. Rust 测试放 `src-tauri/tests/`（现有 fs_test.rs 可扩或新建 search_test.rs，选扩展既有文件以减少新建）。
7. 不新增大型依赖（regex crate 为 spec 指定例外，如缺则加）。

## 既有事实（勘察核对，勿臆测）

- `src-tauri/src/fs/search.rs`：`search(project_path: &Path, query: &str) -> Result<Vec<SearchMatch>, NexError>`，硬编码小写子串；`SearchMatch { path, name, line: Option<u32>, text }`（camelCase serde）；常量 `MAX_RESULTS: usize = 200`（名称+内容合计）、`MAX_CONTENT_FILE_SIZE: u64 = 1MB`、`MAX_LINE_LEN = 200`；过滤 `ignore::WalkBuilder` + hidden + git_ignore + git_exclude；**无测试**。
- `src-tauri/Cargo.toml`：**无 regex**——T1 新增 `regex = "1"`（spec 指定例外）。
- `src-tauri/src/commands/fs_cmds.rs`：`fs_search` 同步薄封装；`fs_write_file` → `fs/write.rs::write_file(path, content)` 同目录临时文件 + rename 原子写。
- `NexError`（`error.rs`）：`FileSystem(String)` 变体够用；用户可见校验类错误用中文（先例 `fs/create.rs:7 "文件已存在: {name}"`）；前端经 `errorMessage()` 解包 `{ type, message }`。
- `src/bridge/tauri.ts`：`fsSearch(projectPath, query)` 在 L291；**`AgentComposer.tsx:115` 是 fsSearch 的第二调用方**（@文件提及），签名必须后向兼容（options 可选、缺省 null＝现状行为）。
- `src/features/search/SearchPanel.tsx`（89 行）：单 Input + 扁平列表 + 300ms 防抖；点击 `openFile(m.path)` **丢弃 m.line**；无分组/统计/高亮/替换。
- `src/stores/fs.store.ts`：`search(projectPath, query)` 内部 trim、错误写**共享 error 槽**（该槽在 EditorPanel 渲染红条——搜索错误不能污染它，本计划新增 `searchError` 独立槽）；`openFile(filePath, pin=false)`，现有调用方含 `openFile(path, true)`（loadEditorState）——line 参必须后向兼容。
- `fs-changed` 链路：watcher 500ms debounce → `syncExternalChange(paths)`：dirty 页签 `stale=true` 黄条、clean 页签静默重读。**替换写盘顺势利用该链路，不抑制 watcher**（spec 指定行为）。
- `src/commands/registry.ts`：`search.focus`（Ctrl+Shift+F）**已注册**，run 目前只 `setSidePanelTab("search")`——T9 改 run，不动键位（registry.test.ts 已断言 `primary+shift+keyf`）。
- `src/commands/KeybindingHost.tsx`：焦点在 input/textarea 时全局分发器让行——面板本地 Enter 不会与全局命令双触发；`Ctrl+Alt+Enter` 不在注册表，无冲突。
- `src/components/ui/` **无 alert-dialog**——T8 基于统一包 `radix-ui`（`import { AlertDialog as AlertDialogPrimitive } from "radix-ui"`，同 dialog.tsx 的用法）新建，样式镜像 dialog.tsx 玻璃语言；不新增依赖。
- `Input`/`Button` 均为 `React.ComponentProps<…>` 透传（React 19 ref 可作为普通 prop），`Input ref=` 与 `size="icon-xs"` 可用。
- 测试基建：`vite.config.ts` 默认 `environment: "node"`、未开 globals；store 测试先例 `fs.store.editor.test.ts`（vi.mock 工厂 + 模块级 vi.fn）；命令 run 测试先例 `registry.run.test.ts`（jsdom docblock + 模块级可变 let + 闭包延迟读取）；全局 CSS 在 `src/styles/globals.css`（233 行，尾部追加）。

## File Structure

| 文件 | 动作 | 职责 |
|---|---|---|
| `src-tauri/Cargo.toml` | Modify | +`regex = "1"` |
| `src-tauri/src/fs/search.rs` | Modify | `SearchOptions` + `compile_pattern` + `search()` 第三参；`ReplaceFilePreview/ReplacePreview/ReplaceResult` + `search_replace`/`apply_replace` |
| `src-tauri/src/commands/fs_cmds.rs` | Modify | `fs_search` 增 options；+`fs_search_replace`/`fs_apply_replace` |
| `src-tauri/src/lib.rs` | Modify | invoke_handler 注册两条新 command |
| `src-tauri/tests/fs_test.rs` | Modify | 搜索四分支 + 组合 + 非法正则；替换预览/写盘/limit/捕获组/上限截断 |
| `src/bridge/commands.ts` | Modify | +`FS_SEARCH_REPLACE`/`FS_APPLY_REPLACE` 常量 |
| `src/bridge/tauri.ts` | Modify | +`SearchOptions/ReplaceFilePreview/ReplacePreview/ReplaceResult` 类型；`fsSearch` 第三参（缺省 null）；+`fsSearchReplace`/`fsApplyReplace` |
| `src/stores/fs.store.ts` | Modify | +`searchOptions/searchError/replacePreview/replacing/pendingLine` 状态；+`setSearchOptions/previewReplace/applyReplace/clearReplacePreview/consumePendingLine`；`openFile` line 参；`search/clearSearch` 改写（searchError 槽） |
| `src/stores/fs.store.search.test.ts` | Create | store 搜索/替换/行定位动作测试 |
| `src/features/editor/EditorPanel.tsx` | Modify | `pendingLine` → `view.dispatch` + `scrollIntoView` 行定位 |
| `src/features/editor/EditorPanel.line.test.tsx` | Create | 行定位三分支（命中/异文件/越界钳制） |
| `src/features/search/SearchPanel.tsx` | Modify(重写) | 工具条/搜索行三开关/非法正则行内错误/预留过滤行/统计条/分组高亮折叠/替换行/确认 dialog/面板快捷键 |
| `src/features/search/searchHighlight.ts` | Create | 前端命中高亮的 JS RegExp 合成 + 区间计算（纯函数） |
| `src/features/search/searchHighlight.test.ts` | Create | 高亮纯函数测试（node 环境） |
| `src/features/search/SearchPanel.test.tsx` | Create | 开关/防抖/非法正则/统计条/工具条 + 聚焦计数/Enter 导航 |
| `src/features/search/SearchPanel.results.test.tsx` | Create | 分组/计数徽标/`<mark>` 高亮/折叠/行跳转 |
| `src/features/search/SearchPanel.replace.test.tsx` | Create | 替换全部流（预览→确认→写盘→重搜）/truncated 文案/单文件/单条 |
| `src/components/ui/alert-dialog.tsx` | Create | shadcn 风格 AlertDialog（radix-ui 统一包，玻璃化） |
| `src/stores/ui.store.ts` | Modify | +`searchFocusRequest` 计数 + `requestSearchFocus()` |
| `src/stores/ui.settings.test.ts` | Modify | +聚焦计数用例 |
| `src/commands/registry.ts` | Modify | `search.focus` run → `requestSearchFocus()` |
| `src/commands/registry.run.test.ts` | Modify | +`search.focus` run 用例（mock 增补 requestSearchFocus） |
| `src/styles/globals.css` | Modify | +stagger 渐显 keyframe + 组折叠 grid-rows 过渡类 |

---

### Task 1: 后端 SearchOptions + search 改造（TDD）

**Files:**
- Modify: `src-tauri/Cargo.toml`（+regex）
- Modify: `src-tauri/src/fs/search.rs`（SearchOptions + compile_pattern + search 第三参）
- Modify: `src-tauri/src/commands/fs_cmds.rs`（fs_search 签名）
- Modify: `src-tauri/tests/fs_test.rs`（+6 测试）

**Interfaces:**
- Produces: `nex_lib::fs::search::{SearchOptions, compile_pattern, search}`——契约如下，T2/T3 逐字依赖：
  ```rust
  #[derive(Debug, Clone, Copy, Default, Deserialize)]
  #[serde(rename_all = "camelCase")]
  pub struct SearchOptions {
      #[serde(default)] pub case_sensitive: bool,
      #[serde(default)] pub whole_word: bool,
      #[serde(default)] pub regex: bool,
  }
  pub fn compile_pattern(query: &str, options: &SearchOptions) -> Result<regex::Regex, NexError>;
  pub fn search(project_path: &Path, query: &str, options: Option<SearchOptions>) -> Result<Vec<SearchMatch>, NexError>;
  ```
- Consumes: `regex` crate、既有 `ignore::WalkBuilder` 过滤、`NexError::FileSystem`。
- 非法正则错误文案**逐字**：`无效的正则表达式: {query}`（NexError::FileSystem，中文，用户可见校验类）。

- [ ] **Step 1: 先写测试（红）**——在 `src-tauri/tests/fs_test.rs` 末尾追加：

```rust
// ---- Plan 5: search options -----------------------------------------
use nex_lib::fs::search::{compile_pattern, search, SearchOptions};

fn opts(case_sensitive: bool, whole_word: bool, regex: bool) -> SearchOptions {
    SearchOptions { case_sensitive, whole_word, regex }
}

fn search_fixture(dir: &std::path::Path) {
    fs::create_dir_all(dir.join("src")).unwrap();
    fs::write(dir.path().join("src/app.ts"), "const Foo = 1;\nlet foo = 2;\nlet food = 3;\n").unwrap();
    fs::write(dir.path().join("notes.txt"), "foo cat concat\nFoo Cat\n").unwrap();
    fs::write(dir.path().join("foo.md"), "readme\n").unwrap();
}

#[test]
fn test_search_default_is_case_insensitive_substring() {
    let dir = tempdir().unwrap();
    search_fixture(dir.path());
    let results = search(dir.path(), "foo", None).unwrap();
    // foo.md 名称命中（line=None）；app.ts 3 行内容命中；notes.txt 2 行。
    assert!(results.iter().any(|m| m.name == "foo.md" && m.line.is_none()));
    let content_hits: Vec<_> = results.iter().filter(|m| m.line.is_some()).collect();
    assert_eq!(content_hits.len(), 5);
}

#[test]
fn test_search_case_sensitive() {
    let dir = tempdir().unwrap();
    search_fixture(dir.path());
    let results = search(dir.path(), "Foo", Some(opts(true, false, false))).unwrap();
    let content_hits: Vec<_> = results.iter().filter(|m| m.line.is_some()).collect();
    // app.ts "const Foo = 1;" + notes.txt "Foo Cat"
    assert_eq!(content_hits.len(), 2);
    // 小写文件名 foo.md 不得命中大小写敏感的 "Foo"
    assert!(!results.iter().any(|m| m.name == "foo.md"));
}

#[test]
fn test_search_whole_word_excludes_substrings() {
    let dir = tempdir().unwrap();
    search_fixture(dir.path());
    let results = search(dir.path(), "cat", Some(opts(false, true, false))).unwrap();
    let texts: Vec<_> = results.iter().filter_map(|m| m.line.map(|_| m.text.clone())).collect();
    // "foo cat concat"（独立词 cat）与 "Foo Cat"（大小写不敏感）；concat 内的 cat 不算
    assert_eq!(texts.len(), 2);
    assert!(texts.iter().all(|t| t.to_lowercase().contains(" cat")));
}

#[test]
fn test_search_regex_mode() {
    let dir = tempdir().unwrap();
    search_fixture(dir.path());
    // 大小写敏感正则：仅 "const Foo = 1;"（"let foo = 2;" 小写不中，"food" 其后非空白不中）
    let results = search(dir.path(), r"Foo\s*=\s*\d", Some(opts(true, false, true))).unwrap();
    let texts: Vec<_> = results.iter().filter_map(|m| m.line.map(|_| m.text.clone())).collect();
    assert_eq!(texts.len(), 1);
    assert!(texts[0].contains("const Foo = 1;"));
}

#[test]
fn test_search_options_combine() {
    let dir = tempdir().unwrap();
    search_fixture(dir.path());
    // 大小写敏感 + 全词 "Foo"：仅 "const Foo = 1;" 与 "Foo Cat"
    let results = search(dir.path(), "Foo", Some(opts(true, true, false))).unwrap();
    let content_hits: Vec<_> = results.iter().filter(|m| m.line.is_some()).collect();
    assert_eq!(content_hits.len(), 2);
}

#[test]
fn test_search_invalid_regex_is_validation_error() {
    let dir = tempdir().unwrap();
    search_fixture(dir.path());
    let err = search(dir.path(), "[unclosed", Some(opts(false, false, true))).unwrap_err();
    let msg = format!("{err}");
    assert!(msg.contains("无效的正则表达式"), "unexpected: {msg}");
    assert!(msg.contains("[unclosed"));
    // compile_pattern 同样可直测
    assert!(compile_pattern("(", &opts(false, false, true)).is_err());
}
```

运行 `cargo test --manifest-path src-tauri/Cargo.toml --test fs_test`——应编译失败（无 `SearchOptions`）或红。

- [ ] **Step 2: 加 regex 依赖**——`src-tauri/Cargo.toml` 的 `[dependencies]` 段 `ignore = "0.4"` 行之后插入：

```toml
regex = "1"
```

- [ ] **Step 3: 实现 search.rs 改造**——将 `src-tauri/src/fs/search.rs` 全文替换为：

```rust
use ignore::WalkBuilder;
use serde::{Deserialize, Serialize};
use std::path::Path;
use crate::error::NexError;

/// One search hit. `line` is `None` for file-name matches and `Some(n)`
/// (1-based) for content matches; `text` is the matched line (trimmed,
/// truncated) or the file name respectively.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchMatch {
    pub path: String,
    pub name: String,
    pub line: Option<u32>,
    pub text: String,
}

/// Match-rule toggles shared by search and replace. All false = the
/// historical behavior: case-insensitive substring matching. Serialized
/// camelCase (`caseSensitive` / `wholeWord` / `regex`) per bridge contract.
#[derive(Debug, Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchOptions {
    #[serde(default)]
    pub case_sensitive: bool,
    #[serde(default)]
    pub whole_word: bool,
    #[serde(default)]
    pub regex: bool,
}

/// Total matches returned per query (name + content combined). Replace
/// previews and writes honor the SAME budget (spec: 替换同受约束).
const MAX_RESULTS: usize = 200;
/// Files larger than this are skipped for content search (name still matches).
const MAX_CONTENT_FILE_SIZE: u64 = 1024 * 1024;
/// Matched lines are truncated to this many characters.
const MAX_LINE_LEN: usize = 200;

/// Compile query + options into one `regex::Regex`: plain queries become
/// `regex::escape(query)`; whole-word wraps `\b(?:…)\b`; case-insensitivity
/// prepends `(?i)`. The three compose naturally in that order. An invalid
/// pattern is a user-visible validation error (Chinese, like fs/create.rs).
pub fn compile_pattern(query: &str, options: &SearchOptions) -> Result<regex::Regex, NexError> {
    let inner = if options.regex {
        query.to_string()
    } else {
        regex::escape(query)
    };
    let inner = if options.whole_word {
        format!("\\b(?:{})\\b", inner)
    } else {
        inner
    };
    let pattern = if options.case_sensitive {
        inner
    } else {
        format!("(?i){}", inner)
    };
    regex::Regex::new(&pattern)
        .map_err(|_| NexError::FileSystem(format!("无效的正则表达式: {}", query)))
}

/// Project-wide search over file names and content, honoring `SearchOptions`
/// (None = default = case-insensitive substring — the historical behavior).
/// Matching is LINE-based: multiline constructs (`\n`, `(?s)`) cannot span
/// lines — documented v1 limitation. Honors .gitignore/.git_exclude/hidden,
/// skips non-UTF-8 and >1MB files for content matching (names still match).
pub fn search(
    project_path: &Path,
    query: &str,
    options: Option<SearchOptions>,
) -> Result<Vec<SearchMatch>, NexError> {
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let opts = options.unwrap_or_default();
    let re = compile_pattern(query, &opts)?;
    let mut results = Vec::new();
    let walker = WalkBuilder::new(project_path)
        .hidden(true) // skip dotfiles/dirs (notably .git)
        .git_ignore(true)
        .git_exclude(true)
        .build();

    for entry in walker.flatten() {
        if results.len() >= MAX_RESULTS {
            break;
        }
        let path = entry.path();
        if path == project_path {
            continue;
        }
        let Ok(metadata) = entry.metadata() else { continue };
        if !metadata.is_file() {
            continue;
        }
        let name = path.file_name().unwrap_or_default().to_string_lossy().to_string();
        let path_str = path.to_string_lossy().to_string();

        if re.is_match(&name) {
            results.push(SearchMatch { path: path_str, name, line: None, text: String::new() });
            continue;
        }

        if metadata.len() > MAX_CONTENT_FILE_SIZE {
            continue;
        }
        // Non-UTF-8 (binary) files fail to read as text and are skipped.
        let Ok(content) = std::fs::read_to_string(path) else { continue };
        for (idx, line) in content.lines().enumerate() {
            if results.len() >= MAX_RESULTS {
                break;
            }
            if re.is_match(line) {
                results.push(SearchMatch {
                    path: path_str.clone(),
                    name: name.clone(),
                    line: Some(idx as u32 + 1),
                    text: line.trim().chars().take(MAX_LINE_LEN).collect(),
                });
            }
        }
    }

    Ok(results)
}
```

- [ ] **Step 4: 同步 fs_cmds.rs**——`src-tauri/src/commands/fs_cmds.rs`：

把 `use crate::fs::search::{SearchMatch, search};` 改为：

```rust
use crate::fs::search::{SearchMatch, SearchOptions, search};
```

把 `fs_search` 整块改为：

```rust
/// Global project search with match rules (case / whole-word / regex).
/// `options = None` keeps the historical case-insensitive substring behavior.
#[tauri::command]
pub fn fs_search(project_path: String, query: String, options: Option<SearchOptions>) -> Result<Vec<SearchMatch>, NexError> {
    search(Path::new(&project_path), &query, options)
}
```

（invoke_handler 中 `fs_search` 已注册，签名变更无需动 lib.rs。）

- [ ] **Step 5: 跑绿**——`cargo test --manifest-path src-tauri/Cargo.toml --test fs_test`，6 条新用例 + 既有 2 条全绿。

- [ ] **Step 6: 提交**——`feat(search): 后端搜索支持大小写/全词/正则匹配选项`

---

### Task 2: 后端 search_replace 预览 + apply_replace 写盘（TDD）

**Files:**
- Modify: `src-tauri/src/fs/search.rs`（追加类型 + replace_candidates + search_replace + apply_replace）
- Modify: `src-tauri/src/commands/fs_cmds.rs`（+2 command）
- Modify: `src-tauri/src/lib.rs`（invoke_handler +2 行）
- Modify: `src-tauri/tests/fs_test.rs`（+7 测试）

**Interfaces:**
- Produces（契约逐字，T3 桥接依赖）：
  ```rust
  #[derive(Debug, Clone, Serialize)] #[serde(rename_all = "camelCase")]
  pub struct ReplaceFilePreview { pub path: String, pub count: usize }

  #[derive(Debug, Clone, Serialize)] #[serde(rename_all = "camelCase")]
  pub struct ReplacePreview { pub files: Vec<ReplaceFilePreview>, pub total: usize, pub truncated: bool }

  #[derive(Debug, Clone, Serialize)] #[serde(rename_all = "camelCase")]
  pub struct ReplaceResult { pub files_changed: usize, pub replacements: usize }

  pub fn search_replace(project_path: &Path, query: &str, replacement: &str, options: Option<SearchOptions>) -> Result<ReplacePreview, NexError>;
  pub fn apply_replace(project_path: &Path, query: &str, replacement: &str, options: Option<SearchOptions>, paths: Option<Vec<String>>, limit_per_file: Option<usize>) -> Result<ReplaceResult, NexError>;
  ```
- 语义裁定（写入实现，不再论证）：
  - 预览不写盘；沿用 `MAX_RESULTS` 预算——预览与写盘共用同一预算，故「预览截断」与「实际写入量」恒一致；`truncated=true` 表示超出上限的文件未被遍历。
  - `paths = Some(list)` 限定文件范围（单文件替换传一元列表）；`limit_per_file = Some(1)` ＝「该文件内首个匹配」（单条替换语义）。
  - replacement 字符串**原样透传** `regex::Captures::expand`，原生支持 `$1`/`${name}` 捕获组（regex crate 语义；字面 `$` 亦按 crate 语义解释）。
  - 替换只作用于**文件内容**；文件名命中不参与替换。
  - 非 UTF-8 / >1MB 文件跳过（同搜索约束）。
  - **写盘失败不致命、不回滚**：apply_replace 遍历全部候选文件，个别写盘失败（只读/被占用）收集而不中断；若有失败，末尾返回 `NexError::FileSystem`，消息含已改文件数、失败文件数与首个原因（中文）。成功路径契约不变。部分失败路径的集成测试因 OS 相关（io 故障注入）延后，代码层 collect+continue 为准。
  - **正则模式面差异（v1 已知限制）**：搜索逐行匹配（`is_match(line)`），替换预览/写盘逐全文匹配（`find_iter`/`replace_all`）。跨行构造（`\n`）与行尾锚定（CRLF 下的 `$`）可能出现「预览/写盘有命中而搜索结果列表不显示」。子串/全词模式两面一致、不受影响；替换确认 dialog 无需特殊文案（错误经 searchError 槽显示）。

- [ ] **Step 1: 先写测试（红）**——在 `src-tauri/tests/fs_test.rs` 末尾追加（复用 T1 的 `opts`/`search_fixture`）：

```rust
// ---- Plan 5: search & replace (disk) --------------------------------
use nex_lib::fs::search::{apply_replace, search_replace};

#[test]
fn test_search_replace_preview_counts_without_writing() {
    let dir = tempdir().unwrap();
    search_fixture(dir.path());
    let preview = search_replace(dir.path(), "foo", "bar", None).unwrap();
    // app.ts: Foo/foo/food = 3; notes.txt: foo/Foo = 2; foo.md 名称命中不计
    assert_eq!(preview.total, 5);
    assert!(!preview.truncated);
    assert_eq!(preview.files.len(), 2);
    let app = preview.files.iter().find(|f| f.path.ends_with("app.ts")).unwrap();
    assert_eq!(app.count, 3);
    // 预览不得写盘
    assert!(fs::read_to_string(dir.path().join("src/app.ts")).unwrap().contains("const Foo = 1;"));
}

#[test]
fn test_apply_replace_writes_all_matches() {
    let dir = tempdir().unwrap();
    search_fixture(dir.path());
    let result = apply_replace(dir.path(), "foo", "bar", None, None, None).unwrap();
    assert_eq!(result.files_changed, 2);
    assert_eq!(result.replacements, 5);
    let app = fs::read_to_string(dir.path().join("src/app.ts")).unwrap();
    assert!(app.contains("const bar = 1;"));
    assert!(app.contains("let bar = 2;"));
    assert!(app.contains("let bard = 3;"));
    let notes = fs::read_to_string(dir.path().join("notes.txt")).unwrap();
    assert!(notes.contains("bar cat concat"));
    assert!(notes.contains("bar Cat"));
    // foo.md 仅名称命中，内容不得被改
    assert_eq!(fs::read_to_string(dir.path().join("foo.md")).unwrap(), "readme\n");
}

#[test]
fn test_apply_replace_single_file_scope() {
    let dir = tempdir().unwrap();
    search_fixture(dir.path());
    let only = dir.path().join("notes.txt").to_string_lossy().to_string();
    let result = apply_replace(dir.path(), "foo", "bar", None, Some(vec![only]), None).unwrap();
    assert_eq!(result.files_changed, 1);
    assert_eq!(result.replacements, 2);
    assert!(fs::read_to_string(dir.path().join("src/app.ts")).unwrap().contains("const Foo = 1;"));
}

#[test]
fn test_apply_replace_limit_per_file_replaces_first_only() {
    let dir = tempdir().unwrap();
    search_fixture(dir.path());
    let only = dir.path().join("src/app.ts").to_string_lossy().to_string();
    let result = apply_replace(dir.path(), "foo", "bar", None, Some(vec![only]), Some(1)).unwrap();
    assert_eq!(result.files_changed, 1);
    assert_eq!(result.replacements, 1);
    let app = fs::read_to_string(dir.path().join("src/app.ts")).unwrap();
    // 首个匹配（第 1 行 "Foo"）被替换，其余保留
    assert!(app.contains("const bar = 1;"));
    assert!(app.contains("let foo = 2;"));
    assert!(app.contains("let food = 3;"));
}

#[test]
fn test_apply_replace_supports_capture_groups() {
    let dir = tempdir().unwrap();
    fs::write(dir.path().join("users.txt"), "alice@corp bob@corp\n").unwrap();
    let result = apply_replace(
        dir.path(),
        r"(\w+)@(\w+)",
        "$2/$1",
        Some(opts(false, false, true)),
        None,
        None,
    ).unwrap();
    assert_eq!(result.files_changed, 1);
    assert_eq!(result.replacements, 2);
    assert_eq!(fs::read_to_string(dir.path().join("users.txt")).unwrap(), "corp/alice corp/bob\n");
}

#[test]
fn test_replace_honors_max_results_budget() {
    let dir = tempdir().unwrap();
    // 单文件 250 行命中 → 上限 200，truncated
    let body: String = (0..250).map(|i| format!("needle line {i}\n")).collect();
    fs::write(dir.path().join("big.txt"), body).unwrap();

    let preview = search_replace(dir.path(), "needle", "hit", None).unwrap();
    assert_eq!(preview.total, 200);
    assert!(preview.truncated);
    assert_eq!(preview.files[0].count, 200);

    // 写盘受同一预算约束：恰好替换前 200 处
    let result = apply_replace(dir.path(), "needle", "hit", None, None, None).unwrap();
    assert_eq!(result.files_changed, 1);
    assert_eq!(result.replacements, 200);
    let content = fs::read_to_string(dir.path().join("big.txt")).unwrap();
    assert_eq!(content.lines().filter(|l| l.starts_with("hit line")).count(), 200);
    assert_eq!(content.lines().filter(|l| l.starts_with("needle line")).count(), 50);
}

#[test]
fn test_apply_replace_invalid_regex_is_validation_error() {
    let dir = tempdir().unwrap();
    search_fixture(dir.path());
    let err = apply_replace(dir.path(), "(broken", "x", Some(opts(false, false, true)), None, None).unwrap_err();
    assert!(format!("{err}").contains("无效的正则表达式"));
    let err = search_replace(dir.path(), "(broken", "x", Some(opts(false, false, true))).unwrap_err();
    assert!(format!("{err}").contains("无效的正则表达式"));
}
```

- [ ] **Step 2: 实现**——在 `src-tauri/src/fs/search.rs` 顶部 `use crate::error::NexError;` 之后加一行：

```rust
use crate::fs::write::write_file;
```

并在文件末尾追加：

```rust
/// One file's replacement tally in a preview.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceFilePreview {
    pub path: String,
    pub count: usize,
}

/// Project-wide replace PREVIEW — computed without touching disk.
/// `truncated` = the MAX_RESULTS budget ran out; unvisited files beyond the
/// cap may contain further matches. apply_replace spends the same budget,
/// so what the preview promises is what the write delivers.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplacePreview {
    pub files: Vec<ReplaceFilePreview>,
    pub total: usize,
    pub truncated: bool,
}

/// Outcome of a written replace.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceResult {
    pub files_changed: usize,
    pub replacements: usize,
}

/// Candidate files for replace: regular files within the size cap, honoring
/// the same hidden/.gitignore filters as `search`. (Name-only matches are
/// never replaceable — replace targets file CONTENT.)
fn replace_candidates(project_path: &Path) -> Vec<std::path::PathBuf> {
    let mut out = Vec::new();
    let walker = WalkBuilder::new(project_path)
        .hidden(true)
        .git_ignore(true)
        .git_exclude(true)
        .build();
    for entry in walker.flatten() {
        let path = entry.path();
        if path == project_path {
            continue;
        }
        let Ok(metadata) = entry.metadata() else { continue };
        if !metadata.is_file() || metadata.len() > MAX_CONTENT_FILE_SIZE {
            continue;
        }
        out.push(path.to_path_buf());
    }
    out
}

/// Preview per-file replacement counts WITHOUT writing.
pub fn search_replace(
    project_path: &Path,
    query: &str,
    replacement: &str,
    options: Option<SearchOptions>,
) -> Result<ReplacePreview, NexError> {
    let _ = replacement; // preview only counts; the text matters at apply time
    if query.is_empty() {
        return Ok(ReplacePreview { files: Vec::new(), total: 0, truncated: false });
    }
    let opts = options.unwrap_or_default();
    let re = compile_pattern(query, &opts)?;
    let mut files = Vec::new();
    let mut total = 0usize;
    let mut truncated = false;

    for path in replace_candidates(project_path) {
        let budget = MAX_RESULTS - total; // > 0 while the loop runs
        let Ok(content) = std::fs::read_to_string(&path) else { continue };
        let full = re.find_iter(&content).count();
        let add = full.min(budget);
        if full > add {
            truncated = true;
        }
        if add > 0 {
            files.push(ReplaceFilePreview {
                path: path.to_string_lossy().to_string(),
                count: add,
            });
            total += add;
        }
        if total >= MAX_RESULTS {
            truncated = true;
            break;
        }
    }

    Ok(ReplacePreview { files, total, truncated })
}

/// Write the replace to disk via the atomic writer in fs/write.rs.
/// - `paths = Some(list)` restricts the operation to those files (the UI's
///   per-file replace passes a one-element list);
/// - `limit_per_file = Some(n)` caps replacements per file — `Some(1)` is the
///   "first match in this file" single-replace semantics;
/// - the shared MAX_RESULTS budget keeps capped previews and writes in sync;
/// - `replacement` is passed through `Captures::expand`, so `$1`/`${name}`
///   capture-group backreferences work (regex crate semantics).
/// - write failures are collected, not fatal: every candidate is attempted,
///   and if any writes failed the function returns `NexError::FileSystem`
///   whose message reports files changed vs failed (no rollback — files
///   already written stay written).
pub fn apply_replace(
    project_path: &Path,
    query: &str,
    replacement: &str,
    options: Option<SearchOptions>,
    paths: Option<Vec<String>>,
    limit_per_file: Option<usize>,
) -> Result<ReplaceResult, NexError> {
    if query.is_empty() {
        return Ok(ReplaceResult { files_changed: 0, replacements: 0 });
    }
    let opts = options.unwrap_or_default();
    let re = compile_pattern(query, &opts)?;
    let per_file = limit_per_file.unwrap_or(usize::MAX);
    let mut budget = MAX_RESULTS;
    let mut files_changed = 0usize;
    let mut replacements = 0usize;
    let mut failures: Vec<String> = Vec::new();

    for path in replace_candidates(project_path) {
        if budget == 0 {
            break;
        }
        let path_str = path.to_string_lossy().to_string();
        if let Some(only) = &paths {
            if !only.iter().any(|p| p == &path_str) {
                continue;
            }
        }
        let Ok(content) = std::fs::read_to_string(&path) else { continue };
        let cap = per_file.min(budget);
        let mut remaining = cap;
        let mut count = 0usize;
        let replaced = re.replace_all(&content, |caps: &regex::Captures| {
            if remaining == 0 {
                // Beyond the cap: keep the original match text verbatim.
                return caps.get(0).map_or(String::new(), |m| m.as_str().to_string());
            }
            remaining -= 1;
            count += 1;
            let mut dst = String::new();
            caps.expand(replacement, &mut dst);
            dst
        });
        if count > 0 {
            match write_file(&path, &replaced) {
                Ok(()) => {
                    files_changed += 1;
                    replacements += count;
                    budget -= count;
                }
                Err(e) => {
                    // 不中断、不回滚：收集失败，继续写其余文件，末尾汇总报错
                    failures.push(format!("{}: {e}", path.display()));
                }
            }
        }
    }

    if !failures.is_empty() {
        return Err(NexError::FileSystem(format!(
            "替换部分完成：已修改 {} 个文件，{} 个文件写入失败（首个原因：{}）",
            files_changed,
            failures.len(),
            failures[0]
        )));
    }

    Ok(ReplaceResult { files_changed, replacements })
}
```

- [ ] **Step 3: 注册 command（四处同步 ①②）**——`src-tauri/src/commands/fs_cmds.rs`：

把 T1 的 `use crate::fs::search::{SearchMatch, SearchOptions, search};` 改为：

```rust
use crate::fs::search::{SearchMatch, SearchOptions, ReplacePreview, ReplaceResult, search, search_replace, apply_replace};
```

在 `fs_search` 之后追加：

```rust
/// Project-wide replace PREVIEW: per-file replacement counts, writes nothing.
/// Honors the same MAX_RESULTS/.gitignore/size constraints as search.
#[tauri::command]
pub fn fs_search_replace(project_path: String, query: String, replacement: String, options: Option<SearchOptions>) -> Result<ReplacePreview, NexError> {
    search_replace(Path::new(&project_path), &query, &replacement, options)
}

/// Project-wide replace: writes to disk atomically (fs/write.rs).
/// `paths` limits the scope to explicit files (single-file replace);
/// `limit_per_file` caps replacements per file (single-match = Some(1)).
/// After the write, the existing fs-changed watcher syncs open editors
/// (clean → silent reload, dirty → stale banner) — intentionally not
/// suppressed.
#[tauri::command]
pub fn fs_apply_replace(project_path: String, query: String, replacement: String, options: Option<SearchOptions>, paths: Option<Vec<String>>, limit_per_file: Option<usize>) -> Result<ReplaceResult, NexError> {
    apply_replace(Path::new(&project_path), &query, &replacement, options, paths, limit_per_file)
}
```

`src-tauri/src/lib.rs` 的 invoke_handler 中，`commands::fs_cmds::fs_search,` 行之后插入两行：

```rust
            commands::fs_cmds::fs_search_replace,
            commands::fs_cmds::fs_apply_replace,
```

- [ ] **Step 4: 跑绿**——`cargo test --manifest-path src-tauri/Cargo.toml --test fs_test` 全绿（T1 6 条 + 本任务 7 条 + 既有 2 条 = 15）。

- [ ] **Step 5: 提交**——`feat(search): 新增全项目替换预览与写盘命令`

---

### Task 3: 桥接层（commands.ts + tauri.ts）

**Files:**
- Modify: `src/bridge/commands.ts`
- Modify: `src/bridge/tauri.ts`

**Interfaces:**
- Produces（契约逐字，T4 起前端统一消费）：
  ```ts
  export interface SearchOptions { caseSensitive: boolean; wholeWord: boolean; regex: boolean }
  export interface ReplaceFilePreview { path: string; count: number }
  export interface ReplacePreview { files: ReplaceFilePreview[]; total: number; truncated: boolean }
  export interface ReplaceResult { filesChanged: number; replacements: number }

  export async function fsSearch(projectPath: string, query: string, options?: SearchOptions | null): Promise<SearchMatch[]>;
  export async function fsSearchReplace(projectPath: string, query: string, replacement: string, options?: SearchOptions | null): Promise<ReplacePreview>;
  export async function fsApplyReplace(projectPath: string, query: string, replacement: string, options?: SearchOptions | null, paths?: string[] | null, limitPerFile?: number | null): Promise<ReplaceResult>;
  ```
- 后向兼容：`fsSearch` 第三参缺省 `null`——**`AgentComposer.tsx:115` 的既有两参调用不动**（@文件提及保持大小写不敏感子串行为）。
- Rust 侧 `Option<SearchOptions>` 对 JSON `null` 反序列化为 `None`；Tauri 2 自动把 JS 参数名 camelCase 映射到 snake_case 形参（`limitPerFile` → `limit_per_file`）。
- 本任务无独立测试：纯透传封装，行为由 T4 store 测试（mock 桥接断言调用参数）与 `pnpm build` 的类型检查覆盖。

- [ ] **Step 1: commands.ts 常量（四处同步 ③）**——`src/bridge/commands.ts` 的 FS 段 `FS_SEARCH: "fs_search",` 行之后插入：

```ts
  FS_SEARCH_REPLACE: "fs_search_replace",
  FS_APPLY_REPLACE: "fs_apply_replace",
```

- [ ] **Step 2: tauri.ts 类型与封装（四处同步 ④）**——`src/bridge/tauri.ts`：

把现有的 `fsSearch` 整块（含其上 `SearchMatch` 接口）替换为：

```ts
export interface SearchMatch {
  path: string;
  name: string;
  line: number | null;
  text: string;
}

/** Match-rule toggles; all false = case-insensitive substring (the default). */
export interface SearchOptions {
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
}

/** Per-file replacement count in a preview (no disk writes). */
export interface ReplaceFilePreview {
  path: string;
  count: number;
}

export interface ReplacePreview {
  files: ReplaceFilePreview[];
  total: number;
  /** MAX_RESULTS budget exhausted — files beyond the cap were not visited. */
  truncated: boolean;
}

export interface ReplaceResult {
  filesChanged: number;
  replacements: number;
}

export async function fsSearch(projectPath: string, query: string, options: SearchOptions | null = null): Promise<SearchMatch[]> {
  return invoke(COMMANDS.FS_SEARCH, { projectPath, query, options });
}

export async function fsSearchReplace(
  projectPath: string,
  query: string,
  replacement: string,
  options: SearchOptions | null = null,
): Promise<ReplacePreview> {
  return invoke(COMMANDS.FS_SEARCH_REPLACE, { projectPath, query, replacement, options });
}

export async function fsApplyReplace(
  projectPath: string,
  query: string,
  replacement: string,
  options: SearchOptions | null = null,
  paths: string[] | null = null,
  limitPerFile: number | null = null,
): Promise<ReplaceResult> {
  return invoke(COMMANDS.FS_APPLY_REPLACE, { projectPath, query, replacement, options, paths, limitPerFile });
}
```

- [ ] **Step 3: 类型门槛**——`pnpm build`（真实类型门槛；`pnpm tsc --noEmit` 是 no-op 勿用）。`AgentComposer.tsx` 的两参 `fsSearch(project.path, atQuery)` 调用必须编译通过（缺省参数生效）。

- [ ] **Step 4: 提交**——`feat(bridge): 桥接搜索选项与替换命令`

---

### Task 4: fs.store 扩展（搜索选项 / 替换动作 / 行定位状态，TDD）

**Files:**
- Modify: `src/stores/fs.store.ts`
- Create: `src/stores/fs.store.search.test.ts`

**Interfaces:**
- Produces（契约逐字，T5–T9 消费）：
  ```ts
  export type PendingLine = { path: string; line: number };
  export type OpenFileOptions = { pin?: boolean; line?: number };

  // 新增 state
  searchOptions: SearchOptions;                    // 初值 { caseSensitive: false, wholeWord: false, regex: false }
  searchError: string | null;                      // 搜索/替换专属错误槽（不污染 EditorPanel 渲染的共享 error）
  replacePreview: ReplacePreview | null;
  replacing: boolean;
  pendingLine: PendingLine | null;

  // 新增 actions
  setSearchOptions: (patch: Partial<SearchOptions>) => void;
  previewReplace: (projectPath: string, query: string, replacement: string) => Promise<void>;
  applyReplace: (projectPath: string, query: string, replacement: string, scope?: { paths?: string[]; limitPerFile?: number }) => Promise<ReplaceResult | null>;
  clearReplacePreview: () => void;
  consumePendingLine: () => PendingLine | null;    // 读出即清空，供 EditorPanel 一次性消费

  // 签名变更（后向兼容）
  openFile: (filePath: string, opts?: boolean | OpenFileOptions) => Promise<void>;
  // search / clearSearch 签名不变；内部改：fsSearch 带 get().searchOptions；错误写 searchError
  ```
- `searchError` 独立于共享 `error`：共享 error 槽在 EditorPanel 渲染红条，正则校验错误不应出现在那里。
- persist 的 `partialize` 只存 `editorLayoutByProject`——新字段皆临时态，无需改动。

- [ ] **Step 1: 先写测试（红）**——创建 `src/stores/fs.store.search.test.ts`：

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const fsReadFile = vi.fn();
const fsSearch = vi.fn();
const fsSearchReplace = vi.fn();
const fsApplyReplace = vi.fn();
const fsWriteFile = vi.fn();
const setEditorVisible = vi.fn();

vi.mock("../bridge/tauri", () => ({
  fsReadFile: (...args: unknown[]) => fsReadFile(...args),
  fsWriteFile: (...args: unknown[]) => fsWriteFile(...args),
  fsSearch: (...args: unknown[]) => fsSearch(...args),
  fsSearchReplace: (...args: unknown[]) => fsSearchReplace(...args),
  fsApplyReplace: (...args: unknown[]) => fsApplyReplace(...args),
  fsReadTree: vi.fn(),
  fsExpandDir: vi.fn(),
  fsCreateFile: vi.fn(),
  fsCreateDir: vi.fn(),
}));

vi.mock("./ui.store", () => ({
  useUiStore: { getState: () => ({ setEditorVisible }) },
}));

let editorAutoSave = false;
vi.mock("./settings.store", () => ({
  useSettingsStore: { getState: () => ({ editorAutoSave }) },
}));

import { clearAllAutoSaveTimers, useFsStore } from "./fs.store";

beforeEach(() => {
  vi.clearAllMocks();
  editorAutoSave = false;
  clearAllAutoSaveTimers();
  useFsStore.setState({
    openFiles: [],
    activePath: null,
    error: null,
    loading: false,
    searchResults: [],
    searching: false,
    searchError: null,
    searchOptions: { caseSensitive: false, wholeWord: false, regex: false },
    replacePreview: null,
    replacing: false,
    pendingLine: null,
  });
});

describe("search options", () => {
  it("setSearchOptions merges a partial patch", () => {
    useFsStore.getState().setSearchOptions({ caseSensitive: true });
    expect(useFsStore.getState().searchOptions).toEqual({
      caseSensitive: true,
      wholeWord: false,
      regex: false,
    });
  });

  it("search forwards the stored options (camelCase) to the bridge", async () => {
    useFsStore.getState().setSearchOptions({ wholeWord: true });
    fsSearch.mockResolvedValueOnce([]);
    await useFsStore.getState().search("/proj", " foo ");
    expect(fsSearch).toHaveBeenCalledWith("/proj", "foo", {
      caseSensitive: false,
      wholeWord: true,
      regex: false,
    });
  });

  it("blank query clears results without calling the bridge", async () => {
    await useFsStore.getState().search("/proj", "   ");
    expect(fsSearch).not.toHaveBeenCalled();
    expect(useFsStore.getState().searchResults).toEqual([]);
    expect(useFsStore.getState().searching).toBe(false);
  });

  it("bridge rejection lands in searchError, not the shared error slot", async () => {
    useFsStore.getState().setSearchOptions({ regex: true });
    fsSearch.mockRejectedValueOnce({ type: "FileSystem", message: "无效的正则表达式: [" });
    await useFsStore.getState().search("/proj", "[");
    expect(useFsStore.getState().searchError).toBe("无效的正则表达式: [");
    expect(useFsStore.getState().error).toBeNull();
    expect(useFsStore.getState().searching).toBe(false);
  });

  it("clearSearch resets results, flag and search error", async () => {
    fsSearch.mockRejectedValueOnce(new Error("boom"));
    await useFsStore.getState().search("/proj", "x");
    expect(useFsStore.getState().searchError).toBeTruthy();
    useFsStore.getState().clearSearch();
    const s = useFsStore.getState();
    expect(s.searchResults).toEqual([]);
    expect(s.searchError).toBeNull();
    expect(s.searching).toBe(false);
  });
});

describe("replace preview / apply", () => {
  it("previewReplace stores the backend preview", async () => {
    const preview = { files: [{ path: "/proj/a.ts", count: 2 }], total: 2, truncated: false };
    fsSearchReplace.mockResolvedValueOnce(preview);
    await useFsStore.getState().previewReplace("/proj", "foo ", "bar");
    expect(fsSearchReplace).toHaveBeenCalledWith("/proj", "foo", "bar", {
      caseSensitive: false,
      wholeWord: false,
      regex: false,
    });
    expect(useFsStore.getState().replacePreview).toEqual(preview);
    expect(useFsStore.getState().replacing).toBe(false);
  });

  it("previewReplace on blank query clears any stale preview without calling the bridge", async () => {
    await useFsStore.getState().previewReplace("/proj", "  ", "bar");
    expect(fsSearchReplace).not.toHaveBeenCalled();
    expect(useFsStore.getState().replacePreview).toBeNull();
  });

  it("applyReplace passes scope through, clears the preview, returns the result", async () => {
    useFsStore.setState({ replacePreview: { files: [], total: 1, truncated: false } });
    const result = { filesChanged: 1, replacements: 1 };
    fsApplyReplace.mockResolvedValueOnce(result);
    const out = await useFsStore.getState().applyReplace("/proj", "foo", "bar", {
      paths: ["/proj/a.ts"],
      limitPerFile: 1,
    });
    expect(fsApplyReplace).toHaveBeenCalledWith(
      "/proj",
      "foo",
      "bar",
      { caseSensitive: false, wholeWord: false, regex: false },
      ["/proj/a.ts"],
      1,
    );
    expect(out).toEqual(result);
    expect(useFsStore.getState().replacePreview).toBeNull();
  });

  it("applyReplace without scope sends nulls (whole project)", async () => {
    fsApplyReplace.mockResolvedValueOnce({ filesChanged: 0, replacements: 0 });
    await useFsStore.getState().applyReplace("/proj", "foo", "bar");
    expect(fsApplyReplace).toHaveBeenCalledWith(
      "/proj",
      "foo",
      "bar",
      { caseSensitive: false, wholeWord: false, regex: false },
      null,
      null,
    );
  });

  it("applyReplace failure reports searchError and returns null", async () => {
    fsApplyReplace.mockRejectedValueOnce({ type: "FileSystem", message: "磁盘错误" });
    const out = await useFsStore.getState().applyReplace("/proj", "foo", "bar");
    expect(out).toBeNull();
    expect(useFsStore.getState().searchError).toBe("磁盘错误");
  });
});

describe("openFile line targeting", () => {
  it("openFile with { line } stores a pendingLine (preview tab by default)", async () => {
    fsReadFile.mockResolvedValueOnce({ is_text: true, content: "a", size: 1 });
    await useFsStore.getState().openFile("/p/a.ts", { line: 4 });
    expect(useFsStore.getState().pendingLine).toEqual({ path: "/p/a.ts", line: 4 });
    expect(useFsStore.getState().openFiles[0].pinned).toBe(false);
  });

  it("openFile with { pin: true, line } pins and targets", async () => {
    fsReadFile.mockResolvedValueOnce({ is_text: true, content: "a", size: 1 });
    await useFsStore.getState().openFile("/p/a.ts", { pin: true, line: 2 });
    expect(useFsStore.getState().openFiles[0].pinned).toBe(true);
    expect(useFsStore.getState().pendingLine).toEqual({ path: "/p/a.ts", line: 2 });
  });

  it("legacy boolean form keeps working and sets no pendingLine", async () => {
    fsReadFile.mockResolvedValueOnce({ is_text: true, content: "a", size: 1 });
    await useFsStore.getState().openFile("/p/a.ts", true);
    expect(useFsStore.getState().openFiles[0].pinned).toBe(true);
    expect(useFsStore.getState().pendingLine).toBeNull();
  });

  it("consumePendingLine returns the pending line once, then null", async () => {
    fsReadFile.mockResolvedValueOnce({ is_text: true, content: "a", size: 1 });
    await useFsStore.getState().openFile("/p/a.ts", { line: 7 });
    expect(useFsStore.getState().consumePendingLine()).toEqual({ path: "/p/a.ts", line: 7 });
    expect(useFsStore.getState().pendingLine).toBeNull();
    expect(useFsStore.getState().consumePendingLine()).toBeNull();
  });
});
```

- [ ] **Step 2: 改 store 导入**——`src/stores/fs.store.ts` 第 5 行替换为：

```ts
import { fsReadTree, fsExpandDir, fsReadFile, fsSearch, fsSearchReplace, fsApplyReplace, fsWriteFile, fsCreateFile, fsCreateDir, type FsNode, type SearchMatch, type SearchOptions, type ReplacePreview, type ReplaceResult } from "../bridge/tauri";
```

- [ ] **Step 3: 新增类型与接口声明**——在 `export type EditorCache = …` 块之后插入：

```ts
/** 「打开并跳到行」的待消费目标；EditorPanel 读出即清。 */
export type PendingLine = { path: string; line: number };

/** openFile 第二参的对象形式（布尔形式保持后向兼容）。 */
export type OpenFileOptions = { pin?: boolean; line?: number };
```

`interface FsStore` 内：`searching: boolean;` 之后插入 state 声明：

```ts
  searchOptions: SearchOptions;
  searchError: string | null;
  replacePreview: ReplacePreview | null;
  replacing: boolean;
  pendingLine: PendingLine | null;
```

把接口中 `openFile: (filePath: string, pin?: boolean) => Promise<void>;` 改为：

```ts
  openFile: (filePath: string, opts?: boolean | OpenFileOptions) => Promise<void>;
```

在接口内 `clearSearch: () => void;` 之后插入：

```ts
  setSearchOptions: (patch: Partial<SearchOptions>) => void;
  previewReplace: (projectPath: string, query: string, replacement: string) => Promise<void>;
  applyReplace: (projectPath: string, query: string, replacement: string, scope?: { paths?: string[]; limitPerFile?: number }) => Promise<ReplaceResult | null>;
  clearReplacePreview: () => void;
  consumePendingLine: () => PendingLine | null;
```

- [ ] **Step 4: 初始值**——在 store 初始对象 `searchResults: [],` 之后插入：

```ts
    searchOptions: { caseSensitive: false, wholeWord: false, regex: false },
    searchError: null,
    replacePreview: null,
    replacing: false,
    pendingLine: null,
```

- [ ] **Step 5: openFile 改造（后向兼容 + line）**——把 `openFile: async (filePath: string, pin = false) => {` 起的函数头替换为：

```ts
    openFile: async (filePath, opts) => {
      const { pin, line } = typeof opts === "boolean"
        ? { pin: opts, line: undefined as number | undefined }
        : { pin: opts?.pin ?? false, line: opts?.line };
```

（函数体其余逻辑不动。）然后在 openFile 内**三处成功出口**各补一行 pendingLine 写入：

1. 已打开分支——把：

```ts
        set((s) => {
          s.activePath = filePath;
          if (pin) s.openFiles[existingIndex].pinned = true;
        });
        useUiStore.getState().setEditorVisible(true);
        return;
```

改为：

```ts
        set((s) => {
          s.activePath = filePath;
          if (pin) s.openFiles[existingIndex].pinned = true;
          if (line != null) s.pendingLine = { path: filePath, line };
        });
        useUiStore.getState().setEditorVisible(true);
        return;
```

2. 预览替换分支——把该分支内的：

```ts
              s.activePath = filePath;
            });
            useUiStore.getState().setEditorVisible(true);
            return;
```

改为：

```ts
              s.activePath = filePath;
              if (line != null) s.pendingLine = { path: filePath, line };
            });
            useUiStore.getState().setEditorVisible(true);
            return;
```

3. 新推入分支——把：

```ts
          s.activePath = filePath;
        });
        // Opening a file always reveals the panel, even if Esc hid it.
        useUiStore.getState().setEditorVisible(true);
```

改为：

```ts
          s.activePath = filePath;
          if (line != null) s.pendingLine = { path: filePath, line };
        });
        // Opening a file always reveals the panel, even if Esc hid it.
        useUiStore.getState().setEditorVisible(true);
```

- [ ] **Step 6: search / clearSearch 改写（searchError 槽 + 带选项）**——把：

```ts
    search: async (projectPath: string, query: string) => {
      if (!query.trim()) {
        set((s) => { s.searchResults = []; s.searching = false; });
        return;
      }
      set((s) => { s.searching = true; s.error = null; });
      try {
        const results = await fsSearch(projectPath, query.trim());
        set((s) => { s.searchResults = results; });
      } catch (err) {
        set((s) => { s.error = errorMessage(err); });
      } finally {
        set((s) => { s.searching = false; });
      }
    },

    clearSearch: () => {
      set((s) => { s.searchResults = []; s.searching = false; });
    },
```

替换为：

```ts
    search: async (projectPath: string, query: string) => {
      if (!query.trim()) {
        set((s) => { s.searchResults = []; s.searching = false; s.searchError = null; });
        return;
      }
      set((s) => { s.searching = true; s.searchError = null; });
      try {
        const results = await fsSearch(projectPath, query.trim(), get().searchOptions);
        set((s) => { s.searchResults = results; });
      } catch (err) {
        // 独立错误槽：共享 error 会在 EditorPanel 渲染红条，搜索错误不该出现在那里。
        set((s) => { s.searchError = errorMessage(err); });
      } finally {
        set((s) => { s.searching = false; });
      }
    },

    clearSearch: () => {
      set((s) => { s.searchResults = []; s.searching = false; s.searchError = null; });
    },
```

- [ ] **Step 7: 新增 actions**——在 `clearSearch` 之后、`clearError` 之前插入：

```ts
    setSearchOptions: (patch) => {
      set((s) => { s.searchOptions = { ...s.searchOptions, ...patch }; });
    },

    previewReplace: async (projectPath, query, replacement) => {
      if (!query.trim()) {
        set((s) => { s.replacePreview = null; });
        return;
      }
      set((s) => { s.replacing = true; s.searchError = null; });
      try {
        const preview = await fsSearchReplace(projectPath, query.trim(), replacement, get().searchOptions);
        set((s) => { s.replacePreview = preview; });
      } catch (err) {
        set((s) => { s.searchError = errorMessage(err); s.replacePreview = null; });
      } finally {
        set((s) => { s.replacing = false; });
      }
    },

    applyReplace: async (projectPath, query, replacement, scope) => {
      set((s) => { s.replacing = true; s.searchError = null; });
      try {
        const result = await fsApplyReplace(
          projectPath,
          query.trim(),
          replacement,
          get().searchOptions,
          scope?.paths ?? null,
          scope?.limitPerFile ?? null,
        );
        set((s) => { s.replacePreview = null; });
        return result;
      } catch (err) {
        set((s) => { s.searchError = errorMessage(err); });
        return null;
      } finally {
        set((s) => { s.replacing = false; });
      }
    },

    clearReplacePreview: () => {
      set((s) => { s.replacePreview = null; });
    },

    consumePendingLine: () => {
      const cur = get().pendingLine;
      if (cur) set((s) => { s.pendingLine = null; });
      return cur;
    },
```

- [ ] **Step 8: saveFile stale 写盘守卫（R1，TDD）**——全项目替换让本应用自己成为外部写方：用户对某文件有脏草稿且 autosave 定时器在途时，替换写盘 → 在途 autosave 随后把**基于旧内容的草稿**写回，静默回滚替换结果。先给 `src/stores/fs.store.search.test.ts` 末尾追加用例（红）：

```ts
it("saveFile refuses to write a stale file (external change pending)", async () => {
  useFsStore.setState({
    openFiles: [
      { path: "/proj/a.ts", content: "old", isText: true, size: 3, draft: "old-draft", dirty: true, stale: true, pinned: false },
    ],
    activePath: "/proj/a.ts",
  });
  const ok = await useFsStore.getState().saveFile();
  expect(ok).toBe(false);
  expect(fsWriteFile).not.toHaveBeenCalled();
});
```

再改 `src/stores/fs.store.ts` 的 `saveFile`：在 `if (!cur || !cur.dirty) return true;` 之后插入：

```ts
      // R1：stale＝外部改动（替换/拉取/外部进程）待决策；任何写盘（含 autosave）
      // 都会静默回滚该改动——用户须先在黄条上「重新加载/保留」，故直接拒绝
      if (cur.stale) return false;
```

- [ ] **Step 9: 跑绿**——`pnpm vitest run src/stores/fs.store.search.test.ts src/stores/fs.store.editor.test.ts`（含 stale 守卫用例；后者回归：`openFile(path, true)` 等既有用例必须全绿，验证后向兼容）。再 `pnpm build` 过类型门槛。

- [ ] **Step 10: 提交**——`feat(fs-store): 搜索选项/替换动作与行定位状态`

---

### Task 5: EditorPanel 行定位（TDD）

**Files:**
- Modify: `src/features/editor/EditorPanel.tsx`
- Create: `src/features/editor/EditorPanel.line.test.tsx`

**Interfaces:**
- Consumes: T4 的 `fs.store.pendingLine` / `consumePendingLine()`；CodeMirror `view.state.doc.line(n).from`、`view.dispatch({ selection, effects: EditorView.scrollIntoView(pos, { y: "center" }) })`。
- 触发通道二合一：新视图在 `onCreateEditor`（既有 `viewRef` 赋值处）即时应用；已存在视图（同文件再次跳转，key 不变不重建）经 `useEffect([pendingLine, editorFile?.path])` 应用。`consumePendingLine` 读出即清，防止重复滚动。
- 行号越界钳制到 `[1, doc.lines]`。

- [ ] **Step 1: 先写测试（红）**——创建 `src/features/editor/EditorPanel.line.test.tsx`：

```tsx
/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

// ---- mocks（模块级可变绑定 + 闭包延迟读取，同 registry.run.test.ts 模式）----
let cmProps: Record<string, unknown> | null = null;
vi.mock("@uiw/react-codemirror", () => ({
  default: (props: Record<string, unknown>) => {
    cmProps = props;
    return null;
  },
  EditorView: {
    theme: () => ({}),
    scrollIntoView: (pos: number, opts?: unknown) => ({ kind: "scroll", pos, opts }),
  },
}));
vi.mock("./editorSearch", () => ({ editorSearchExtensions: () => [] }));
vi.mock("./language", () => ({ languageExtensionsForPath: () => [] }));
vi.mock("../../commands/editorKeybindings", () => ({ registerFindBarAccessor: vi.fn() }));

let fsState: {
  openFiles: {
    path: string; content: string | null; isText: boolean; size: number;
    draft: string; dirty: boolean; stale: boolean; pinned: boolean;
  }[];
  activePath: string | null;
  error: string | null;
  pendingLine: { path: string; line: number } | null;
  setDraft: ReturnType<typeof vi.fn>;
  switchFile: ReturnType<typeof vi.fn>;
  closeFile: ReturnType<typeof vi.fn>;
  reloadEditor: ReturnType<typeof vi.fn>;
  dismissStale: ReturnType<typeof vi.fn>;
  clearError: ReturnType<typeof vi.fn>;
  consumePendingLine: ReturnType<typeof vi.fn>;
};
vi.mock("../../stores/fs.store", () => ({
  useFsStore: Object.assign(
    (sel?: (s: typeof fsState) => unknown) => (sel ? sel(fsState) : fsState),
    { getState: () => fsState },
  ),
}));

const uiState = { setEditorVisible: vi.fn() };
vi.mock("../../stores/ui.store", () => ({
  useUiStore: Object.assign(
    (sel?: (s: typeof uiState) => unknown) => (sel ? sel(uiState) : uiState),
    { getState: () => uiState },
  ),
}));

const projectState = { projects: [], activeProjectId: null };
vi.mock("../../stores/project.store", () => ({
  useProjectStore: Object.assign(
    (sel?: (s: typeof projectState) => unknown) => (sel ? sel(projectState) : projectState),
    { getState: () => projectState },
  ),
}));

import { EditorPanel } from "./EditorPanel";

function makeFakeView(lines: number) {
  const dispatch = vi.fn();
  const view = {
    dispatch,
    requestMeasure: vi.fn(),
    state: { doc: { lines, line: (n: number) => ({ from: (n - 1) * 10 }) } },
  };
  return { view, dispatch };
}

beforeEach(() => {
  cmProps = null;
  fsState = {
    openFiles: [{
      path: "/p/a.ts", content: "x", isText: true, size: 1,
      draft: "x", dirty: false, stale: false, pinned: true,
    }],
    activePath: "/p/a.ts",
    error: null,
    pendingLine: null,
    setDraft: vi.fn(),
    switchFile: vi.fn(),
    closeFile: vi.fn(),
    reloadEditor: vi.fn(),
    dismissStale: vi.fn(),
    clearError: vi.fn(),
    consumePendingLine: vi.fn(),
  };
});
afterEach(() => cleanup());

describe("EditorPanel pending-line targeting", () => {
  it("selects + scrolls to the pending line when the view is created", () => {
    fsState.pendingLine = { path: "/p/a.ts", line: 4 };
    render(<EditorPanel />);
    expect(cmProps).not.toBeNull();
    const { view, dispatch } = makeFakeView(10);
    (cmProps!.onCreateEditor as (v: unknown) => void)(view);
    // 第 4 行 → from = (4-1)*10 = 30
    expect(dispatch).toHaveBeenCalledWith({
      selection: { anchor: 30 },
      effects: { kind: "scroll", pos: 30, opts: { y: "center" } },
    });
    expect(fsState.consumePendingLine).toHaveBeenCalledTimes(1);
  });

  it("ignores a pending line that targets another file", () => {
    fsState.pendingLine = { path: "/p/other.ts", line: 2 };
    render(<EditorPanel />);
    const { view, dispatch } = makeFakeView(10);
    (cmProps!.onCreateEditor as (v: unknown) => void)(view);
    expect(dispatch).not.toHaveBeenCalled();
    expect(fsState.consumePendingLine).not.toHaveBeenCalled();
  });

  it("clamps an out-of-range line to the document end", () => {
    fsState.pendingLine = { path: "/p/a.ts", line: 99 };
    render(<EditorPanel />);
    const { view, dispatch } = makeFakeView(5);
    (cmProps!.onCreateEditor as (v: unknown) => void)(view);
    expect(dispatch).toHaveBeenCalledWith({
      selection: { anchor: 40 }, // 钳制到第 5 行 → from = 40
      effects: { kind: "scroll", pos: 40, opts: { y: "center" } },
    });
  });
});
```

- [ ] **Step 2: 实现**——`src/features/editor/EditorPanel.tsx`：

在 `const viewRef = useRef<EditorView | null>(null);` 之后插入订阅：

```tsx
  const pendingLine = useFsStore((s) => s.pendingLine);
```

在 `useEffect(() => { registerFindBarAccessor(...); ... }, []);` 块之后插入：

```tsx
  // Plan 5 行定位：搜索跳转携带 pendingLine。视图就绪后选中并滚动到目标行，
  // 然后消费掉 pending 防止重复触发。两条入口：新视图走 onCreateEditor，
  // 已存在视图（同文件再次跳转，不按 path 重建）走下方 effect。
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

  useEffect(() => {
    const v = viewRef.current;
    if (v) applyPendingLine(v);
  }, [pendingLine, editorFile?.path]);
```

把 CodeMirror 的：

```tsx
              onCreateEditor={(view) => { viewRef.current = view; }}
```

改为：

```tsx
              onCreateEditor={(view) => { viewRef.current = view; applyPendingLine(view); }}
```

- [ ] **Step 3: 跑绿**——`pnpm vitest run src/features/editor/EditorPanel.line.test.tsx` 三条全绿；`pnpm vitest run` 全量无回归。

- [ ] **Step 4: 提交**——`feat(editor): 打开文件时定位到指定行`

---

### Task 6: SearchPanel 搜索行重构（三开关 + 非法正则行内错误 + 统计条 + 预留过滤行，TDD）

**Files:**
- Modify(整体重写): `src/features/search/SearchPanel.tsx`
- Create: `src/features/search/SearchPanel.test.tsx`

**Interfaces:**
- Consumes: T4 的 `searchOptions/searchError/setSearchOptions/search/clearSearch/searchResults/searching/openFile`；`useProjectStore`。
- 非法正则「不搜」：面板侧用 JS `new RegExp` 预校验（与后端合成规则近似的快速失败），命中即行内红字 + 红框且不发搜索；Rust 方言差异导致的后端拒绝经 `searchError` 同样渲染在行内（`inlineError = regexError ?? searchError`）。后端恒为匹配权威。
- 防抖 300ms 沿用；依赖项加 `searchOptions`（切开关即重搜）与 `regexError`。
- 本任务结果区**暂保留扁平列表**（下一任务换成分组）；折叠状态 `collapsed` 在本任务建立、由 T7 分组消费。
- 文案（逐字）：占位符「搜索…」、「替换…」（T8 用）；开关 title「区分大小写」「全字匹配」「使用正则表达式」；工具条 title「重新搜索」「清除」；统计「N 个结果 / M 个文件」/「搜索中…」；空态「打开项目后即可搜索。」「输入关键词搜索文件名与内容。」「无结果。」；过滤行占位「要包含的文件（glob）— 后续版本支持」+ title「后续版本支持」。

- [ ] **Step 1: 先写测试（红）**——创建 `src/features/search/SearchPanel.test.tsx`：

```tsx
/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

type SearchOptions = { caseSensitive: boolean; wholeWord: boolean; regex: boolean };
type SearchMatch = { path: string; name: string; line: number | null; text: string };

let fsState: {
  searchResults: SearchMatch[];
  searching: boolean;
  searchError: string | null;
  searchOptions: SearchOptions;
  search: ReturnType<typeof vi.fn>;
  clearSearch: ReturnType<typeof vi.fn>;
  setSearchOptions: ReturnType<typeof vi.fn>;
  openFile: ReturnType<typeof vi.fn>;
};
vi.mock("../../stores/fs.store", () => ({
  useFsStore: Object.assign(
    (sel?: (s: typeof fsState) => unknown) => (sel ? sel(fsState) : fsState),
    { getState: () => fsState },
  ),
}));

let projectState: { projects: { id: string; path: string }[]; activeProjectId: string | null };
vi.mock("../../stores/project.store", () => ({
  useProjectStore: Object.assign(
    (sel?: (s: typeof projectState) => unknown) => (sel ? sel(projectState) : projectState),
    { getState: () => projectState },
  ),
}));

import { SearchPanel } from "./SearchPanel";

beforeEach(() => {
  vi.useFakeTimers();
  fsState = {
    searchResults: [],
    searching: false,
    searchError: null,
    searchOptions: { caseSensitive: false, wholeWord: false, regex: false },
    search: vi.fn().mockResolvedValue(undefined),
    clearSearch: vi.fn(),
    setSearchOptions: vi.fn(),
    openFile: vi.fn().mockResolvedValue(undefined),
  };
  projectState = { projects: [{ id: "p1", path: "/proj" }], activeProjectId: "p1" };
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe("search row flags", () => {
  it("renders three toggles reflecting the store and flips them", () => {
    render(<SearchPanel />);
    fireEvent.click(screen.getByTitle("区分大小写"));
    expect(fsState.setSearchOptions).toHaveBeenCalledWith({ caseSensitive: true });
    fireEvent.click(screen.getByTitle("全字匹配"));
    expect(fsState.setSearchOptions).toHaveBeenCalledWith({ wholeWord: true });
    fireEvent.click(screen.getByTitle("使用正则表达式"));
    expect(fsState.setSearchOptions).toHaveBeenCalledWith({ regex: true });
  });

  it("aria-pressed mirrors the stored flags", () => {
    fsState.searchOptions = { caseSensitive: true, wholeWord: false, regex: true };
    render(<SearchPanel />);
    expect(screen.getByTitle("区分大小写").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTitle("全字匹配").getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByTitle("使用正则表达式").getAttribute("aria-pressed")).toBe("true");
  });
});

describe("debounced search", () => {
  it("fires with the raw query after 300ms", async () => {
    render(<SearchPanel />);
    fireEvent.change(screen.getByLabelText("搜索"), { target: { value: " foo " } });
    expect(fsState.search).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(fsState.search).toHaveBeenCalledWith("/proj", " foo ");
  });

  it("toggling a flag re-runs the search", async () => {
    const utils = render(<SearchPanel />);
    fireEvent.change(screen.getByLabelText("搜索"), { target: { value: "foo" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    fsState.search.mockClear();
    // 模拟 store 已更新选项（真实场景由 setSearchOptions 完成）
    fsState.searchOptions = { caseSensitive: true, wholeWord: false, regex: false };
    utils.rerender(<SearchPanel />); // 同 root 重渲让 selector 取新值、deps 变更触发新防抖
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(fsState.search).toHaveBeenCalled();
  });
});

describe("invalid regex", () => {
  it("shows an inline error and does not search", async () => {
    fsState.searchOptions = { caseSensitive: false, wholeWord: false, regex: true };
    render(<SearchPanel />);
    fireEvent.change(screen.getByLabelText("搜索"), { target: { value: "([broken" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(screen.getByRole("alert").textContent).toContain("无效的正则表达式: ([broken");
    expect(fsState.search).not.toHaveBeenCalled();
  });

  it("backend searchError is rendered inline too", () => {
    fsState.searchError = "无效的正则表达式: (?P<x>";
    render(<SearchPanel />);
    expect(screen.getByRole("alert").textContent).toContain("无效的正则表达式");
  });
});

describe("stats bar & toolbar", () => {
  it("counts results and files", () => {
    fsState.searchResults = [
      { path: "/proj/a.ts", name: "a.ts", line: 1, text: "foo" },
      { path: "/proj/a.ts", name: "a.ts", line: 3, text: "foo" },
      { path: "/proj/b.ts", name: "b.ts", line: 2, text: "foo" },
    ];
    render(<SearchPanel />);
    fireEvent.change(screen.getByLabelText("搜索"), { target: { value: "foo" } });
    expect(screen.getByText("3 个结果 / 2 个文件")).toBeTruthy();
  });

  it("shows a spinner while searching", () => {
    fsState.searching = true;
    render(<SearchPanel />);
    fireEvent.change(screen.getByLabelText("搜索"), { target: { value: "foo" } });
    expect(screen.getByText("搜索中…")).toBeTruthy();
  });

  it("clear button empties the query and clears results", () => {
    render(<SearchPanel />);
    const input = screen.getByLabelText("搜索") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "foo" } });
    fireEvent.click(screen.getByTitle("清除"));
    expect(input.value).toBe("");
    expect(fsState.clearSearch).toHaveBeenCalled();
  });

  it("refresh button re-runs the search immediately", () => {
    render(<SearchPanel />);
    fireEvent.change(screen.getByLabelText("搜索"), { target: { value: "foo" } });
    fsState.search.mockClear();
    fireEvent.click(screen.getByTitle("重新搜索"));
    expect(fsState.search).toHaveBeenCalledWith("/proj", "foo");
  });

  it("renders a disabled glob filter placeholder (v1 预留位)", () => {
    render(<SearchPanel />);
    const filter = screen.getByPlaceholderText(/要包含的文件/) as HTMLInputElement;
    expect(filter.disabled).toBe(true);
    expect(filter.getAttribute("title")).toBe("后续版本支持");
  });
});
```

- [ ] **Step 2: 整体重写 SearchPanel.tsx**——将 `src/features/search/SearchPanel.tsx` 全文替换为（本任务形态；T7/T8/T9 在其上做定点 Edit）：

```tsx
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { FileCode, Loader2, RefreshCw, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useFsStore } from "../../stores/fs.store";
import { useProjectStore } from "../../stores/project.store";

const DEBOUNCE_MS = 300;

// Read at effect/handler time (App.tsx pattern) so renders don't subscribe
// the panel to the whole project store.
function activeProjectPath(): string | null {
  const { projects, activeProjectId } = useProjectStore.getState();
  return projects.find((p) => p.id === activeProjectId)?.path ?? null;
}

/** Aa / ab| / .* 三枚匹配规则开关；aria-pressed 表达状态。 */
function FlagToggle({ pressed, title, onClick, children }: {
  pressed: boolean;
  title: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      title={title}
      onClick={onClick}
      className={`h-7 min-w-7 px-1 rounded-[var(--radius-sm)] text-xs font-mono transition-colors ${
        pressed
          ? "bg-[var(--overlay-active)] text-[var(--text-primary)]"
          : "text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--overlay-hover)]"
      }`}
    >
      {children}
    </button>
  );
}

export function SearchPanel() {
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const searchResults = useFsStore((s) => s.searchResults);
  const searching = useFsStore((s) => s.searching);
  const searchError = useFsStore((s) => s.searchError);
  const searchOptions = useFsStore((s) => s.searchOptions);
  const search = useFsStore((s) => s.search);
  const clearSearch = useFsStore((s) => s.clearSearch);
  const setSearchOptions = useFsStore((s) => s.setSearchOptions);
  const openFile = useFsStore((s) => s.openFile);
  const projects = useProjectStore((s) => s.projects);
  const activeProjectId = useProjectStore((s) => s.activeProjectId);
  const project = projects.find((p) => p.id === activeProjectId);
  const inputRef = useRef<HTMLInputElement>(null);

  // 非法正则快速失败：与后端合成规则近似的 JS 预校验，命中则不发起搜索。
  // Rust regex 方言更宽，极少数「Rust 合法 / JS 非法」模式仍会到达后端，
  // 其拒绝经 searchError 以同样的行内形式呈现（后端恒为匹配权威）。
  const regexError = useMemo(() => {
    if (!searchOptions.regex || !query.trim()) return null;
    try {
      new RegExp(query);
      return null;
    } catch {
      return `无效的正则表达式: ${query}`;
    }
  }, [query, searchOptions.regex]);
  const inlineError = regexError ?? searchError;

  // Debounced live search; clearing the input clears the results.
  useEffect(() => {
    const path = activeProjectPath();
    if (!path || !query.trim()) {
      clearSearch();
      return;
    }
    if (regexError) return; // 非法正则不搜
    const timer = setTimeout(() => { void search(path, query); }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, searchOptions, regexError, search, clearSearch]);

  const fileCount = useMemo(
    () => new Set(searchResults.map((m) => m.path)).size,
    [searchResults],
  );

  return (
    <div className="flex flex-col h-full">
      {/* 顶工具条 */}
      <div className="flex items-center gap-1 px-2 pt-2">
        <span className="flex-1 text-xs font-medium text-[var(--text-secondary)]">搜索</span>
        <Button
          variant="ghost"
          size="icon-xs"
          title="重新搜索"
          onClick={() => {
            const path = activeProjectPath();
            if (path && query.trim() && !regexError) void search(path, query);
          }}
        >
          <RefreshCw size={13} />
        </Button>
        <Button variant="ghost" size="icon-xs" title="清除" onClick={() => setQuery("")}>
          <X size={13} />
        </Button>
      </div>

      {/* 搜索行 + 三枚匹配规则开关 */}
      <div className="py-2 px-1">
        <div className="flex items-center gap-1">
          <Input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索…"
            aria-label="搜索"
            className={inlineError ? "border-[var(--error)] focus-visible:ring-[var(--error)]" : ""}
          />
          <FlagToggle
            pressed={searchOptions.caseSensitive}
            title="区分大小写"
            onClick={() => setSearchOptions({ caseSensitive: !searchOptions.caseSensitive })}
          >
            Aa
          </FlagToggle>
          <FlagToggle
            pressed={searchOptions.wholeWord}
            title="全字匹配"
            onClick={() => setSearchOptions({ wholeWord: !searchOptions.wholeWord })}
          >
            ab|
          </FlagToggle>
          <FlagToggle
            pressed={searchOptions.regex}
            title="使用正则表达式"
            onClick={() => setSearchOptions({ regex: !searchOptions.regex })}
          >
            .*
          </FlagToggle>
        </div>
        {inlineError && (
          <p role="alert" className="mt-1 px-1 text-xs text-[var(--error)]">{inlineError}</p>
        )}
      </div>

      {/* 可选过滤行预留位（glob，v1 不接后端） */}
      <div className="px-1 pb-2">
        <Input
          disabled
          placeholder="要包含的文件（glob）— 后续版本支持"
          title="后续版本支持"
          aria-label="文件过滤"
          className="opacity-60"
        />
      </div>

      {/* 统计条 */}
      {query.trim() && !regexError && (
        <div className="flex items-center gap-2 px-3 pb-1 text-xs text-[var(--text-tertiary)]">
          {searching ? (
            <>
              <Loader2 size={12} className="animate-spin" />
              <span>搜索中…</span>
            </>
          ) : (
            <span>{searchResults.length} 个结果 / {fileCount} 个文件</span>
          )}
        </div>
      )}

      {/* 结果区（T7 换成分组视图） */}
      <div className="flex-1 overflow-y-auto pb-4 px-1">
        {!project ? (
          <p className="text-sm text-[var(--text-tertiary)] px-2 py-1">打开项目后即可搜索。</p>
        ) : !query.trim() ? (
          <p className="flex items-center gap-2 text-sm text-[var(--text-tertiary)] px-2 py-1">
            <Search size={14} /> 输入关键词搜索文件名与内容。
          </p>
        ) : searchResults.length === 0 && !searching ? (
          <p className="text-sm text-[var(--text-tertiary)] px-2 py-1">无结果。</p>
        ) : (
          <div className="space-y-1" data-testid="search-result-list">
            {searchResults.map((m, i) => (
              <button
                key={`${m.path}:${m.line ?? 0}:${i}`}
                onClick={() => void openFile(m.path)}
                className="w-full text-left px-3 py-2 rounded-[var(--radius-md)] hover:bg-[var(--glass-2-surface)] transition-colors"
              >
                <div className="flex items-center gap-2 text-sm text-[var(--text-primary)]">
                  <FileCode size={13} className="flex-none text-[var(--text-tertiary)]" />
                  <span className="truncate">{m.name}</span>
                  {m.line != null && (
                    <span className="flex-none text-xs text-[var(--text-tertiary)]">:{m.line}</span>
                  )}
                </div>
                <div className="pl-5 text-xs text-[var(--text-tertiary)] truncate">{m.path}</div>
                {m.text && (
                  <div className="pl-5 text-xs font-mono text-[var(--text-secondary)] truncate">{m.text}</div>
                )}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: 跑绿**——`pnpm vitest run src/features/search/SearchPanel.test.tsx` 全绿；`pnpm build` 过类型门槛。

- [ ] **Step 4: 提交**——`feat(search-panel): 搜索行重构与匹配规则开关`

---

### Task 7: 结果分组 + 命中高亮 + 折叠/展开 + 行跳转（TDD）

**Files:**
- Create: `src/features/search/searchHighlight.ts`
- Create: `src/features/search/searchHighlight.test.ts`
- Modify: `src/features/search/SearchPanel.tsx`（扁平列表 → 分组视图；工具条 +2 按钮）
- Create: `src/features/search/SearchPanel.results.test.tsx`

**Interfaces:**
- Produces（`searchHighlight.ts`，纯函数，node 环境可测）：
  ```ts
  export function buildHighlightRegExp(query: string, options: SearchOptions): RegExp | null;
  export type MatchRange = [number, number];
  export function matchRanges(text: string, re: RegExp | null): MatchRange[];
  ```
  合成规则与后端 `compile_pattern` 对齐（escape → `\b(?:…)\b` 包裹），大小写经 JS 原生 flag（`"gi"`/`"g"`）而非 `(?i)` 内联——JS RegExp 不支持内联 flag。JS 编译失败（Rust 方言差异）→ 返回 null → 不高亮（静默降级，匹配本身不受影响）。
- 分组 `FileGroup { path, name, matches: SearchMatch[] }` 按结果顺序聚合；组头＝图标 + 名称 + 相对路径（`relativeToProject`）+ 计数徽标，`aria-expanded`；折叠用 `search-collapse` 类 + 内联 `gridTemplateRows: 0fr/1fr`（CSS 在 T10 加入，缺 CSS 时退化为常显，aria 语义仍完整）。
- 行跳转：内容行 `openFile(m.path, { line: m.line })`；文件名命中行（`line == null`）`openFile(m.path)`。
- 命中片段以 `<mark>` 包裹（对 `m.text` 计算区间）。

- [ ] **Step 1: 先写高亮纯函数测试（红）**——创建 `src/features/search/searchHighlight.test.ts`（node 环境，无需 docblock）：

```ts
import { describe, expect, it } from "vitest";
import { buildHighlightRegExp, matchRanges } from "./searchHighlight";

const off = { caseSensitive: false, wholeWord: false, regex: false };

describe("buildHighlightRegExp", () => {
  it("escapes plain queries and is case-insensitive by default", () => {
    const re = buildHighlightRegExp("a.b", off)!;
    expect(matchRanges("a.b AxB", re)).toEqual([[0, 3], [4, 7]]);
  });

  it("honors caseSensitive", () => {
    const re = buildHighlightRegExp("Foo", { ...off, caseSensitive: true })!;
    expect(matchRanges("Foo foo", re)).toEqual([[0, 3]]);
  });

  it("wraps whole-word boundaries", () => {
    const re = buildHighlightRegExp("cat", { ...off, wholeWord: true })!;
    expect(matchRanges("cat concat", re)).toEqual([[0, 3]]);
  });

  it("passes regex mode through", () => {
    const re = buildHighlightRegExp("\\d+", { ...off, regex: true })!;
    expect(matchRanges("a1 bb22", re)).toEqual([[1, 2], [5, 7]]);
  });

  it("returns null for an invalid regex", () => {
    expect(buildHighlightRegExp("([", { ...off, regex: true })).toBeNull();
  });

  it("returns null for an empty query", () => {
    expect(buildHighlightRegExp("", off)).toBeNull();
  });
});

describe("matchRanges", () => {
  it("returns [] for a null regexp", () => {
    expect(matchRanges("anything", null)).toEqual([]);
  });

  it("terminates on zero-length matches", () => {
    const re = buildHighlightRegExp("x*", { ...off, regex: true })!;
    const ranges = matchRanges("ab", re);
    expect(Array.isArray(ranges)).toBe(true);
  });
});
```

- [ ] **Step 2: 实现 searchHighlight.ts**——创建 `src/features/search/searchHighlight.ts`：

```ts
import type { SearchOptions } from "../../bridge/tauri";

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Mirror of the backend compile_pattern (escape → whole-word wrap) using
 * JS-native flags for case handling. Returns null when the pattern does not
 * compile under the JS dialect — highlighting then degrades silently while
 * matching itself stays authoritative on the Rust side.
 */
export function buildHighlightRegExp(query: string, options: SearchOptions): RegExp | null {
  if (!query) return null;
  try {
    let pattern = options.regex ? query : escapeRegExp(query);
    if (options.wholeWord) pattern = `\\b(?:${pattern})\\b`;
    return new RegExp(pattern, options.caseSensitive ? "g" : "gi");
  } catch {
    return null;
  }
}

export type MatchRange = [number, number];

/** Non-overlapping match spans of `re` within `text`; safe on zero-length
 *  matches (advances lastIndex) and capped to avoid pathological loops. */
export function matchRanges(text: string, re: RegExp | null): MatchRange[] {
  if (!re) return [];
  const ranges: MatchRange[] = [];
  re.lastIndex = 0;
  let guard = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null && guard++ < 1000) {
    if (m[0].length === 0) {
      re.lastIndex++;
      continue;
    }
    ranges.push([m.index, m.index + m[0].length]);
  }
  return ranges;
}
```

- [ ] **Step 3: 写分组视图测试（红）**——创建 `src/features/search/SearchPanel.results.test.tsx`：

```tsx
/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

type SearchOptions = { caseSensitive: boolean; wholeWord: boolean; regex: boolean };
type SearchMatch = { path: string; name: string; line: number | null; text: string };

let fsState: {
  searchResults: SearchMatch[];
  searching: boolean;
  searchError: string | null;
  searchOptions: SearchOptions;
  search: ReturnType<typeof vi.fn>;
  clearSearch: ReturnType<typeof vi.fn>;
  setSearchOptions: ReturnType<typeof vi.fn>;
  openFile: ReturnType<typeof vi.fn>;
};
vi.mock("../../stores/fs.store", () => ({
  useFsStore: Object.assign(
    (sel?: (s: typeof fsState) => unknown) => (sel ? sel(fsState) : fsState),
    { getState: () => fsState },
  ),
}));

let projectState: { projects: { id: string; path: string }[]; activeProjectId: string | null };
vi.mock("../../stores/project.store", () => ({
  useProjectStore: Object.assign(
    (sel?: (s: typeof projectState) => unknown) => (sel ? sel(projectState) : projectState),
    { getState: () => projectState },
  ),
}));

import { SearchPanel } from "./SearchPanel";

const RESULTS: SearchMatch[] = [
  { path: "/proj/src/a.ts", name: "a.ts", line: 1, text: "const foo = 1;" },
  { path: "/proj/src/a.ts", name: "a.ts", line: 3, text: "let foo2 = 2;" },
  { path: "/proj/b.ts", name: "b.ts", line: 2, text: "foo again" },
  { path: "/proj/readme.md", name: "readme.md", line: null, text: "" },
];

beforeEach(() => {
  fsState = {
    searchResults: RESULTS,
    searching: false,
    searchError: null,
    searchOptions: { caseSensitive: false, wholeWord: false, regex: false },
    search: vi.fn().mockResolvedValue(undefined),
    clearSearch: vi.fn(),
    setSearchOptions: vi.fn(),
    openFile: vi.fn().mockResolvedValue(undefined),
  };
  projectState = { projects: [{ id: "p1", path: "/proj" }], activeProjectId: "p1" };
});
afterEach(() => cleanup());

function renderWithQuery() {
  const utils = render(<SearchPanel />);
  fireEvent.change(screen.getByLabelText("搜索"), { target: { value: "foo" } });
  return utils;
}

describe("grouped results", () => {
  it("groups by file with name / relative path / count badge", () => {
    const { container } = renderWithQuery();
    // 三个分组：a.ts(2) / b.ts(1) / readme.md(1 名称命中)
    const headers = screen.getAllByRole("button").filter((b) => b.hasAttribute("aria-expanded"));
    expect(headers).toHaveLength(3);
    expect(screen.getByText("src/a.ts")).toBeTruthy();
    const badges = [...container.querySelectorAll("[data-count-badge]")].map((n) => n.textContent);
    expect(badges).toEqual(["2", "1", "1"]);
  });

  it("highlights the hit inside the line text with <mark>", () => {
    renderWithQuery();
    const marks = document.querySelectorAll("mark");
    expect(marks.length).toBeGreaterThanOrEqual(3);
    expect([...marks].some((m) => m.textContent === "foo")).toBe(true);
  });

  it("collapses and expands a group via its header", () => {
    renderWithQuery();
    const header = screen.getAllByRole("button").find(
      (b) => b.hasAttribute("aria-expanded") && b.textContent?.includes("a.ts"),
    )!;
    expect(header.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(header);
    expect(header.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(header);
    expect(header.getAttribute("aria-expanded")).toBe("true");
  });

  it("collapse-all / expand-all toolbar buttons toggle every group", () => {
    renderWithQuery();
    fireEvent.click(screen.getByTitle("折叠全部"));
    const headers = () => screen.getAllByRole("button").filter((b) => b.hasAttribute("aria-expanded"));
    expect(headers().every((h) => h.getAttribute("aria-expanded") === "false")).toBe(true);
    fireEvent.click(screen.getByTitle("展开全部"));
    expect(headers().every((h) => h.getAttribute("aria-expanded") === "true")).toBe(true);
  });

  it("clicking a content row opens the file at that line", () => {
    renderWithQuery();
    // <mark> 将行文本切成三段，getByText("const ") 不可得；经 mark 文本定位行按钮
    fireEvent.click(screen.getAllByText("foo")[0].closest("button")!);
    expect(fsState.openFile).toHaveBeenCalledWith("/proj/src/a.ts", { line: 1 });
  });

  it("clicking a file-name hit row opens the file without a line", () => {
    renderWithQuery();
    fireEvent.click(screen.getByText("文件名匹配").closest("button")!);
    expect(fsState.openFile).toHaveBeenCalledWith("/proj/readme.md", undefined);
  });
});
```

- [ ] **Step 4: 实现分组视图**——`src/features/search/SearchPanel.tsx` 做以下 Edit：

**4a.** 导入行 `import { FileCode, Loader2, RefreshCw, Search, X } from "lucide-react";` 替换为：

```tsx
import { ChevronRight, ChevronsDownUp, ChevronsUpDown, FileCode, Loader2, RefreshCw, Search, X } from "lucide-react";
```

并在 `import { useProjectStore } from "../../stores/project.store";` 之后插入：

```tsx
import { relativeToProject } from "../editor/pathUtils";
import { buildHighlightRegExp, matchRanges, type MatchRange } from "./searchHighlight";
```

**4b.** 在 `FlagToggle` 组件之后插入高亮渲染器：

```tsx
/** 按区间把行文本切成普通段 + <mark> 高亮段。 */
function Highlighted({ text, ranges }: { text: string; ranges: MatchRange[] }) {
  if (ranges.length === 0) return <>{text}</>;
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const [start, end] of ranges) {
    if (start > cursor) parts.push(text.slice(cursor, start));
    parts.push(
      <mark key={start} className="rounded-[2px] bg-[color-mix(in_srgb,var(--accent)_28%,transparent)] text-[var(--text-primary)]">
        {text.slice(start, end)}
      </mark>,
    );
    cursor = end;
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return <>{parts}</>;
}
```

**4c.** 在 `const project = projects.find(…);` 之后插入分组与折叠辅助：

```tsx
  const groups = useMemo(() => {
    const map = new Map<string, { path: string; name: string; matches: typeof searchResults }>();
    for (const m of searchResults) {
      let g = map.get(m.path);
      if (!g) {
        g = { path: m.path, name: m.name, matches: [] };
        map.set(m.path, g);
      }
      g.matches.push(m);
    }
    return [...map.values()];
  }, [searchResults]);

  const toggleGroup = (path: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const highlightRe = useMemo(
    () => buildHighlightRegExp(query.trim(), searchOptions),
    [query, searchOptions],
  );
```

**4d.** 工具条——把：

```tsx
        <Button variant="ghost" size="icon-xs" title="清除" onClick={() => setQuery("")}>
          <X size={13} />
        </Button>
      </div>
```

替换为：

```tsx
        <Button variant="ghost" size="icon-xs" title="清除" onClick={() => setQuery("")}>
          <X size={13} />
        </Button>
        <Button variant="ghost" size="icon-xs" title="折叠全部" onClick={() => setCollapsed(new Set(groups.map((g) => g.path)))}>
          <ChevronsDownUp size={13} />
        </Button>
        <Button variant="ghost" size="icon-xs" title="展开全部" onClick={() => setCollapsed(new Set())}>
          <ChevronsUpDown size={13} />
        </Button>
      </div>
```

（`groups` 在 4c 已声明，位于本 JSX 之前。）

**4e.** 结果区——把整块（从 `<div className="space-y-1" data-testid="search-result-list">` 到其闭合 `</div>`，即 T6 的扁平列表）替换为：

```tsx
          <div data-testid="search-result-list">
            {groups.map((g, gi) => {
              const isCollapsed = collapsed.has(g.path);
              const rowOffset = groups.slice(0, gi).reduce((n, x) => n + x.matches.length, 0);
              return (
                <div key={g.path} className="mb-1">
                  {/* 组头：折叠箭头 + 图标 + 名称 + 相对路径 + 计数徽标 */}
                  <button
                    type="button"
                    aria-expanded={!isCollapsed}
                    onClick={() => toggleGroup(g.path)}
                    className="flex w-full items-center gap-1.5 px-2 py-1 rounded-[var(--radius-sm)] hover:bg-[var(--overlay-hover)] text-left"
                  >
                    <ChevronRight size={12} className={`flex-none text-[var(--text-tertiary)] transition-transform ${isCollapsed ? "" : "rotate-90"}`} />
                    <FileCode size={13} className="flex-none text-[var(--text-tertiary)]" />
                    <span className="flex-none max-w-[40%] truncate text-sm text-[var(--text-primary)]">{g.name}</span>
                    <span className="truncate text-xs text-[var(--text-tertiary)]">{relativeToProject(g.path, project?.path)}</span>
                    <span data-count-badge className="ml-auto flex-none rounded-full bg-[var(--overlay-ghost)] px-1.5 text-xs text-[var(--text-secondary)]">{g.matches.length}</span>
                  </button>
                  {/* 折叠高度过渡：grid-rows 技巧（CSS 见 globals.css，T10） */}
                  <div className="search-collapse" style={{ gridTemplateRows: isCollapsed ? "0fr" : "1fr" }}>
                    <div className="search-collapse-inner">
                      {g.matches.map((m, i) => (
                        <button
                          key={`${m.path}:${m.line ?? 0}:${i}`}
                          onClick={() => void openFile(m.path, m.line != null ? { line: m.line } : undefined)}
                          className="search-stagger w-full text-left pl-7 pr-3 py-1 rounded-[var(--radius-sm)] hover:bg-[var(--glass-2-surface)] transition-colors"
                          style={{ animationDelay: `${Math.min(rowOffset + i, 19) * 25}ms` }}
                        >
                          {m.line != null ? (
                            <>
                              <span className="mr-2 text-xs text-[var(--text-tertiary)]">{m.line}</span>
                              <span className="text-xs font-mono text-[var(--text-secondary)]">
                                <Highlighted text={m.text} ranges={matchRanges(m.text, highlightRe)} />
                              </span>
                            </>
                          ) : (
                            <span className="text-xs text-[var(--text-tertiary)] italic">文件名匹配</span>
                          )}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
```

- [ ] **Step 5: 跑绿**——`pnpm vitest run src/features/search/`（三份面板测试 + 高亮纯函数）全绿。

- [ ] **Step 6: 提交**——`feat(search-panel): 按文件分组/命中高亮/折叠与行跳转`

---

### Task 8: 替换流（替换行 + 预览 + 确认 dialog + 写盘 + 自动重搜，TDD）

**Files:**
- Create: `src/components/ui/alert-dialog.tsx`
- Modify: `src/features/search/SearchPanel.tsx`（替换行 + 说明文案 + 确认 dialog + 组头/行级替换按钮）
- Create: `src/features/search/SearchPanel.replace.test.tsx`

**Interfaces:**
- Consumes: T4 的 `previewReplace/applyReplace/replacePreview/replacing`；T7 的 `groups`。
- 替换全部流：按钮 → `previewReplace` → `replacePreview.total > 0` 时弹 AlertDialog（「将修改 X 个文件共 Y 处。此操作直接写盘，请确认。」；`truncated` 时追加警示「结果已达上限，仅替换前 N 处所在文件。」）→ 确认 → `applyReplace(proj, query, replacement)`（paths=null 全部）→ 成功后**自动重搜** `search(proj, query)`。
- 组头「替换本文件全部匹配」→ `applyReplace(proj, query, replacement, { paths: [g.path] })` → 重搜。
- 行级「替换本文件首个匹配」→ `applyReplace(proj, query, replacement, { paths: [g.path], limitPerFile: 1 })` → 重搜（单条替换语义＝该文件内首个匹配，裁定 B4；刷新后命中位置自然变化）。
- 替换行下方说明文案（逐字）：「已打开的未保存文件会标记为过期」（写盘后 fs-changed 链路自动同步：干净页签静默刷新、dirty 页签 stale 黄条——不抑制 watcher，裁定 B6）。
- 正则捕获组：replacement 原样透传后端，`$1`/`${name}` 由 regex crate 展开（裁定 B5），占位符提示写明。

- [ ] **Step 1: 创建 AlertDialog 组件**——`src/components/ui/alert-dialog.tsx`（radix-ui 统一包，样式镜像 dialog.tsx 玻璃语言）：

```tsx
import * as React from "react"
import { AlertDialog as AlertDialogPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"
import { buttonVariants } from "@/components/ui/button"

function AlertDialog({
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Root>) {
  return <AlertDialogPrimitive.Root data-slot="alert-dialog" {...props} />
}

function AlertDialogTrigger({
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Trigger>) {
  return <AlertDialogPrimitive.Trigger data-slot="alert-dialog-trigger" {...props} />
}

function AlertDialogPortal({
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Portal>) {
  return <AlertDialogPrimitive.Portal data-slot="alert-dialog-portal" {...props} />
}

function AlertDialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Overlay>) {
  return (
    <AlertDialogPrimitive.Overlay
      data-slot="alert-dialog-overlay"
      className={cn(
        "fixed inset-0 z-50 bg-black/20 backdrop-blur-[2px] data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0",
        className
      )}
      {...props}
    />
  )
}

function AlertDialogContent({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Content>) {
  return (
    <AlertDialogPortal data-slot="alert-dialog-portal">
      <AlertDialogOverlay />
      <AlertDialogPrimitive.Content
        data-slot="alert-dialog-content"
        className={cn(
          "fixed top-[50%] left-[50%] z-50 grid w-full max-w-[calc(100%-2rem)] translate-x-[-50%] translate-y-[-50%] gap-4 rounded-lg border border-[color:var(--glass-border)] bg-background/90 p-6 shadow-lg backdrop-blur-xl duration-200 outline-none data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 sm:max-w-lg",
          className
        )}
        {...props}
      />
    </AlertDialogPortal>
  )
}

function AlertDialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-dialog-header"
      className={cn("flex flex-col gap-2 text-center sm:text-left", className)}
      {...props}
    />
  )
}

function AlertDialogFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-dialog-footer"
      className={cn("flex flex-col-reverse gap-2 sm:flex-row sm:justify-end", className)}
      {...props}
    />
  )
}

function AlertDialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Title>) {
  return (
    <AlertDialogPrimitive.Title
      data-slot="alert-dialog-title"
      className={cn("text-lg leading-none font-semibold", className)}
      {...props}
    />
  )
}

function AlertDialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Description>) {
  return (
    <AlertDialogPrimitive.Description
      data-slot="alert-dialog-description"
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  )
}

function AlertDialogAction({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Action>) {
  return (
    <AlertDialogPrimitive.Action className={cn(buttonVariants(), className)} {...props} />
  )
}

function AlertDialogCancel({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Cancel>) {
  return (
    <AlertDialogPrimitive.Cancel
      className={cn(buttonVariants({ variant: "outline" }), className)}
      {...props}
    />
  )
}

export {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogOverlay,
  AlertDialogPortal,
  AlertDialogTitle,
  AlertDialogTrigger,
}
```

- [ ] **Step 2: 先写测试（红）**——创建 `src/features/search/SearchPanel.replace.test.tsx`：

```tsx
/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

type SearchOptions = { caseSensitive: boolean; wholeWord: boolean; regex: boolean };
type SearchMatch = { path: string; name: string; line: number | null; text: string };
type ReplacePreview = { files: { path: string; count: number }[]; total: number; truncated: boolean };

let fsState: {
  searchResults: SearchMatch[];
  searching: boolean;
  searchError: string | null;
  searchOptions: SearchOptions;
  replacePreview: ReplacePreview | null;
  replacing: boolean;
  search: ReturnType<typeof vi.fn>;
  clearSearch: ReturnType<typeof vi.fn>;
  setSearchOptions: ReturnType<typeof vi.fn>;
  openFile: ReturnType<typeof vi.fn>;
  previewReplace: ReturnType<typeof vi.fn>;
  applyReplace: ReturnType<typeof vi.fn>;
  clearReplacePreview: ReturnType<typeof vi.fn>;
};
vi.mock("../../stores/fs.store", () => ({
  useFsStore: Object.assign(
    (sel?: (s: typeof fsState) => unknown) => (sel ? sel(fsState) : fsState),
    { getState: () => fsState },
  ),
}));

let projectState: { projects: { id: string; path: string }[]; activeProjectId: string | null };
vi.mock("../../stores/project.store", () => ({
  useProjectStore: Object.assign(
    (sel?: (s: typeof projectState) => unknown) => (sel ? sel(projectState) : projectState),
    { getState: () => projectState },
  ),
}));

import { SearchPanel } from "./SearchPanel";

beforeEach(() => {
  // 假定时器：冻结搜索防抖，替换流断言只验证显式路径（预览/写盘/重搜）
  vi.useFakeTimers();
  fsState = {
    searchResults: [
      { path: "/proj/src/a.ts", name: "a.ts", line: 1, text: "const foo = 1;" },
      { path: "/proj/src/a.ts", name: "a.ts", line: 3, text: "let foo2 = 2;" },
    ],
    searching: false,
    searchError: null,
    searchOptions: { caseSensitive: false, wholeWord: false, regex: false },
    replacePreview: null,
    replacing: false,
    search: vi.fn().mockResolvedValue(undefined),
    clearSearch: vi.fn(),
    setSearchOptions: vi.fn(),
    openFile: vi.fn().mockResolvedValue(undefined),
    previewReplace: vi.fn().mockResolvedValue(undefined),
    applyReplace: vi.fn().mockResolvedValue({ filesChanged: 1, replacements: 2 }),
    clearReplacePreview: vi.fn(),
  };
  projectState = { projects: [{ id: "p1", path: "/proj" }], activeProjectId: "p1" };
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

function fillQueryAndReplacement() {
  render(<SearchPanel />);
  fireEvent.change(screen.getByLabelText("搜索"), { target: { value: "foo" } });
  fireEvent.change(screen.getByLabelText("替换"), { target: { value: "bar" } });
}

describe("replace-all flow", () => {
  it("previews, confirms in dialog, applies, then auto re-searches", async () => {
    fsState.previewReplace = vi.fn(async () => {
      fsState.replacePreview = { files: [{ path: "/proj/src/a.ts", count: 2 }], total: 2, truncated: false };
    });
    fillQueryAndReplacement();
    fireEvent.click(screen.getByRole("button", { name: "替换全部" }));
    await act(async () => {}); // 等 previewReplace resolve + 本地 setState
    expect(fsState.previewReplace).toHaveBeenCalledWith("/proj", "foo", "bar");
    expect(screen.getByText("将修改 1 个文件共 2 处。此操作直接写盘，请确认。")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "确认替换" }));
    await act(async () => {});
    expect(fsState.applyReplace).toHaveBeenCalledWith("/proj", "foo", "bar", undefined);
    // 自动重搜
    expect(fsState.search).toHaveBeenCalledWith("/proj", "foo");
  });

  it("shows the truncation warning when the preview hit the cap", async () => {
    fsState.previewReplace = vi.fn(async () => {
      fsState.replacePreview = { files: [{ path: "/proj/big.txt", count: 200 }], total: 200, truncated: true };
    });
    fillQueryAndReplacement();
    fireEvent.click(screen.getByRole("button", { name: "替换全部" }));
    await act(async () => {});
    expect(screen.getByText("结果已达上限，仅替换前 200 处所在文件。")).toBeTruthy();
  });

  it("cancel closes the dialog without applying", async () => {
    fsState.previewReplace = vi.fn(async () => {
      fsState.replacePreview = { files: [{ path: "/proj/src/a.ts", count: 2 }], total: 2, truncated: false };
    });
    fillQueryAndReplacement();
    fireEvent.click(screen.getByRole("button", { name: "替换全部" }));
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(fsState.applyReplace).not.toHaveBeenCalled();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("replace-all is disabled without a query", () => {
    render(<SearchPanel />);
    expect((screen.getByRole("button", { name: "替换全部" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("explains the stale-banner behavior under the replace row", () => {
    render(<SearchPanel />);
    expect(screen.getByText("已打开的未保存文件会标记为过期")).toBeTruthy();
  });
});

describe("scoped replaces", () => {
  it("group-header button replaces all matches in that file, then re-searches", async () => {
    fillQueryAndReplacement();
    fireEvent.click(screen.getByTitle("替换本文件全部匹配"));
    await act(async () => {});
    expect(fsState.applyReplace).toHaveBeenCalledWith("/proj", "foo", "bar", { paths: ["/proj/src/a.ts"] });
    expect(fsState.search).toHaveBeenCalledWith("/proj", "foo");
  });

  it("row button replaces the first match in that file (limitPerFile=1)", async () => {
    fillQueryAndReplacement();
    fireEvent.click(screen.getAllByTitle("替换本文件首个匹配")[0]);
    await act(async () => {});
    expect(fsState.applyReplace).toHaveBeenCalledWith("/proj", "foo", "bar", {
      paths: ["/proj/src/a.ts"],
      limitPerFile: 1,
    });
    expect(fsState.search).toHaveBeenCalledWith("/proj", "foo");
  });
});
```

- [ ] **Step 3: 实现替换 UI**——`src/features/search/SearchPanel.tsx` 做以下 Edit：

**3a.** 导入——把 `import { ChevronRight, ChevronsDownUp, ChevronsUpDown, FileCode, Loader2, RefreshCw, Search, X } from "lucide-react";` 替换为：

```tsx
import { ChevronRight, ChevronsDownUp, ChevronsUpDown, FileCode, Loader2, RefreshCw, Replace, Search, X } from "lucide-react";
```

在 AlertDialog 组件导入位置（`import { Input } from "@/components/ui/input";` 之后）插入：

```tsx
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
```

**3b.** 状态与选择器——把 `const [collapsed, setCollapsed] = useState<Set<string>>(new Set());` 替换为：

```tsx
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [replacement, setReplacement] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);
```

在 `const openFile = useFsStore((s) => s.openFile);` 之后插入：

```tsx
  const replacePreview = useFsStore((s) => s.replacePreview);
  const replacing = useFsStore((s) => s.replacing);
  const previewReplace = useFsStore((s) => s.previewReplace);
  const applyReplace = useFsStore((s) => s.applyReplace);
```

**3c.** 处理器——在 `const fileCount = useMemo(…);` 之后插入：

```tsx
  // 替换后自动重搜：写盘 → fs-changed → syncExternalChange 静默/stale 同步
  // 已打开文件（不抑制 watcher）；面板随即用同一 query/options 刷新结果。
  const reSearch = () => {
    const path = activeProjectPath();
    if (path && query.trim()) void search(path, query);
  };

  const startReplaceAll = async () => {
    const path = activeProjectPath();
    if (!path || !query.trim() || inlineError) return;
    await previewReplace(path, query, replacement);
    const preview = useFsStore.getState().replacePreview;
    if (preview && preview.total > 0) setConfirmOpen(true);
  };

  const confirmReplaceAll = async () => {
    setConfirmOpen(false);
    const path = activeProjectPath();
    if (!path) return;
    const result = await applyReplace(path, query, replacement, undefined); // 显式 undefined=全项目（paths=null）
    if (result) reSearch();
  };

  const replaceInFile = async (filePath: string) => {
    const path = activeProjectPath();
    if (!path || !query.trim() || inlineError) return;
    const result = await applyReplace(path, query, replacement, { paths: [filePath] });
    if (result) reSearch();
  };

  const replaceFirstInFile = async (filePath: string) => {
    const path = activeProjectPath();
    if (!path || !query.trim() || inlineError) return;
    const result = await applyReplace(path, query, replacement, { paths: [filePath], limitPerFile: 1 });
    if (result) reSearch();
  };
```

（`useFsStore.getState()` 需要导入——`useFsStore` 已在导入中。）

**3d.** 替换行 + 说明文案——把「可选过滤行预留位」整块：

```tsx
      {/* 可选过滤行预留位（glob，v1 不接后端） */}
```

之前插入：

```tsx
      {/* 替换行 */}
      <div className="px-1 pb-1">
        <div className="flex items-center gap-1">
          <Input
            value={replacement}
            onChange={(e) => setReplacement(e.target.value)}
            placeholder="替换…（正则模式支持 $1 / ${name}）"
            aria-label="替换"
          />
          <Button
            size="sm"
            variant="ghost"
            title="替换全部"
            disabled={replacing || !query.trim() || !!inlineError}
            onClick={() => void startReplaceAll()}
          >
            替换全部
          </Button>
        </div>
        <p className="mt-1 px-1 text-[11px] text-[var(--text-tertiary)]">已打开的未保存文件会标记为过期</p>
      </div>

```

**3e.** 组头替换按钮——把 T7 组头中的：

```tsx
                    <span data-count-badge className="ml-auto flex-none rounded-full bg-[var(--overlay-ghost)] px-1.5 text-xs text-[var(--text-secondary)]">{g.matches.length}</span>
                  </button>
```

替换为：

```tsx
                    <span data-count-badge className="ml-auto flex-none rounded-full bg-[var(--overlay-ghost)] px-1.5 text-xs text-[var(--text-secondary)]">{g.matches.length}</span>
                  </button>
                  {/* 整文件替换：悬浮显示，直写该文件全部匹配 */}
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    title="替换本文件全部匹配"
                    disabled={replacing}
                    className="absolute right-1 top-1 opacity-0 group-hover/header:opacity-100"
                    onClick={() => void replaceInFile(g.path)}
                  >
                    <Replace size={12} />
                  </Button>
```

并把组头所在的外层 `<div key={g.path} className="mb-1">` 改为 `<div key={g.path} className="group/header relative mb-1">`。

**3f.** 行级替换按钮——把 T7 行按钮的 className：

```tsx
                          className="search-stagger w-full text-left pl-7 pr-3 py-1 rounded-[var(--radius-sm)] hover:bg-[var(--glass-2-surface)] transition-colors"
```

替换为：

```tsx
                          className="group/row search-stagger relative w-full text-left pl-7 pr-7 py-1 rounded-[var(--radius-sm)] hover:bg-[var(--glass-2-surface)] transition-colors"
```

并在该行按钮内最后（`</button>` 之前）插入：

```tsx
                          <span
                            role="button"
                            title="替换本文件首个匹配"
                            className="absolute right-1 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)] opacity-0 group-hover/row:opacity-100 hover:text-[var(--text-primary)]"
                            onClick={(e) => {
                              e.stopPropagation();
                              void replaceFirstInFile(g.path);
                            }}
                          >
                            <Replace size={11} />
                          </span>
```

**3g.** 确认 dialog——在组件最外层 `<div className="flex flex-col h-full">` 的闭合 `</div>` 之前插入：

```tsx
      {/* 替换全部确认 */}
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>替换全部</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-1">
                <p>将修改 {replacePreview?.files.length ?? 0} 个文件共 {replacePreview?.total ?? 0} 处。此操作直接写盘，请确认。</p>
                {replacePreview?.truncated && (
                  <p className="text-[var(--warning)]">结果已达上限，仅替换前 {replacePreview.total} 处所在文件。</p>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={() => void confirmReplaceAll()}>确认替换</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
```

- [ ] **Step 4: 跑绿**——`pnpm vitest run src/features/search/` 全绿；`pnpm build` 过类型门槛。

- [ ] **Step 5: 提交**——`feat(search-panel): 全项目替换流（预览/确认/写盘/重搜）`

---

### Task 9: search.focus 聚焦计数 + 面板本地快捷键（TDD）

**Files:**
- Modify: `src/stores/ui.store.ts`（+searchFocusRequest/requestSearchFocus）
- Modify: `src/stores/ui.settings.test.ts`（+1 用例）
- Modify: `src/commands/registry.ts`（search.focus run）
- Modify: `src/commands/registry.run.test.ts`（mock 增补 + 1 describe）
- Modify: `src/features/search/SearchPanel.tsx`（聚焦 effect + Enter/Shift+Enter/Ctrl+Alt+Enter）
- Modify: `src/features/search/SearchPanel.test.tsx`（+聚焦/导航用例）

**Interfaces:**
- ui.store 契约：
  ```ts
  searchFocusRequest: number;   // 初值 0；自增计数触发聚焦（避免布尔黏滞），不进 partialize（不持久化）
  requestSearchFocus: () => void; // 一次 set 内：sidePanelTab="search" + sidePanelVisible=true + 计数 +1
  ```
- `search.focus` run 改为 `useUiStore.getState().requestSearchFocus()`（键位 `primary+shift+keyf` 不动，registry.test.ts 既有断言继续绿）。
- 面板本地 keydown（**不进全局注册表**，面板作用域，避免全局吞键）：
  - 搜索输入框 `Enter` → 下一个结果（`activeIndex` 游标 +1 取模，`openFile(path, { line })` 跳转并高亮当前行）；`Shift+Enter` → 上一个；
  - 面板根 `Ctrl+Alt+Enter` → 触发 `startReplaceAll()`（与按钮同路径）。
- 全局分发器在焦点位于输入框时让行（KeybindingHost 现状），本地 Enter 与全局命令零冲突，无需改 KeybindingHost。

- [ ] **Step 1: 先写 ui.store 测试（红）**——在 `src/stores/ui.settings.test.ts` 末尾追加：

```ts
describe("search focus request counter", () => {
  it("requestSearchFocus switches to the search tab, shows the panel and bumps the counter", () => {
    const before = useUiStore.getState().searchFocusRequest;
    useUiStore.setState({ sidePanelTab: "files", sidePanelVisible: false });
    useUiStore.getState().requestSearchFocus();
    const s = useUiStore.getState();
    expect(s.sidePanelTab).toBe("search");
    expect(s.sidePanelVisible).toBe(true);
    expect(s.searchFocusRequest).toBe(before + 1);
    // 连续触发必须继续自增（计数而非布尔黏滞）
    useUiStore.getState().requestSearchFocus();
    expect(useUiStore.getState().searchFocusRequest).toBe(before + 2);
  });
});
```

- [ ] **Step 2: 实现 ui.store**——`src/stores/ui.store.ts`：

接口内 `settingsOpen: boolean;` 之后插入：

```ts
  /** 自增计数触发搜索面板聚焦；不持久化（partialize 未收录即生效）。 */
  searchFocusRequest: number;
```

接口内 `closeSettings: () => void;` 之后插入：

```ts
  requestSearchFocus: () => void;
```

初始值内 `settingsOpen: false,` 之后插入：

```ts
      searchFocusRequest: 0,
```

`closeSettings: () => set((s) => { s.settingsOpen = false; }),` 之后插入：

```ts
      requestSearchFocus: () => set((s) => {
        s.sidePanelTab = "search";
        s.sidePanelVisible = true;
        s.searchFocusRequest += 1;
      }),
```

（`partialize` 白名单不含 `searchFocusRequest`——天然不持久化，勿加入。）

- [ ] **Step 3: 改命令 run + 其测试（红→绿）**——`src/commands/registry.run.test.ts`：

在模块级声明区 `let setEditorVisible: ReturnType<typeof vi.fn>;` 之后插入：

```ts
let requestSearchFocus: ReturnType<typeof vi.fn>;
```

把 ui.store mock：

```ts
vi.mock("../stores/ui.store", () => ({
  useUiStore: { getState: () => ({ setEditorVisible }) },
}));
```

替换为：

```ts
vi.mock("../stores/ui.store", () => ({
  useUiStore: { getState: () => ({ setEditorVisible, requestSearchFocus }) },
}));
```

`beforeEach` 内 `setEditorVisible = vi.fn();` 之后插入：

```ts
  requestSearchFocus = vi.fn();
```

文件末尾追加：

```ts
describe("search.focus run", () => {
  it("requests search focus through the ui store (counter trigger)", () => {
    getCommand("search.focus")!.run();
    expect(requestSearchFocus).toHaveBeenCalledTimes(1);
  });
});
```

`src/commands/registry.ts`——把 `search.focus` 命令的：

```ts
    run: () => useUiStore.getState().setSidePanelTab("search"),
```

替换为：

```ts
    run: () => useUiStore.getState().requestSearchFocus(),
```

- [ ] **Step 4: 面板聚焦 + 导航测试（红）**——在 `src/features/search/SearchPanel.test.tsx` 的 `import { SearchPanel } from "./SearchPanel";` 之后插入真实 ui.store 导入：

```ts
import { useUiStore } from "../../stores/ui.store";
```

文件末尾追加（真实 store，jsdom 有 localStorage 可持久化，用例自行复位）：

```tsx
describe("search.focus integration (counter trigger)", () => {
  beforeEach(() => {
    useUiStore.setState({ searchFocusRequest: 0, sidePanelTab: "files", sidePanelVisible: true });
  });

  it("focuses the search input when the counter bumps", () => {
    render(<SearchPanel />);
    const input = screen.getByLabelText("搜索");
    expect(document.activeElement).not.toBe(input);
    act(() => { useUiStore.getState().requestSearchFocus(); });
    expect(document.activeElement).toBe(input);
    expect(useUiStore.getState().sidePanelTab).toBe("search");
  });
});

describe("panel-local result navigation", () => {
  beforeEach(() => {
    fsState.searchResults = [
      { path: "/proj/a.ts", name: "a.ts", line: 3, text: "foo one" },
      { path: "/proj/b.ts", name: "b.ts", line: 7, text: "foo two" },
    ];
  });

  it("Enter jumps to the next result (wrapping); Shift+Enter to the previous", () => {
    render(<SearchPanel />);
    const input = screen.getByLabelText("搜索");
    fireEvent.change(input, { target: { value: "foo" } });

    fireEvent.keyDown(input, { key: "Enter" });
    expect(fsState.openFile).toHaveBeenLastCalledWith("/proj/a.ts", { line: 3 });

    fireEvent.keyDown(input, { key: "Enter" });
    expect(fsState.openFile).toHaveBeenLastCalledWith("/proj/b.ts", { line: 7 });

    fireEvent.keyDown(input, { key: "Enter" });
    expect(fsState.openFile).toHaveBeenLastCalledWith("/proj/a.ts", { line: 3 }); // 回卷

    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(fsState.openFile).toHaveBeenLastCalledWith("/proj/b.ts", { line: 7 });
  });

  it("Ctrl+Alt+Enter triggers the replace-all preview from anywhere in the panel", async () => {
    fsState.previewReplace = vi.fn().mockResolvedValue(undefined);
    render(<SearchPanel />);
    const input = screen.getByLabelText("搜索");
    fireEvent.change(input, { target: { value: "foo" } });
    fireEvent.keyDown(input, { key: "Enter", ctrlKey: true, altKey: true });
    await act(async () => {});
    expect(fsState.previewReplace).toHaveBeenCalledWith("/proj", "foo", "");
    // 普通 Enter 不得触发替换预览
    expect(fsState.previewReplace).toHaveBeenCalledTimes(1);
  });
});
```

注意：`fsState` 类型需含 `previewReplace`——在本测试文件顶部的 `fsState` 类型声明中补：

```ts
  previewReplace?: ReturnType<typeof vi.fn>;
  applyReplace?: ReturnType<typeof vi.fn>;
```

并在 `beforeEach` 的 fsState 初始化中补：

```ts
    previewReplace: vi.fn().mockResolvedValue(undefined),
    applyReplace: vi.fn().mockResolvedValue(null),
```

（面板通过 selector 读取这两个 action；mock 缺失会得到 undefined。）

- [ ] **Step 5: 面板实现**——`src/features/search/SearchPanel.tsx` 做以下 Edit：

**5a.** 在 `import { useFsStore } from "../../stores/fs.store";` 之后插入：

```tsx
import { useUiStore } from "../../stores/ui.store";
```

**5b.** 状态——把 `const [confirmOpen, setConfirmOpen] = useState(false);` 替换为：

```tsx
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
```

在 `const inputRef = useRef<HTMLInputElement>(null);` 之后插入：

```tsx
  const searchFocusRequest = useUiStore((s) => s.searchFocusRequest);
```

**5c.** 聚焦 effect——在防抖 useEffect 之后插入：

```tsx
  // search.focus 命令经计数触发聚焦；0 为初值，挂载时不抢焦点。
  useEffect(() => {
    if (searchFocusRequest > 0) inputRef.current?.focus();
  }, [searchFocusRequest]);

  // 查询或结果变化时复位导航游标。
  useEffect(() => {
    setActiveIndex(-1);
  }, [query, searchResults]);
```

**5d.** 类型导入——把文件顶部：

```tsx
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
```

替换为：

```tsx
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
```

**5e.** 导航处理器——在 `reSearch` 定义之前插入：

```tsx
  // 面板本地 Enter/Shift+Enter：在扁平化结果序列中移动游标并跳转编辑器。
  // 全局分发器在输入框焦点下让行，二者不会双触发。
  const stepResult = (dir: 1 | -1) => {
    if (searchResults.length === 0) return;
    const next = (activeIndex + dir + searchResults.length) % searchResults.length;
    setActiveIndex(next);
    const m = searchResults[next];
    void openFile(m.path, m.line != null ? { line: m.line } : undefined);
  };

  const handleSearchKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    // 带修饰键的 Enter（Ctrl+Alt+Enter 替换全部）交给根容器处理器，这里不介入
    if (e.key !== "Enter" || e.ctrlKey || e.altKey || e.metaKey) return;
    e.preventDefault();
    if (e.shiftKey) stepResult(-1);
    else stepResult(1);
  };
```

**5f.** 搜索输入框绑定——把：

```tsx
          <Input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索…"
            aria-label="搜索"
```

替换为：

```tsx
          <Input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleSearchKeyDown}
            placeholder="搜索…"
            aria-label="搜索"
```

**5g.** 根容器 Ctrl+Alt+Enter——把组件 return 的第一行：

```tsx
    <div className="flex flex-col h-full">
```

替换为：

```tsx
    <div
      className="flex flex-col h-full"
      onKeyDown={(e) => {
        // 面板作用域：替换全部快捷键不进全局注册表
        if (e.key === "Enter" && e.ctrlKey && e.altKey) {
          e.preventDefault();
          void startReplaceAll();
        }
      }}
    >
```

**5h.** 当前行高亮——把 T7 行按钮 className 中的 `group/row search-stagger relative w-full text-left pl-7 pr-7 py-1 rounded-[var(--radius-sm)] hover:bg-[var(--glass-2-surface)] transition-colors` 替换为（加 active 背景，flat index 判定）：

```tsx
group/row search-stagger relative w-full text-left pl-7 pr-7 py-1 rounded-[var(--radius-sm)] hover:bg-[var(--glass-2-surface)] transition-colors ${rowOffset + i === activeIndex ? "bg-[var(--overlay-ghost)]" : ""}
```

注意：该行 className 需从普通字符串改为模板字符串（反引号包裹）。

- [ ] **Step 6: 跑绿**——`pnpm vitest run src/features/search/ src/stores/ui.settings.test.ts src/commands/registry.run.test.ts src/commands/registry.test.ts` 全绿（registry.test.ts 的 `primary+shift+keyf` 断言验证键位未动）。

- [ ] **Step 7: 提交**——`feat(search): search.focus 聚焦计数与面板内结果导航快捷键`

---

### Task 10: 微交互（stagger 渐显 / 折叠过渡 / 计数淡入）

**Files:**
- Modify: `src/styles/globals.css`（尾部追加）
- Modify: `src/features/search/SearchPanel.tsx`（统计条计数淡入）

**Interfaces / 约束:**
- 不为动效增加任何依赖；全部走 CSS（keyframes + 既有 tw-animate-css 的 `animate-in fade-in-0`，dialog.tsx 已在用）。
- stagger 上限前 20 条（T7 行内 `animationDelay: min(index, 19) * 25ms` 已就位，本任务补 keyframe 使其生效）。
- 折叠高度过渡：T7 已用 `search-collapse` 类 + 内联 `gridTemplateRows`，本任务补类定义（grid-rows 技巧，150ms）。
- 计数淡入：统计条数字以 `key` 重挂载 + fade-in。

- [ ] **Step 1: globals.css 追加**——在 `src/styles/globals.css` 末尾追加：

```css
/* Search panel micro-interactions (Plan 5) — restraint: 150ms, no new deps. */

/* 结果行 stagger 渐显；animation-delay 由行内样式按索引给出（上限前 20 条）。 */
@keyframes search-stagger-in {
  from { opacity: 0; transform: translateY(2px); }
  to { opacity: 1; transform: none; }
}
.search-stagger {
  animation: search-stagger-in 150ms ease-out both;
}

/* 组折叠高度过渡：grid-template-rows 0fr ↔ 1fr 技巧（150ms）。 */
.search-collapse {
  display: grid;
  transition: grid-template-rows 150ms ease-out;
}
.search-collapse-inner {
  overflow: hidden;
  min-height: 0;
}
```

- [ ] **Step 2: 统计条计数淡入**——`src/features/search/SearchPanel.tsx` 把统计条的：

```tsx
            <span>{searchResults.length} 个结果 / {fileCount} 个文件</span>
```

替换为：

```tsx
            <span key={`${searchResults.length}:${fileCount}`} className="animate-in fade-in-0 duration-150">
              {searchResults.length} 个结果 / {fileCount} 个文件
            </span>
```

- [ ] **Step 3: 门槛**——`pnpm lint && pnpm build && pnpm test`（动效无单测，以门槛 + 手工观察为准）。

- [ ] **Step 4: 提交**——`style(search-panel): 结果渐显/折叠过渡/计数淡入微交互`

---

### Task 11: 全量门槛 + 差异自检 + 手工冒烟

**Files:** 无代码改动（若冒烟发现缺陷，修复归入对应 scope 另起提交）。

- [ ] **Step 1: 全量门槛**——在仓库根依次执行并确认全绿：

```bash
pnpm lint          # 既有 6 条 warning 可接受，不得新增 error
pnpm build         # 真实类型门槛（tsc -b + vite build）
pnpm test          # 全量 vitest
cargo test --manifest-path src-tauri/Cargo.toml   # Rust 全量（fs_test.rs 新增 13 条 / 合计 15 条）
```

- [ ] **Step 2: 差异自检（只读，控制器统一提交）**——`git status --short` 与 `git diff --stat` 核对改动文件与 File Structure 表逐一对应；确认无计划外文件（特别注意 `src/features/agent/AgentComposer.tsx` 不得出现在 diff 中——fsSearch 缺省参数应使其零改动）。

- [ ] **Step 3: 手工冒烟清单**（`pnpm tauri dev`，逐条过）：

  1. **匹配规则**：搜索 `foo` → 默认不区分大小写；按 `Aa` → 仅 `Foo`；`ab|` 全词排除 `food`/`concat`；`.*` 输入 `\d+` 命中数字；输入 `([` → 红框 + 行内「无效的正则表达式: ([」且不搜。
  2. **正则替换捕获组（B5）**：正则模式搜 `(\w+)@(\w+)`，替换框 `$2/$1`，替换全部 → 确认后 `user@host` 变 `host/user`。
  3. **stale 横幅联动（B6）**：打开一文件并改一个字（dirty），面板替换全部命中该文件 → ~500ms 内出现黄条「文件在磁盘上已被修改」（重新加载/保留）；另开一干净文件命中 → 内容静默更新、无黄条。替换行下方说明文案可见。
  4. **行定位（B7）**：结果行点击 → 编辑器打开（预览斜体）并滚动选中目标行（居中）；同文件再点另一行 → 视图不重建、光标跳到新行；`Ctrl+Shift+F` → 侧栏切搜索页签且输入框聚焦。
  5. **上限截断文案（B3）**：造一个 250+ 行同词命中的文件 → 统计条显示 200 个结果；替换全部 → 确认 dialog 出现「结果已达上限，仅替换前 200 处所在文件。」；确认后实际只改前 200 处。
  6. **单条/单文件**：行悬浮点小替换图标 → 该文件首个匹配被改（结果自动重搜、命中位置变化）；组头替换图标 → 仅该文件全部匹配被改，其他文件不动。
  7. **面板快捷键**：搜索框 Enter/Shift+Enter 在结果间循环跳转（当前行高亮）；`Ctrl+Alt+Enter` 触发替换全部预览流；输入框内打字不触发任何全局命令。
  8. **微交互**：结果渐显有 stagger（前 20 行）、组折叠高度平滑过渡、统计数字变化淡入。
  9. **预留位**：glob 过滤输入框禁用、hover 提示「后续版本支持」。

- [ ] **Step 4: 收尾**——向控制器报告门槛输出与冒烟结论；控制器统一提交。

---

## 验收对照（spec F4 + 验收段）

| spec 条目 | 落点 |
|---|---|
| 顶工具条：刷新/清除/折叠/展开 | T6（刷新/清除）+ T7（折叠/展开） |
| 搜索行三开关 + 非法正则红框行内错误且不搜 | T6（`regexError` 预校验 + `searchError` 后端兜底） |
| 替换行 + 替换全部；单条/单文件在结果里 | T8（替换行/组头按钮/行级按钮） |
| glob 过滤行 UI 位预留（v1 后置，非目标） | T6 禁用输入框 + title |
| 按文件分组（图标+名+相对路径+计数徽标）/命中高亮/点行定位 | T7（`<mark>` + `openFile(…, { line })`）+ T5（dispatch + scrollIntoView） |
| 统计条「N 结果 / M 文件」+ 搜索中 spinner | T6 |
| 微交互：stagger/折叠过渡/计数淡入（替换后闪烁移除以「自动重搜 + stagger」替代，克制实现） | T10 + T8 重搜 |
| 匹配语义：默认不敏感子串 / Aa / ab\| / .\* / 组合 | T1 `compile_pattern`（`(?i)` + escape + `\b(?:…)\b`） |
| 全项目磁盘替换：预览→确认→写盘 | T2 + T8 |
| fs-changed 协同：干净静默 / 草稿 stale 横幅 + 面板文案点明 | B6 顺势利用既有链路；T8 说明文案 |
| 替换后自动重搜；正则捕获组 `$1`/`${name}` | T8 `reSearch()`；T2 `Captures::expand` 透传 |
| `.gitignore`/隐藏过滤、`MAX_RESULTS`/大小上限（替换同受约束） | T2 `replace_candidates` + 共享预算（预览/写盘一致） |
| 快捷键：`search.focus`=Ctrl+Shift+F；Enter/Shift+Enter/Ctrl+Alt+Enter | T9（全局命令 + 面板本地 keydown） |
| 验收：开关生效、非法正则报错、替换带预览确认写盘、stale/静默同步、高亮+跳转定位 | T11 冒烟清单逐条 |

