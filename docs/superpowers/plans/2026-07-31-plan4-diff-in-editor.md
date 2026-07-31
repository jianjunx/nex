# Plan 4：Git diff 在编辑器面板以标签打开 — 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** SCM 面板点击变更文件（或点击提交历史行）时，在编辑器面板打开一个只读 diff 标签（双版本统一合并视图 / 提交补丁全文视图），替换 GitPanel 底部 200px 内联 diff 窗格——对齐 VSCode「diff 在编辑区打开」的体验。

**Architecture:** `EditorFile` 增加可选 `diff?: DiffPayload` 字段，用合成路径（`diff:` 前缀，Windows 下绝不与真实路径冲突）作标签标识，复用既有标签栏 / 激活 / 关闭 / 持久化过滤全套机制；diff 标签永久固定（pinned）、永不 dirty、不进冷恢复持久化。后端新增两个命令：`git_diff_contents` 返回 original/revised 两个完整文档（`@codemirror/merge` 需要双文档而非补丁文本），`git_commit_patch` 返回整提交对父提交的补丁全文。`EditorPanel` 按 `editorFile.diff` 分叉渲染只读 `DiffView`（merge 模式用 `unifiedMergeView`，patch 模式用行着色插件）。三个 Plan 3 预留调用点（ChangesSection 两处 + HistorySection 一处）替换为新 store 动作，store 的内联 diff 槽（`diff`/`diffFile`/`viewDiff`）与 GitPanel 内联窗格一并删除。

**Tech Stack:** Rust git2 0.19 / Tauri 2 命令 / zustand + immer / `@codemirror/merge`（本计划新增依赖，与已装 CM6 栈 state 6.7 / view 6.43 兼容）/ @uiw/react-codemirror / vitest

## Global Constraints

1. 面向用户的文案全部简体中文；标识符、路径、commit scope 保持英文。
2. 提交规范：英文 scope + 中文描述（如 `feat(editor): 中文描述`），且**必须**附 trailer：`git commit -m "<subject>" -m "Co-Authored-By: Claude <noreply@anthropic.com>"`（两个独立 -m）。
3. 门槛：`pnpm lint && pnpm build && pnpm test`（`pnpm tsc --noEmit` 在本仓库为 NO-OP，不算门槛；`pnpm build` = `tsc -b && vite build` 才是真实类型门槛）。后端：`cargo test --manifest-path src-tauri/Cargo.toml`。
4. lint 基线：**恰好 6 条既有 warning**（GitPanel.tsx / App.tsx / FileTree.tsx 的 exhaustive-deps + KeybindingHost / button / tabs 的 only-export-components），零新增。GitPanel.tsx 的 exhaustive-deps 锚点会随 import 行增删漂移（本计划 T5 删除内联窗格后会上移），计数保持 6 即可。
5. Tauri 新命令四处同步：`src-tauri/src/commands/git_cmds.rs` → `src-tauri/src/lib.rs` invoke_handler → `src/bridge/commands.ts` → `src/bridge/tauri.ts`。参数字段 camelCase↔snake_case 自动转换；命令名字符串拼错构建不报错，评审须逐字核对。
6. jsdom 测试实证约束：首行 docblock `/** @vitest-environment jsdom */`（vitest 无 globals）；显式 `afterEach(() => cleanup())`；mock 用模块级可变 `vi.fn` + `vi.mock` 工厂闭包。
7. git2 0.19 事实：`revparse_single` 接受短哈希；`tree.get_path` 返回 `TreeEntry`（`.id()` 取 Oid）；`index.get_path(path, 0)` 返回 `Option<IndexEntry>`（字段 `.id`）；`blob.content() -> &[u8]`；`diff_tree_to_tree(old, new, opts)` 前两参为 `Option<&Tree>`。
8. 越界红线：不触碰 Plan 5（搜索）/Plan 6（会话标签）的实现文件；不改 `components/ui/*`；不新增 `components/ui/alert-dialog`。
9. 测试计数目标：**前端 167 passed**（= 155 基线 + T3 五个 + T4 五个 + T5 两个；T4 若触发预先批准的 jsdom 降级则 165，见 T4 偏差条款）；**后端 51 passed**（= 44 基线 + T1 七个）。

## File Structure

| 文件 | 动作 | 职责 |
|---|---|---|
| `src-tauri/src/git/types.rs` | 改 | 新增 `DiffContents { original, revised, binary }` |
| `src-tauri/src/git/repository.rs` | 改 | `get_diff_contents`（双版本文档）+ `get_commit_patch`（整提交补丁）+ 共享 `render_patch` 打印器（`get_diff` 复用）+ 二进制启发式 |
| `src-tauri/src/commands/git_cmds.rs` | 改 | `git_diff_contents` / `git_commit_patch` 两个命令 |
| `src-tauri/src/lib.rs` | 改 | invoke_handler 注册两处 |
| `src-tauri/tests/git_test.rs` | 改 | +7 集成测试 |
| `src/bridge/commands.ts` | 改 | +2 常量 |
| `src/bridge/tauri.ts` | 改 | +`DiffContents` 接口 + 2 封装 |
| `src/stores/fs.store.ts` | 改 | `DiffPayload` 类型 + `EditorFile.diff?` + `openDiffTab` upsert 动作 + setDraft/reloadEditor 守卫 + 持久化过滤 |
| `src/stores/fs.store.editor.test.ts` | 改 | +5 diff 标签用例 |
| `src/features/editor/DiffView.tsx` | 新建 | 只读 diff 内容组件（merge/patch/binary 三分支） |
| `src/features/editor/DiffView.test.ts` | 新建 | 纯函数 ×2 + 渲染 ×3 |
| `src/features/editor/EditorPanel.tsx` | 改 | 标签栏标签/tooltip 分叉 + 内容区 diff 分叉 + 语言检测 languageHint |
| `src/stores/git.store.ts` | 改 | `openDiffInEditor` + 真化 `openCommitDiff`；删 `diff`/`diffFile`/`viewDiff` |
| `src/stores/git.store.test.ts` | 改 | 初始状态删两字段 + mock 换两函数 + fs.store mock + 2 新用例 |
| `src/features/git/ChangesSection.tsx` | 改 | FileRow 两处调用点换 `openDiffInEditor`，删 Plan 4 注释 |
| `src/features/git/ChangesSection.test.tsx` | 改 | mock 与钉死断言换 `openDiffInEditor` |
| `src/features/git/HistorySection.tsx` | 改 | 删 Plan 4 注释（行为不变） |
| `src/features/git/HistorySection.test.tsx` | 改 | 用例标题更新（断言不变） |
| `src/features/git/GitPanel.tsx` | 改 | 删内联 diff 窗格与 `diff`/`diffFile` 解构 |
| `package.json` / `pnpm-lock.yaml` | 改 | +`@codemirror/merge` 依赖 |

后端 `git_diff` 命令与 `gitDiff` 桥接封装**保留**（公开后端 API，无死代码告警；T5 只删前端 store 内联槽）。

---

### Task 1: 后端双版本文档与提交补丁命令

**Files:**
- Modify: `src-tauri/src/git/types.rs`（文件尾追加）
- Modify: `src-tauri/src/git/repository.rs`（`get_diff` 打印器重构 + 新函数）
- Modify: `src-tauri/src/commands/git_cmds.rs`（`git_diff` 之后插入两命令）
- Modify: `src-tauri/src/lib.rs`（invoke_handler 中 `git_diff` 之后插两行）
- Test: `src-tauri/tests/git_test.rs`（文件尾追加 7 例）

**Interfaces:**
- Consumes: `NexError`（有 `From<git2::Error>` 与 `From<std::io::Error>`）；git_test.rs 既有辅助函数 `init_repo(dir)` / `commit_file(dir, name, content, msg) -> String`（返回完整 oid 十六进制）。
- Produces: `repository::get_diff_contents(repo_path: &Path, file: &str, staged: bool) -> Result<DiffContents, NexError>`；`repository::get_commit_patch(repo_path: &Path, hash: &str) -> Result<String, NexError>`；`DiffContents { original: String, revised: String, binary: bool }`（Serde 字段名即 camelCase 结果，无需 rename_all——与 T3 StashEntry 先例同裁定）。

- [ ] **Step 1: 追加 DiffContents 类型**

`src-tauri/src/git/types.rs` 文件尾（`StashEntry` 之后）追加：

```rust
#[derive(Debug, Clone, Serialize)]
pub struct DiffContents {
    pub original: String,
    pub revised: String,
    pub binary: bool,
}
```

- [ ] **Step 2: 重构 get_diff 打印器为共享函数**

`src-tauri/src/git/repository.rs` 中 `get_diff`（:55-83）的打印块（`let mut buf = Vec::new();` 至 `Ok(String::from_utf8_lossy(&buf).to_string())`）替换为调用共享打印器，并在 `get_diff` 函数**之前**新增：

```rust
/// 共享补丁打印器：DiffLine::content() 不含行首来源标记，补回 +/-/空格
/// 前缀，输出标准补丁文本。get_diff 与 get_commit_patch 共用。
fn render_patch(diff: &git2::Diff) -> Result<String, NexError> {
    let mut buf = Vec::new();
    diff.print(DiffFormat::Patch, |_, _, line| {
        let origin = line.origin();
        if origin == '+' || origin == '-' || origin == ' ' {
            buf.push(origin as u8);
        }
        buf.extend_from_slice(line.content());
        true
    })?;
    Ok(String::from_utf8_lossy(&buf).to_string())
}
```

`get_diff` 函数体尾部（原 :70-82 的 13 行）替换为单行：

```rust
    render_patch(&diff)
```

- [ ] **Step 3: 实现 get_diff_contents 与辅助函数**

`repository.rs` 中 `get_diff` 函数之后、`get_log` 之前插入：

```rust
/// git 的二进制启发式：前 8000 字节出现 NUL 即判二进制。
fn looks_binary(bytes: &[u8]) -> bool {
    bytes.iter().take(8000).any(|&b| b == 0)
}

fn head_entry_id(repo: &Repository, file: &str) -> Option<git2::Oid> {
    let head = repo.head().ok()?;
    let tree = head.peel_to_tree().ok()?;
    tree.get_path(Path::new(file)).ok().map(|e| e.id())
}

fn index_entry_id(repo: &Repository, file: &str) -> Option<git2::Oid> {
    let index = repo.index().ok()?;
    index.get_path(Path::new(file), 0).map(|e| e.id)
}

fn blob_bytes(repo: &Repository, id: git2::Oid) -> Result<Vec<u8>, NexError> {
    Ok(repo.find_blob(id)?.content().to_vec())
}

/// 为合并视图取两个完整文档。staged = HEAD blob vs 索引 blob；
/// unstaged = 索引 blob（无索引条目回退 HEAD blob）vs 工作区磁盘内容。
/// 缺失一侧得空串：暂存新增文件 original=""，工作区已删文件 revised=""。
pub fn get_diff_contents(repo_path: &Path, file: &str, staged: bool) -> Result<DiffContents, NexError> {
    let repo = Repository::open(repo_path)?;

    let original_id = if staged {
        head_entry_id(&repo, file)
    } else {
        index_entry_id(&repo, file).or_else(|| head_entry_id(&repo, file))
    };
    let original = match original_id {
        Some(id) => blob_bytes(&repo, id)?,
        None => Vec::new(),
    };

    let revised = if staged {
        match index_entry_id(&repo, file) {
            Some(id) => blob_bytes(&repo, id)?,
            None => Vec::new(),
        }
    } else {
        let workdir = repo.workdir()
            .ok_or_else(|| NexError::Git("bare repository has no working directory".to_string()))?;
        match std::fs::read(workdir.join(Path::new(file))) {
            Ok(b) => b,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(e) => return Err(NexError::from(e)),
        }
    };

    let binary = looks_binary(&original) || looks_binary(&revised);
    Ok(DiffContents {
        original: String::from_utf8_lossy(&original).into_owned(),
        revised: String::from_utf8_lossy(&revised).into_owned(),
        binary,
    })
}

/// 整提交对父提交的补丁全文（根提交对空树）；hash 接受短哈希。
pub fn get_commit_patch(repo_path: &Path, hash: &str) -> Result<String, NexError> {
    let repo = Repository::open(repo_path)?;
    let obj = repo.revparse_single(&format!("{hash}^{{commit}}"))?;
    let commit = obj.peel_to_commit()?;
    let parent_tree = commit.parent(0).ok().and_then(|p| p.tree().ok());
    let tree = commit.tree()?;
    let diff = repo.diff_tree_to_tree(parent_tree.as_ref(), Some(&tree), None)?;
    render_patch(&diff)
}
```

注意：`format!("{hash}^{{commit}}")` 中双花括号是 format 字符串的字面 `{commit}` 转义，revparse 语法要求 `^{commit}` 后缀。

- [ ] **Step 4: 注册两个命令**

`src-tauri/src/commands/git_cmds.rs` 中 `git_diff`（:14-17）之后插入：

```rust
#[tauri::command]
pub fn git_diff_contents(project_path: String, file: String, staged: bool) -> Result<DiffContents, NexError> {
    repository::get_diff_contents(Path::new(&project_path), &file, staged)
}

#[tauri::command]
pub fn git_commit_patch(project_path: String, hash: String) -> Result<String, NexError> {
    repository::get_commit_patch(Path::new(&project_path), &hash)
}
```

`src-tauri/src/lib.rs` invoke_handler 中 `commands::git_cmds::git_diff,`（:47）之后插入两行：

```rust
            commands::git_cmds::git_diff_contents,
            commands::git_cmds::git_commit_patch,
```

- [ ] **Step 5: 追加 7 个集成测试**

`src-tauri/tests/git_test.rs` 文件尾追加：

```rust
#[test]
fn diff_contents_staged_shows_head_vs_index() {
    let dir = tempdir().unwrap();
    init_repo(dir.path());
    commit_file(dir.path(), "a.txt", "v1\n", "init");
    fs::write(dir.path().join("a.txt"), "v2\n").unwrap();
    repository::stage_files(dir.path(), &["a.txt".to_string()]).unwrap();

    let d = repository::get_diff_contents(dir.path(), "a.txt", true).unwrap();
    assert_eq!(d.original, "v1\n");
    assert_eq!(d.revised, "v2\n");
    assert!(!d.binary);
}

#[test]
fn diff_contents_unstaged_shows_index_vs_workdir() {
    let dir = tempdir().unwrap();
    init_repo(dir.path());
    commit_file(dir.path(), "a.txt", "v1\n", "init");
    fs::write(dir.path().join("a.txt"), "v2\n").unwrap();

    let d = repository::get_diff_contents(dir.path(), "a.txt", false).unwrap();
    assert_eq!(d.original, "v1\n");
    assert_eq!(d.revised, "v2\n");
}

#[test]
fn diff_contents_untracked_file_has_empty_original() {
    let dir = tempdir().unwrap();
    init_repo(dir.path());
    commit_file(dir.path(), "a.txt", "v1\n", "init");
    fs::write(dir.path().join("new.txt"), "hello\n").unwrap();

    let d = repository::get_diff_contents(dir.path(), "new.txt", false).unwrap();
    assert_eq!(d.original, "");
    assert_eq!(d.revised, "hello\n");
}

#[test]
fn diff_contents_staged_new_file_has_empty_original() {
    let dir = tempdir().unwrap();
    init_repo(dir.path());
    commit_file(dir.path(), "a.txt", "v1\n", "init");
    fs::write(dir.path().join("new.txt"), "hello\n").unwrap();
    repository::stage_files(dir.path(), &["new.txt".to_string()]).unwrap();

    let d = repository::get_diff_contents(dir.path(), "new.txt", true).unwrap();
    assert_eq!(d.original, "");
    assert_eq!(d.revised, "hello\n");
}

#[test]
fn diff_contents_workdir_deletion_gives_empty_revised() {
    let dir = tempdir().unwrap();
    init_repo(dir.path());
    commit_file(dir.path(), "a.txt", "v1\n", "init");
    fs::remove_file(dir.path().join("a.txt")).unwrap();

    let d = repository::get_diff_contents(dir.path(), "a.txt", false).unwrap();
    assert_eq!(d.original, "v1\n");
    assert_eq!(d.revised, "");
}

#[test]
fn diff_contents_flags_binary_content() {
    let dir = tempdir().unwrap();
    init_repo(dir.path());
    commit_file(dir.path(), "a.txt", "v1\n", "init");
    fs::write(dir.path().join("a.txt"), b"abc\x00def").unwrap();

    let d = repository::get_diff_contents(dir.path(), "a.txt", false).unwrap();
    assert!(d.binary);
}

#[test]
fn commit_patch_contains_added_lines_and_accepts_short_hash() {
    let dir = tempdir().unwrap();
    init_repo(dir.path());
    let oid = commit_file(dir.path(), "a.txt", "v1\n", "init");

    let patch = repository::get_commit_patch(dir.path(), &oid[..7]).unwrap();
    assert!(patch.contains("a.txt"), "patch should name the file: {patch}");
    assert!(patch.contains("+v1"), "patch should contain the added line: {patch}");
}
```

- [ ] **Step 6: 跑后端全量门槛**

Run: `cargo test --manifest-path src-tauri/Cargo.toml 2>&1 | tail -15 ; echo "exit=${PIPESTATUS[0]}"`
Expected: exit=0，**51 passed / 0 failed**（lib 14 + db 2 + fs 2 + git_test 33）。旧 26 例不受 `render_patch` 重构影响（`get_diff` 输出逐字不变）。

- [ ] **Step 7: 提交**

```bash
git add src-tauri/src/git/types.rs src-tauri/src/git/repository.rs src-tauri/src/commands/git_cmds.rs src-tauri/src/lib.rs src-tauri/tests/git_test.rs
git commit -m "feat(git): 双版本 diff 文档与提交补丁后端命令" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: 桥接层两处同步（commands.ts + tauri.ts）

**Files:**
- Modify: `src/bridge/commands.ts`（Git 段 `GIT_DIFF` 之后）
- Modify: `src/bridge/tauri.ts`（`gitDiff` 封装之后）

**Interfaces:**
- Consumes: T1 注册的命令名 `git_diff_contents` / `git_commit_patch`；Tauri 参数自动 camelCase→snake_case。
- Produces: `COMMANDS.GIT_DIFF_CONTENTS` / `COMMANDS.GIT_COMMIT_PATCH`；`gitDiffContents(projectPath, file, staged): Promise<DiffContents>`；`gitCommitPatch(projectPath, hash): Promise<string>`；`interface DiffContents { original: string; revised: string; binary: boolean }`。

- [ ] **Step 1: commands.ts 追加两常量**

`src/bridge/commands.ts` 中 `GIT_DIFF: "git_diff",`（:29）之后插入：

```ts
  GIT_DIFF_CONTENTS: "git_diff_contents",
  GIT_COMMIT_PATCH: "git_commit_patch",
```

- [ ] **Step 2: tauri.ts 追加接口与两封装**

`src/bridge/tauri.ts` 中 `gitDiff` 封装（:223-225）之后插入：

```ts
export interface DiffContents {
  original: string;
  revised: string;
  binary: boolean;
}

export async function gitDiffContents(projectPath: string, file: string, staged: boolean): Promise<DiffContents> {
  return invoke(COMMANDS.GIT_DIFF_CONTENTS, { projectPath, file, staged });
}

export async function gitCommitPatch(projectPath: string, hash: string): Promise<string> {
  return invoke(COMMANDS.GIT_COMMIT_PATCH, { projectPath, hash });
}
```

- [ ] **Step 3: 逐字核对四处同步**

Run: `cd src-tauri && grep -n "git_diff_contents\|git_commit_patch" src/commands/git_cmds.rs src/lib.rs && cd ../src/bridge && grep -n "git_diff_contents\|git_commit_patch\|GIT_DIFF_CONTENTS\|GIT_COMMIT_PATCH" commands.ts tauri.ts`
Expected: 命令名在四处逐字一致（Rust 函数名 = invoke_handler 条目 = TS 常量值 = 封装内 COMMANDS 引用），参数名 `projectPath/file/staged` 与 `projectPath/hash` 与 Rust 形参的 camelCase 映射一致。

- [ ] **Step 4: 类型门槛**

Run: `pnpm build 2>&1 | tail -3 ; echo "exit=${PIPESTATUS[0]}"`
Expected: exit=0（tsc -b 把关接口语法；命令名字符串拼错构建不报错，Step 3 的 grep 才是拼写关卡）。

- [ ] **Step 5: 提交**

```bash
git add src/bridge/commands.ts src/bridge/tauri.ts
git commit -m "feat(bridge): git_diff_contents 与 git_commit_patch 封装" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: fs.store 只读 diff 标签模型

**Files:**
- Modify: `src/stores/fs.store.ts`（类型区 + 接口 + 实现 + 两处守卫 + 两处持久化过滤）
- Test: `src/stores/fs.store.editor.test.ts`（新 describe 追加 5 例）

**Interfaces:**
- Consumes: 无新外部依赖（fs.store 不引 git.store——方向保持 git.store → fs.store 单向，无环）。
- Produces: `type DiffMode = "merge" | "patch"`；`type DiffPayload = { mode, title, languageHint, original, revised, binary }`；`EditorFile.diff?: DiffPayload`；`openDiffTab(id: string, payload: DiffPayload): void`（upsert 语义：同 id 就地刷新载荷并激活）。合成路径形如 `diff:unstaged:src/a.ts` / `diff:staged:src/a.ts` / `diff:commit:abc1234`（冒号在 Windows 文件路径非法 → 与真实路径零冲突；`:` 同时保证不被 `fileBasename`/`relativeToProject` 误处理——但标签栏对 diff 标签走 `payload.title` 分支，不经过这两个函数）。

- [ ] **Step 1: 追加 DiffPayload 类型**

`src/stores/fs.store.ts` 中 `EditorFile` 类型定义（:33-42）**之前**插入：

```ts
/** 只读 diff 标签载荷。mode=merge：双版本统一合并视图；mode=patch：提交补丁全文。 */
export type DiffMode = "merge" | "patch";

export type DiffPayload = {
  mode: DiffMode;
  /** 标签名，如 "src/a.ts（已暂存）" 或 "提交 abc1234"。 */
  title: string;
  /** 语法高亮的文件路径提示（合成路径不能用于语言检测）。 */
  languageHint: string;
  original: string;
  revised: string;
  binary: boolean;
};
```

- [ ] **Step 2: EditorFile 追加 diff 字段**

`EditorFile` 中 `pinned: boolean;` 行（:41）之后追加：

```ts
  /** 存在即为只读 diff 标签：合成路径（diff: 前缀）、永久固定、永不 dirty、不进冷恢复持久化。 */
  diff?: DiffPayload;
```

- [ ] **Step 3: 接口追加 openDiffTab**

`FsStore` 接口中 `openFile` 签名（:69）之后插入：

```ts
  /** 打开只读 diff 标签（upsert：同 id 重开就地替换载荷并激活）。合成路径 diff: 前缀，不进冷恢复持久化。 */
  openDiffTab: (id: string, payload: DiffPayload) => void;
```

- [ ] **Step 4: 实现 openDiffTab**

`openFile` 实现结束（:225 的 `},`）之后、`switchFile` 之前插入：

```ts
    openDiffTab: (id, payload) => {
      // 与 openFile 同契：切走前冲刷上一个活动文件的自动保存。
      const previous = get().activePath;
      if (previous && previous !== id) void flushAutoSave(previous);
      const existingIndex = get().openFiles.findIndex((f) => f.path === id);
      set((s) => {
        if (existingIndex >= 0) {
          // 重开同一 diff：暂存状态可能已变，就地替换载荷，标签保持一个。
          s.openFiles[existingIndex].diff = payload;
        } else {
          s.openFiles.push({
            path: id,
            content: null,
            isText: true,
            size: 0,
            draft: "",
            dirty: false,
            stale: false,
            pinned: true, // diff 标签永远固定，不参与预览替换
            diff: payload,
          });
        }
        s.activePath = id;
      });
      useUiStore.getState().setEditorVisible(true);
    },
```

- [ ] **Step 5: setDraft 守卫**

`setDraft` 中 `if (!active) return;`（:291）改为：

```ts
        if (!active || active.diff) return; // diff 标签只读：绝不写 draft、绝不 dirty
```

- [ ] **Step 6: reloadEditor 守卫**

`reloadEditor` 中 `if (!cur) return;`（:399）改为：

```ts
      if (!cur || cur.diff) return; // diff 标签无对应磁盘文件，重载会产生无效读取错误
```

- [ ] **Step 7: 持久化过滤（两处）**

`saveCurrentEditorState` 中 `paths: s.openFiles.map((f) => f.path),`（:466）改为：

```ts
          paths: s.openFiles.filter((f) => !f.diff).map((f) => f.path), // diff 标签不进冷恢复
```

`persistEditorLayout` 中 `paths: openFiles.map((f) => f.path),`（:524）改为：

```ts
          paths: openFiles.filter((f) => !f.diff).map((f) => f.path), // diff 标签不进冷恢复
```

注：`editorCacheByProject`（会话内缓存）**不**过滤——项目切换往返保留 diff 标签是预期行为，会话内有效载荷不失效。

- [ ] **Step 8: 追加 5 个测试**

`src/stores/fs.store.editor.test.ts` 文件尾（最后一个 describe 之后）追加：

```ts
describe("fs.store diff tabs", () => {
  const PAYLOAD = {
    mode: "merge" as const,
    title: "a.txt（已暂存）",
    languageHint: "a.txt",
    original: "v1",
    revised: "v2",
    binary: false,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    editorAutoSave = false;
    clearAllAutoSaveTimers();
    useFsStore.setState({ openFiles: [], activePath: null, error: null, loading: false });
  });

  it("openDiffTab adds a permanently pinned diff tab and activates it", () => {
    useFsStore.getState().openDiffTab("diff:staged:a.txt", PAYLOAD);
    const s = useFsStore.getState();
    expect(s.openFiles).toHaveLength(1);
    expect(s.openFiles[0].diff).toEqual(PAYLOAD);
    expect(s.openFiles[0].pinned).toBe(true);
    expect(s.activePath).toBe("diff:staged:a.txt");
    expect(setEditorVisible).toHaveBeenCalledWith(true);
  });

  it("re-opening the same diff id updates the payload in place without adding a tab", () => {
    useFsStore.getState().openDiffTab("diff:staged:a.txt", PAYLOAD);
    useFsStore.getState().openDiffTab("diff:staged:a.txt", { ...PAYLOAD, revised: "v3" });
    const s = useFsStore.getState();
    expect(s.openFiles).toHaveLength(1);
    expect(s.openFiles[0].diff?.revised).toBe("v3");
    expect(s.activePath).toBe("diff:staged:a.txt");
  });

  it("setDraft is a no-op on the active diff tab", () => {
    useFsStore.getState().openDiffTab("diff:staged:a.txt", PAYLOAD);
    useFsStore.getState().setDraft("hacked");
    const f = useFsStore.getState().openFiles[0];
    expect(f.draft).toBe("");
    expect(f.dirty).toBe(false);
  });

  it("saveCurrentEditorState excludes diff tabs from persisted paths but keeps them in the session cache", async () => {
    fsReadFile.mockResolvedValueOnce({ is_text: true, content: "x", size: 1 });
    await useFsStore.getState().openFile("/p/x.ts", true);
    useFsStore.getState().openDiffTab("diff:staged:a.txt", PAYLOAD);

    await useFsStore.getState().saveCurrentEditorState("proj-1");
    const s = useFsStore.getState();
    expect(s.editorLayoutByProject["proj-1"].paths).toEqual(["/p/x.ts"]);
    expect(s.editorCacheByProject["proj-1"].openFiles).toHaveLength(2);
  });

  it("reloadEditor on a diff tab is a no-op (no disk read)", async () => {
    useFsStore.getState().openDiffTab("diff:staged:a.txt", PAYLOAD);
    fsReadFile.mockClear();
    await useFsStore.getState().reloadEditor();
    expect(fsReadFile).not.toHaveBeenCalled();
    expect(useFsStore.getState().openFiles[0].diff?.revised).toBe("v2");
  });
});
```

注意：本文件既有 beforeEach 位于第一个 describe 内部，新 describe 自带重置（上面已含），`fsReadFile` / `setEditorVisible` / `editorAutoSave` / `clearAllAutoSaveTimers` 均为文件既有模块级设施，直接复用。

- [ ] **Step 9: 跑前端门槛**

Run: `pnpm test src/stores/fs.store.editor.test.ts 2>&1 | tail -5 ; echo "exit=${PIPESTATUS[0]}"`
Expected: exit=0，**18 passed**（13 既有 + 5 新）。
再跑全量：`pnpm lint 2>&1 | tail -2 ; echo "lint=${PIPESTATUS[0]}" ; pnpm build 2>&1 | tail -2 ; echo "build=${PIPESTATUS[0]}" ; pnpm test 2>&1 | tail -4 ; echo "test=${PIPESTATUS[0]}"`
Expected: lint exit=0（恰好 6 条既有 warning）/ build exit=0 / test **160 passed (29 files)**。

- [ ] **Step 10: 提交**

```bash
git add src/stores/fs.store.ts src/stores/fs.store.editor.test.ts
git commit -m "feat(editor): fs.store 只读 diff 标签模型（openDiffTab upsert + 持久化过滤）" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: DiffView 组件 + EditorPanel 集成 + @codemirror/merge 依赖

**Files:**
- Modify: `package.json` / `pnpm-lock.yaml`（`pnpm add @codemirror/merge`）
- Create: `src/features/editor/DiffView.tsx`
- Create: `src/features/editor/DiffView.test.ts`
- Modify: `src/features/editor/EditorPanel.tsx`（import + 语言提示 + 标签栏两处 + 内容区分叉）

**Interfaces:**
- Consumes: T3 的 `DiffPayload`；`EditorPanel` 既有 `editorTheme`（Extension）、`languageExtensionsForPath`、`editorSearchExtensions`、`viewRef` 查找栏注册机制（`registerFindBarAccessor(() => viewRef.current)`）。
- Produces: `DiffView({ payload, theme, extensions, onCreateEditor })`——binary → 占位文案；patch → 只读 CM + 行着色；merge → 只读 CM + `unifiedMergeView`。导出纯函数 `patchLineClasses(text): ("add" | "del" | null)[]` 供测试。

- [ ] **Step 1: 安装依赖**

Run: `cd D:/projects/nex && pnpm add @codemirror/merge`
Expected: package.json dependencies 出现 `@codemirror/merge`，pnpm-lock.yaml 更新，无 peer 冲突（现有 @codemirror/state ^6、view ^6 即其 peer）。

- [ ] **Step 2: 核对 API 面**

Run: `grep -n "export declare function unifiedMergeView\|export interface UnifiedMergeViewOptions" node_modules/@codemirror/merge/dist/index.d.ts | head -5`
Expected: 存在 `unifiedMergeView` 导出，选项含 `original` / `highlightChanges` / `gutter` / `mergeControls` / `collapseUnchanged`。若签名与本计划 Step 3 用法不符（极小概率），以 node_modules 中的类型声明为准调整 DiffView，并在报告中记录偏差。

- [ ] **Step 3: 新建 DiffView.tsx**

```tsx
import CodeMirror from "@uiw/react-codemirror";
import { EditorState, RangeSetBuilder, type Extension } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { unifiedMergeView } from "@codemirror/merge";
import type { DiffPayload } from "../../stores/fs.store";

/** 补丁文本逐行分类：+ 新增 / - 删除 / 其余（头行、@@、上下文）为 null。导出供测试。 */
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
}

/** 只读 diff 标签内容：merge = 统一合并视图（双全文档），patch = 行着色补丁全文。 */
export function DiffView({ payload, theme, extensions, onCreateEditor }: DiffViewProps) {
  if (payload.binary) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-[var(--text-tertiary)]">
        二进制文件 — 无法显示文本差异
      </div>
    );
  }

  if (payload.mode === "patch") {
    return (
      <CodeMirror
        value={payload.revised}
        theme={theme}
        extensions={[...extensions, EditorState.readOnly.of(true), patchHighlight, patchTheme]}
        onCreateEditor={(view) => onCreateEditor?.(view)}
        height="100%"
        style={{ height: "100%" }}
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
      height="100%"
      style={{ height: "100%" }}
    />
  );
}
```

- [ ] **Step 4: 新建 DiffView.test.ts**

```ts
/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { DiffView, patchLineClasses } from "./DiffView";

afterEach(() => cleanup());

const base = {
  mode: "patch" as const,
  title: "提交 abc1234",
  languageHint: "",
  original: "",
  binary: false,
};

describe("patchLineClasses", () => {
  it("classifies +/- lines and leaves context/header lines null", () => {
    expect(patchLineClasses("+a\n-b\n c\n@@ -1 +1 @@\ndiff --git x x")).toEqual([
      "add",
      "del",
      null,
      null,
      null,
    ]);
  });

  it("returns [null] for the empty string", () => {
    expect(patchLineClasses("")).toEqual([null]);
  });
});

describe("DiffView", () => {
  it("binary payload renders the placeholder and no editor", () => {
    const { container, getByText } = render(
      <DiffView payload={{ ...base, binary: true }} theme={[]} extensions={[]} />,
    );
    expect(getByText("二进制文件 — 无法显示文本差异")).toBeTruthy();
    expect(container.querySelector(".cm-editor")).toBeNull();
  });

  it("patch mode mounts a read-only editor containing the patch text", () => {
    const { container } = render(
      <DiffView payload={{ ...base, revised: "+v2\n-v1\n" }} theme={[]} extensions={[]} />,
    );
    expect(container.querySelector(".cm-editor")).toBeTruthy();
    expect(container.textContent).toContain("+v2");
  });

  it("merge mode mounts an editor for the revised document", () => {
    const { container } = render(
      <DiffView
        payload={{ ...base, mode: "merge", original: "v1", revised: "v2" }}
        theme={[]}
        extensions={[]}
      />,
    );
    expect(container.querySelector(".cm-editor")).toBeTruthy();
  });
});
```

**预先批准的偏差条款**：本仓库此前没有任何组件在 jsdom 中挂载过 CodeMirror。若 patch/merge 两个冒烟用例因 jsdom 测量限制无法通过（如 CM 渲染抛错或零行渲染），**删除这两个冒烟用例**（保留 patchLineClasses ×2 + binary ×1 = 3 例），把前端总目标从 167 调整为 **165**，并在报告与账本中记录该偏差；不得为凑绿而弱断言。

- [ ] **Step 5: EditorPanel 集成**

`src/features/editor/EditorPanel.tsx` 五处修改：

① import 区（:11 `editorSearch` import 之后）追加：

```ts
import { DiffView } from "./DiffView";
```

② `viewRef` 声明（:58）之后插入：

```ts
  // diff 标签用合成路径（diff: 前缀），语言检测须走载荷中的 languageHint。
  const langPath = editorFile?.diff ? editorFile.diff.languageHint : (editorFile?.path ?? "");
```

③ extensions useMemo（:60-63）替换为：

```ts
  const extensions = useMemo(
    () => [...languageExtensionsForPath(langPath), ...editorSearchExtensions()],
    [langPath],
  );
```

④ 标签栏两处（:90 title 属性与 :93 标签名 span）：

```tsx
              title={f.diff ? f.diff.title : relativeToProject(f.path, projectPath)}
```

```tsx
              <span className={`truncate ${!f.pinned ? "italic" : ""}`}>{f.diff ? f.diff.title : fileBasename(f.path)}</span>
```

⑤ 内容区（:135-155）开头分叉——把 `{editorFile?.isText ? (` 改为先判 diff：

```tsx
      <div className="flex-1 min-h-0 overflow-hidden">
        {editorFile?.diff ? (
          <DiffView
            key={editorFile.path}
            payload={editorFile.diff}
            theme={editorTheme}
            extensions={extensions}
            onCreateEditor={(view) => { viewRef.current = view; }}
          />
        ) : editorFile?.isText ? (
```

其余（CodeMirror 分支、二进制占位分支、收尾 `) : null}`）逐字不动。`onCreateEditor` 把 diff 视图也注册进 `viewRef`，Ctrl+F 查找栏对只读 diff 同样可用。

- [ ] **Step 6: 跑前端门槛**

Run: `pnpm test src/features/editor/DiffView.test.ts 2>&1 | tail -5 ; echo "exit=${PIPESTATUS[0]}"`
Expected: exit=0，5 passed（或按偏差条款 3 passed）。
全量：`pnpm lint 2>&1 | tail -2 ; echo "lint=${PIPESTATUS[0]}" ; pnpm build 2>&1 | tail -2 ; echo "build=${PIPESTATUS[0]}" ; pnpm test 2>&1 | tail -4 ; echo "test=${PIPESTATUS[0]}"`
Expected: lint exit=0 / 6 条既有 warning 零新增 / build exit=0 / test **165 passed (30 files)**（160 + 5；偏差降级则 163）。

- [ ] **Step 7: 提交**

```bash
git add package.json pnpm-lock.yaml src/features/editor/DiffView.tsx src/features/editor/DiffView.test.ts src/features/editor/EditorPanel.tsx
git commit -m "feat(editor): 只读 diff 标签视图（unifiedMergeView + 补丁行着色）" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 5: git.store 换线 + 三调用点替换 + 删内联 diff 槽

**Files:**
- Modify: `src/stores/git.store.ts`（import / 接口 / 状态 / 两动作 / 删 viewDiff 与 diff-diffFile 字段）
- Modify: `src/stores/git.store.test.ts`（重置块 / mock / 新 describe）
- Modify: `src/features/git/ChangesSection.tsx`（FileRow 选择器 + 两调用点）
- Modify: `src/features/git/ChangesSection.test.tsx`（mock 形状 + 钉死用例）
- Modify: `src/features/git/HistorySection.tsx`（删注释两行）
- Modify: `src/features/git/HistorySection.test.tsx`（用例标题）
- Modify: `src/features/git/GitPanel.tsx`（解构 + 删窗格块）

**Interfaces:**
- Consumes: T2 的 `gitDiffContents` / `gitCommitPatch`；T3 的 `useFsStore.getState().openDiffTab(id, payload)`。
- Produces: `openDiffInEditor(projectPath, file, staged): Promise<void>`——成功后 openDiffTab，id `diff:unstaged:<file>` / `diff:staged:<file>`，title 未暂存=`<file>`、已暂存=`<file>（已暂存）`；失败写 error 槽。`openCommitDiff(projectPath, commitHash): void`（签名去掉无调用方的 path 参数）——id `diff:commit:<hash>`，title `提交 <hash>`。`viewDiff` / `diff` / `diffFile` 从 store 彻底消失。

- [ ] **Step 1: git.store import 换线**

`src/stores/git.store.ts` import 块（:1-10）中 `gitStatus, gitDiff, gitStage,` 行的 `gitDiff,` 删除，在 `gitFetch, gitPull, gitPush, gitClone,` 行之后（类型行之前）追加一行：

```ts
  gitDiffContents, gitCommitPatch,
```

并在 import 块之后（:11 之后）追加：

```ts
import { useFsStore } from "./fs.store";
```

（依赖方向 git.store → fs.store 单向，fs.store 不引 git.store，无环。）

- [ ] **Step 2: 接口与状态字段**

接口中 `viewDiff: ...`（:40）替换为：

```ts
  openDiffInEditor: (projectPath: string, file: string, staged: boolean) => Promise<void>;
```

`openCommitDiff` 签名（:62）替换为：

```ts
  openCommitDiff: (projectPath: string, commitHash: string) => void;
```

状态字段中 `diff: string | null;`（:22）与 `diffFile: string | null;`（:23）两行删除；初始状态中 `diff: null,`（:122）与 `diffFile: null,`（:123）两行删除。

- [ ] **Step 3: openDiffInEditor 替换 viewDiff 实现**

`viewDiff` 实现（:145-149）整块替换为：

```ts
      openDiffInEditor: async (projectPath, file, staged) => {
        try {
          const contents = await gitDiffContents(projectPath, file, staged);
          useFsStore.getState().openDiffTab(`diff:${staged ? "staged" : "unstaged"}:${file}`, {
            mode: "merge",
            title: staged ? `${file}（已暂存）` : file,
            languageHint: file,
            original: contents.original,
            revised: contents.revised,
            binary: contents.binary,
          });
        } catch (err) {
          set((s) => { s.error = errorMessage(err); });
        }
      },
```

- [ ] **Step 4: openCommitDiff 真化**

`openCommitDiff` 占位实现（:305-310，含三行 Plan 4 注释）整块替换为：

```ts
      openCommitDiff: (projectPath, commitHash) => {
        void (async () => {
          try {
            const patch = await gitCommitPatch(projectPath, commitHash);
            useFsStore.getState().openDiffTab(`diff:commit:${commitHash}`, {
              mode: "patch",
              title: `提交 ${commitHash}`,
              languageHint: "",
              original: "",
              revised: patch,
              binary: false,
            });
          } catch (err) {
            set((s) => { s.error = errorMessage(err); });
          }
        })();
      },
```

- [ ] **Step 5: ChangesSection 两调用点换线**

`src/features/git/ChangesSection.tsx` FileRow 中 `const viewDiff = useGitStore((s) => s.viewDiff);`（:58）替换为：

```ts
  const openDiffInEditor = useGitStore((s) => s.openDiffInEditor);
```

整行点击块（:64-68，含两行 Plan 4 注释）替换为：

```tsx
      onClick={() => void openDiffInEditor(projectPath, file.path, file.staged)}
```

FileDiff 图标按钮点击块（:92-96，含一行 Plan 4 注释）替换为：

```tsx
          onClick={(e) => {
            e.stopPropagation();
            void openDiffInEditor(projectPath, file.path, file.staged);
          }}
```

- [ ] **Step 6: HistorySection 注释清理**

`src/features/git/HistorySection.tsx` 行点击块（:71-76）替换为（删两行 Plan 4 注释，行为不变）：

```tsx
              onClick={() => {
                setSelectedCommit(c.hash);
                openCommitDiff(projectPath, c.hash);
              }}
```

- [ ] **Step 7: GitPanel 删内联 diff 窗格**

`src/features/git/GitPanel.tsx` 解构行（:13）替换为：

```ts
  const { status, statusLoading, opRunning, error, refresh, loadBranches, loadStashes } = useGitStore();
```

内联 Diff viewer 整块（:68-84，`{/* Diff viewer */}` 注释至其闭合 `)}`）删除。`<HistorySection projectPath={project.path} />` 直接跟在 CommitSection 块之后。

- [ ] **Step 8: 测试更新——ChangesSection**

`src/features/git/ChangesSection.test.tsx` 三处：

① mock 形状（:22）`viewDiff: ReturnType<typeof vi.fn>;` 替换为：

```ts
  openDiffInEditor: ReturnType<typeof vi.fn>;
```

② beforeEach（:53）`viewDiff: vi.fn().mockResolvedValue(undefined),` 替换为：

```ts
    openDiffInEditor: vi.fn().mockResolvedValue(undefined),
```

③ 末例（:104-108）整块替换为：

```tsx
  it("row click opens the file diff in the editor panel", () => {
    render(<ChangesSection projectPath="/p" />);
    fireEvent.click(screen.getByTestId("row-a.txt"));
    expect(gitState.openDiffInEditor).toHaveBeenCalledWith("/p", "a.txt", false);
  });
```

- [ ] **Step 9: 测试更新——HistorySection**

`src/features/git/HistorySection.test.tsx` 用例标题（:74）替换为：

```ts
  it("clicking a commit highlights it and opens the commit patch in the editor", () => {
```

断言（:78 `openCommitDiff).toHaveBeenCalledWith("/p", "abc1234")`）逐字不动——新签名 `(projectPath, commitHash)` 与该断言完全吻合。

- [ ] **Step 10: 测试更新——git.store.test.ts**

① mock 声明（:4）`const gitDiffMock = vi.fn();` 替换为：

```ts
const gitDiffContentsMock = vi.fn();
const gitCommitPatchMock = vi.fn();
```

② mock 工厂（:27）`gitDiff: (...a: unknown[]) => gitDiffMock(...a),` 替换为：

```ts
  gitDiffContents: (...a: unknown[]) => gitDiffContentsMock(...a),
  gitCommitPatch: (...a: unknown[]) => gitCommitPatchMock(...a),
```

③ bridge mock 之后（:47 的 `}));` 之后）追加 fs.store mock：

```ts
const openDiffTabMock = vi.fn();
vi.mock("./fs.store", () => ({
  useFsStore: { getState: () => ({ openDiffTab: openDiffTabMock }) },
}));
```

④ beforeEach 重置块中 `diff: null,`（:55）与 `diffFile: null,`（:56）两行删除。

⑤ 文件尾追加：

```ts
describe("git.store diff tabs", () => {
  it("openDiffInEditor opens a merge diff tab from the two-version command", async () => {
    gitDiffContentsMock.mockResolvedValue({ original: "v1", revised: "v2", binary: false });
    await useGitStore.getState().openDiffInEditor("/p", "a.txt", false);
    expect(gitDiffContentsMock).toHaveBeenCalledWith("/p", "a.txt", false);
    expect(openDiffTabMock).toHaveBeenCalledWith("diff:unstaged:a.txt", {
      mode: "merge",
      title: "a.txt",
      languageHint: "a.txt",
      original: "v1",
      revised: "v2",
      binary: false,
    });
  });

  it("openCommitDiff opens a patch tab from the commit patch command", async () => {
    gitCommitPatchMock.mockResolvedValue("+v1\n");
    useGitStore.getState().openCommitDiff("/p", "abc1234");
    await vi.waitFor(() => expect(openDiffTabMock).toHaveBeenCalled());
    expect(gitCommitPatchMock).toHaveBeenCalledWith("/p", "abc1234");
    expect(openDiffTabMock).toHaveBeenCalledWith("diff:commit:abc1234", {
      mode: "patch",
      title: "提交 abc1234",
      languageHint: "",
      original: "",
      revised: "+v1\n",
      binary: false,
    });
  });
});
```

- [ ] **Step 11: 残留扫描**

Run: `cd D:/projects/nex && grep -rnE "viewDiff|diffFile|Plan 4" src/ --include="*.ts" --include="*.tsx" ; echo "grep_exit=$?"`
Expected: grep_exit=1（零命中）。`openDiffInEditor` / `openCommitDiff` / `DiffPayload` 相关命中不在此模式内，不受影响。

- [ ] **Step 12: 跑前端门槛**

Run: `pnpm lint 2>&1 | tail -2 ; echo "lint=${PIPESTATUS[0]}" ; pnpm build 2>&1 | tail -2 ; echo "build=${PIPESTATUS[0]}" ; pnpm test 2>&1 | tail -4 ; echo "test=${PIPESTATUS[0]}"`
Expected: lint exit=0（6 条既有 warning，GitPanel.tsx 的 exhaustive-deps 锚点因删行上漂，计数不变）/ build exit=0 / test **167 passed (30 files)**（T4 降级路径则 165）。

- [ ] **Step 13: 提交**

```bash
git add src/stores/git.store.ts src/stores/git.store.test.ts src/features/git/ChangesSection.tsx src/features/git/ChangesSection.test.tsx src/features/git/HistorySection.tsx src/features/git/HistorySection.test.tsx src/features/git/GitPanel.tsx
git commit -m "feat(git): diff 改在编辑器标签打开，删除内联 diff 窗格" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 6: 全量验证 + 桌面冒烟清单（只读，无提交）

**Files:**
- 无代码改动。产出：账本验证记录 + 用户冒烟清单。

- [ ] **Step 1: 前端全量门槛**

Run: `pnpm lint 2>&1 | tail -12 ; echo "lint=${PIPESTATUS[0]}" ; pnpm build 2>&1 | tail -3 ; echo "build=${PIPESTATUS[0]}" ; pnpm test 2>&1 | tail -6 ; echo "test=${PIPESTATUS[0]}"`
Expected: lint exit=0，warning 恰好 6 条且全部为既有（GitPanel.tsx / App.tsx / FileTree.tsx exhaustive-deps + KeybindingHost / button / tabs only-export-components，允许行号锚点漂移）；build exit=0；test exit=0，**167 passed (30 files)**（或 T4 备案 165）。

- [ ] **Step 2: 后端全量门槛**

Run: `cargo test --manifest-path src-tauri/Cargo.toml 2>&1 | grep -E "^test result|running" ; echo "exit=${PIPESTATUS[0]}"`
Expected: exit=0，**51 passed / 0 failed**（lib 14 + db 2 + fs 2 + git_test 33）。

- [ ] **Step 3: 计划-实现 diff 自检**

Run: `git diff main...HEAD --name-only | sort`（在分支上执行；基点 = `git merge-base main HEAD`）
Expected code 文件集合（20 项 + 锁文件，与本计划 File Structure 逐一对应）：

```
package.json
pnpm-lock.yaml
src-tauri/src/commands/git_cmds.rs
src-tauri/src/git/repository.rs
src-tauri/src/git/types.rs
src-tauri/src/lib.rs
src-tauri/tests/git_test.rs
src/bridge/commands.ts
src/bridge/tauri.ts
src/features/editor/DiffView.test.ts
src/features/editor/DiffView.tsx
src/features/editor/EditorPanel.tsx
src/features/git/ChangesSection.test.tsx
src/features/git/ChangesSection.tsx
src/features/git/GitPanel.tsx
src/features/git/HistorySection.test.tsx
src/features/git/HistorySection.tsx
src/stores/fs.store.editor.test.ts
src/stores/fs.store.ts
src/stores/git.store.test.ts
src/stores/git.store.ts
```

外加 `docs/superpowers/plans/2026-07-31-plan4-diff-in-editor.md`（本计划文档，信息性）——除以上集合外**无任何** src/ 或 src-tauri/ 路径（Plan 5/6 的搜索、会话标签文件零命中）。

Run: `git diff main...HEAD | grep -nE "console\.log|dbg!|FIXME" ; echo "grep_exit=$?"`
Expected: grep_exit=1（无残留）。

- [ ] **Step 4: 桌面冒烟清单（移交用户真机执行，不在本任务跑）**

`pnpm tauri dev` 下逐条验证：

1. SCM「更改」组点击任一已修改文件 → 编辑器面板打开标签（标题 = 相对路径），统一合并视图，删除内容以内联折叠块呈现；键入无反应（只读）；语法高亮按扩展名生效。
2. 暂存该文件后在「暂存的更改」组再点它 → **同一标签**就地刷新（不新增标签），标题追加「（已暂存）」，视图变为 HEAD vs 索引。
3. 未跟踪新文件（U）点开 → 左空右全增；已删除文件（D）点开 → 右空左全删。
4. 改动一个二进制文件（如 png）点开 → 标签显示「二进制文件 — 无法显示文本差异」。
5. 展开「历史」点击任一提交行 → 打开「提交 <hash>」补丁标签，+ 行绿底 / - 行红底，头行（diff --git、@@）无着色。
6. diff 标签与普通文件标签并存：自由切换、X 关闭；diff 标签无 ● 脏点，关闭不触发任何保存流程。
7. diff 标签内按 Ctrl+F → 查找栏弹出并可搜索 diff 内容（只读视图查找可用）。
8. 双 Esc 隐藏编辑面板后再点文件行 → 面板重新显示并激活该 diff 标签。
9. 开着 diff 标签切换项目再切回 → 会话缓存保留 diff 标签；**重启应用** → diff 标签不恢复（仅文件标签冷恢复，预期行为）。
10. 提交后文件从列表消失，已打开的该文件 diff 标签仍在（快照语义，手动 X 关闭即可）；再次对同路径新改动点行 → 同一 id 标签载荷刷新。

- [ ] **Step 5: 写报告**

报告写入 `.superpowers/sdd/2026-07-31-plan4-diff-in-editor/task-6-report.md`：三门输出证据、后端输出证据、自检三条结论、冒烟清单（标注移交用户）。无提交。
