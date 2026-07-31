# Plan 4 预执行核对报告 — 【可直接执行】

- 日期：2026-08-01
- 计划：`docs/superpowers/plans/2026-07-31-plan4-diff-in-editor.md`
- 核对方式：只读代理逐条核对计划行号锚点 / 编译级 API 事实 / 计划内部一致性，共 23 条，全部通过（无 ❌）。

## 结论

**可执行**。行号锚点全部精确命中或漂移 ≤1 行（EditorPanel 内容区 `{editorFile?.isText ? (` 实际在 :136，计划写「约 :135」，在计划自设 ±3 容差内）；编译级事实全部核实：

- `NexError`（error.rs）：`Git(String)` 变体 :9-10、`From<git2::Error>` :27-31、`From<std::io::Error>` :33-37——T1 三处用法齐备。
- `git_test.rs`：`commit_file(...) -> String` 返回完整 40 位 oid hex（`commit` 返回 `oid.to_string()`），T1 测试 `&oid[..7]` 短哈希用法成立；顶部 `use std::fs;` 已在。
- `stage_files(repo_path: &Path, files: &[String])`（repository.rs:106）与计划测试调用逐字匹配。
- `Cargo.lock` git2 = 0.19.0；`IndexEntry.id` 为公开字段（`e.id` 无括号正确），`TreeEntry::id()` 为方法——计划两形区分无误。
- `package.json` 无 `@codemirror/merge`；`@codemirror/state ^6.7.1` / `view ^6.43.6`，T4 新依赖 peer 兼容。
- `DiffView.tsx` / `DiffView.test.ts` 磁盘尚不存在（T4 新建）。

## 内部一致性

- T5 删除 `gitDiff` import 后 store 零引用，mock 工厂换成 `gitDiffContents`/`gitCommitPatch` 不缺名。
- T3 测试 4 断言成立：`editorCacheByProject` 取全量 openFiles（:460-463 无过滤），`editorLayoutByProject.paths` 经 T3 过滤后为 `["/p/x.ts"]`。
- `fsReadFile` mock 形状 `{ is_text, content, size }` 与既有测试设施一致。

## 两条非阻塞观察

1. T6 Step 3 的 `git diff main...HEAD` 自检预设已在功能分支——执行顺序：先提交本文件与计划文档，再从 main 切 `feat/vscode-ux-plan4`。
2. `languageExtensionsForPath` 定义在 `src/features/editor/language.ts`（计划不触碰该文件，仅提示）。
