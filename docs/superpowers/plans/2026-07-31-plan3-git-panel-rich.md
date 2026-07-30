# Git 面板丰富化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Nex 的 Git 侧栏从「status/diff/commit 三件套」扩展为 VSCode 源代码管理式面板：分支管理、stash 五连、丢弃/撤销暂存、fetch/pull/push/clone 网络操作、GUI 凭据弹窗（仅内存记住）、内存操作日志与提交历史区。
**Architecture:** Rust 端在 `git/repository.rs` 扩同步纯函数（分支/丢弃/stash）+ 新建 `git/network.rs`（RemoteCallbacks + 凭据握手）与 `git/credentials.rs`（oneshot broker 挂独立 tauri State）；仅网络与克隆命令走 `async fn + spawn_blocking`。前端按「桥接常量/封装 → git.store 细粒度 loading + opLog → 面板组件群」三层推进，延续「操作后手动 refresh」事件模型。
**Tech Stack:** Rust（git2 0.19 / tokio full / uuid，均已在依赖树）、Tauri 2 command + State + emit、React 19 + Zustand(immer) + radix-ui（dialog/dropdown-menu）+ lucide-react、Vitest(jsdom) + cargo 集成测试（tempfile）。

## Global Constraints

1. 所有面向用户文案（按钮、tooltip、错误提示、占位符）为简体中文；代码标识符、文件路径、提交信息 scope 保持英文。
2. 提交信息风格：英文 scope + 中文描述，如 `feat(git): 新增分支列表与签出命令`。
3. 门槛三件套：`pnpm lint && pnpm build && pnpm test` 全绿才算完成一步；`pnpm tsc --noEmit` 是 no-op（solution-style tsconfig），真实类型门槛是 `pnpm build`，勿用前者验证。lint 既有 6 条 warning 可接受，不得新增 error。后端任务的 Rust 门槛为 `cargo test --manifest-path src-tauri/Cargo.toml`（首次编译 tauri 依赖较慢，属正常）。
4. 新增 tauri command 必须四处同步：`src-tauri/src/commands/git_cmds.rs`（或新模块）→ `src-tauri/src/lib.rs` invoke_handler → `src/bridge/commands.ts` 常量 → `src/bridge/tauri.ts` 封装；参数一律 camelCase（Tauri 自动转换）。新增事件再同步 `src/bridge/events.ts`。本计划将前两处（git_cmds.rs + lib.rs）放在 T1–T5 各后端任务内，后两处（commands.ts + tauri.ts + events.ts）集中在 T6；任务序列保证 T6 之前前端不引用任何新命令。
5. vitest **未开 globals**：jsdom 测试文件第 1 行必须是 `/** @vitest-environment jsdom */` docblock，且每个文件显式 `afterEach(() => cleanup())`（RTL 自动清理不生效）；模块 mock 用「模块级可变 let 绑定 + vi.mock 工厂闭包延迟读取」模式（参考 `src/features/settings/KeybindingsEditor.test.tsx` 与 `src/stores/conversation.store.test.ts`）。
6. 错误消息约定：技术性错误英文小写（经 NexError::Git），面向用户的校验/状态错误用中文；前端统一经 `errorMessage()` 解包 `{type,message}`。
7. 凭据绝不落盘：仅内存、`type=password`、会话结束清空；无 keychain。
8. Rust 测试放 `src-tauri/tests/`（集成测试，`tempfile::tempdir()` + `Repository::init`），不写内联 mod tests。
9. 不引入新的大型依赖（git2/tokio/tempfile 均已在依赖树；前端仅用既有 radix/shadcn 组件）。

---

## File Structure

**新建（Rust）**

- `src-tauri/tests/git_test.rs` — git 集成测试唯一文件：临时仓库助手（init + 本地 identity 配置）+ 分支/丢弃/stash/凭据 broker/本地远端网络 happy path 全部用例。
- `src-tauri/src/git/credentials.rs` — 凭据 broker：`GitCredentialBroker`（pending oneshot 表 + 会话缓存，均 `Arc<Mutex<HashMap>>`，`Clone` 廉价）、`CredentialAnswer`、`CachedCredential`、事件 payload `GitCredentialRequestPayload`、`host_of`/`session_key` 纯函数。
- `src-tauri/src/git/network.rs` — 网络层：`build_callbacks`（凭据回调三级尝试：会话缓存 → helper/SSH agent/无口令 key → GUI broker 阻塞等待）、`fetch_remote`/`push_remote`/`pull_remote`/`clone_repo`、`default_ssh_private_key`。

**修改（Rust）**

- `src-tauri/src/git/mod.rs` — 增 `pub mod credentials; pub mod network;`。
- `src-tauri/src/git/types.rs` — 增 `BranchInfo`（serde camelCase）、`StashEntry`。
- `src-tauri/src/git/repository.rs` — 增 `list_branches`/`checkout_branch`/`create_branch`/`delete_branch`/`discard_changes`/`revert_staged`/`stash_save`/`stash_list`/`stash_apply`/`stash_pop`/`stash_drop`（全部同步，`&Path` 起手，与既有六函数同风格）。
- `src-tauri/src/commands/git_cmds.rs` — 增 16 个 command：分支四连、discard/revert_staged、stash 五连（同步薄封装）+ fetch/pull/push/clone（`pub async fn` + `tokio::task::spawn_blocking` + `State<GitCredentialBroker>` + `AppHandle`）+ `git_credential_respond`（同步）。
- `src-tauri/src/lib.rs` — invoke_handler 追加 16 条；setup 内 `app.manage(GitCredentialBroker::new())`（独立 State，不动 AppState）。

**修改（前端桥接）**

- `src/bridge/commands.ts` — Git 段追加 16 个常量。
- `src/bridge/events.ts` — 追加 `GIT_CREDENTIAL_REQUEST` 常量 + `GitCredentialRequestPayload` 接口。
- `src/bridge/tauri.ts` — 追加类型 `BranchInfo`/`StashEntry`/`CommitInfo` + 17 个封装函数（含补齐半条链的 `gitLog`）+ `onGitCredentialRequest` 监听封装。

**修改/新建（前端 store）**

- `src/stores/git.store.ts` — 重写：拆分 `statusLoading/branchesLoading/historyLoading/stashesLoading/opRunning`，新增 `branches/commits/stashes/opLog/commitMessage/treeView/historyOpen/opLogOpen` 状态与全部新动作（`commitWith`/`openCommitDiff` 预留 Plan 4 接口名）。
- `src/features/git/credentialRequest.store.ts`（新建）— 凭据请求队列小 store。

**新建（前端组件/工具）**

- `src/features/git/GitCredentialModal.tsx` — 根挂载凭据弹窗（host/用户名/`type=password` 口令/「本次会话记住」/取消）。
- `src/features/git/BranchSelector.tsx` — 分支选择 dialog（搜索 + 本地/远程列表 + 当前打勾 + 新建分支 + 删分支确认）。
- `src/features/git/GitConfirmDialog.tsx` — 破坏性操作确认 dialog（基于既有 `ui/dialog`，项目无 alert-dialog 组件，不新增依赖）。
- `src/features/git/CommitSection.tsx` — 提交区（消息框 + 提交 + 「提交并推送/提交并同步」下拉）。
- `src/features/git/ChangesSection.tsx` — 更改/暂存两组（整组操作 + 每行 hover 图标 + 状态字母着色 + 树视图）。
- `src/features/git/fileTree.ts` — 扁平路径 → 目录树纯函数（树视图用）。
- `src/features/git/GitMoreMenu.tsx` — `···` 更多菜单（含 stash 子菜单 + 显示 GIT 输出）。
- `src/features/git/CloneDialog.tsx` — 克隆 dialog（URL + tauri dialog 插件选目录）。
- `src/features/git/OpLogSection.tsx` — 面板底部可折叠「操作日志」区。
- `src/features/git/HistorySection.tsx` — 面板底部可折叠提交历史区。

**修改（前端其他）**

- `src/features/git/GitPanel.tsx` — 渐进重构为「头部 / ChangesSection / HistorySection / OpLogSection / CommitSection / 内联 diff 窗格（Plan 4 移除）」组装。
- `src/App.tsx` — 根挂载 `<GitCredentialModal />`。
- `src/commands/registry.ts` — 增 `scm.commit` 命令（`Ctrl+Enter`，`when`=提交框聚焦）。
- `src/commands/KeybindingHost.tsx` — `ALLOW_IN_INPUT` 白名单追加 `"scm.commit"`。

**测试新建**

- `src/stores/git.store.test.ts`、`src/features/git/GitCredentialModal.test.tsx`、`src/features/git/fileTree.test.ts`、`src/features/git/BranchSelector.test.tsx`、`src/features/git/ChangesSection.test.tsx`、`src/features/git/HistorySection.test.tsx`；扩展 `src/commands/registry.run.test.ts`、`src/commands/registry.test.ts`、`src/commands/KeybindingHost.test.tsx`。

---

### Task 1: 后端分支操作（list/checkout/create/delete + BranchInfo + git_test.rs）

**Files:**
- Create: `src-tauri/tests/git_test.rs`
- Modify: `src-tauri/src/git/types.rs`、`src-tauri/src/git/repository.rs`、`src-tauri/src/commands/git_cmds.rs`、`src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: `git2 = "0.19"`（Cargo.toml:34，默认 features 含 https/ssh）、`NexError::Git`（error.rs:9-10，`From<git2::Error>` error.rs:27-31）、既有 `repository::commit/stage_files`（供测试助手复用）。
- Produces:
  - `types.rs`：`pub struct BranchInfo { pub name: String, pub is_head: bool, pub is_remote: bool, pub ahead: Option<u32>, pub behind: Option<u32> }`，`#[derive(Debug, Clone, Serialize)]` + `#[serde(rename_all = "camelCase")]`（返回值不经 Tauri 自动转换，必须显式 camelCase，对齐 watcher.rs:33 先例）。
  - `repository.rs`：`pub fn list_branches(repo_path: &Path) -> Result<Vec<BranchInfo>, NexError>`、`pub fn checkout_branch(repo_path: &Path, name: &str) -> Result<(), NexError>`、`pub fn create_branch(repo_path: &Path, name: &str) -> Result<(), NexError>`、`pub fn delete_branch(repo_path: &Path, name: &str) -> Result<(), NexError>`。
  - `git_cmds.rs`：`git_list_branches(project_path: String) -> Result<Vec<BranchInfo>, NexError>`、`git_checkout(project_path: String, name: String) -> Result<(), NexError>`、`git_create_branch(project_path: String, name: String) -> Result<(), NexError>`、`git_delete_branch(project_path: String, name: String) -> Result<(), NexError>`（全部同步）。
  - lib.rs invoke_handler 追加四条（紧随 `commands::git_cmds::git_commit` 之后，lib.rs:50）。

- [ ] **Step 1: 先写失败测试** — 新建 `src-tauri/tests/git_test.rs`，内容：

```rust
use git2::Repository;
use nex_lib::git::repository;
use std::fs;
use std::path::Path;
use tempfile::tempdir;

/// Init a repo with local identity config so commit() can build a signature
/// (CI machines may have no global git identity).
fn init_repo(path: &Path) -> Repository {
    let repo = Repository::init(path).unwrap();
    let mut cfg = repo.config().unwrap();
    cfg.set_str("user.name", "Nex Test").unwrap();
    cfg.set_str("user.email", "test@nex.dev").unwrap();
    repo
}

/// Current branch short name (never hard-code "master": libgit2 may honor
/// init.defaultBranch from the environment).
fn head_name(dir: &Path) -> String {
    Repository::open(dir).unwrap().head().unwrap().shorthand().unwrap().to_string()
}

/// Write a file, stage it, and commit; returns the new HEAD oid string.
fn commit_file(dir: &Path, name: &str, content: &str, msg: &str) -> String {
    fs::write(dir.join(name), content).unwrap();
    repository::stage_files(dir, &[name.to_string()]).unwrap();
    repository::commit(dir, msg).unwrap()
}

#[test]
fn list_branches_reports_locals_and_no_remotes() {
    let dir = tempdir().unwrap();
    init_repo(dir.path());
    commit_file(dir.path(), "a.txt", "v1", "init");
    repository::create_branch(dir.path(), "feature").unwrap();

    let branches = repository::list_branches(dir.path()).unwrap();
    assert!(branches.iter().all(|b| !b.is_remote));
    assert_eq!(branches.len(), 2);
    let head = branches.iter().find(|b| b.is_head).unwrap();
    assert_eq!(head.name, head_name(dir.path()));
    // No upstream configured → ahead/behind stay None.
    assert!(head.ahead.is_none() && head.behind.is_none());
}

#[test]
fn create_and_checkout_branch_moves_head() {
    let dir = tempdir().unwrap();
    init_repo(dir.path());
    commit_file(dir.path(), "a.txt", "v1", "init");
    repository::create_branch(dir.path(), "dev").unwrap();
    repository::checkout_branch(dir.path(), "dev").unwrap();
    assert_eq!(head_name(dir.path()), "dev");
}

#[test]
fn create_branch_rejects_empty_name() {
    let dir = tempdir().unwrap();
    init_repo(dir.path());
    commit_file(dir.path(), "a.txt", "v1", "init");
    let err = repository::create_branch(dir.path(), "   ").unwrap_err();
    assert!(err.to_string().contains("分支名不能为空"));
}

#[test]
fn create_branch_rejects_duplicate_name() {
    let dir = tempdir().unwrap();
    init_repo(dir.path());
    commit_file(dir.path(), "a.txt", "v1", "init");
    repository::create_branch(dir.path(), "dup").unwrap();
    assert!(repository::create_branch(dir.path(), "dup").is_err());
}

#[test]
fn checkout_refuses_dirty_worktree_on_conflicting_paths() {
    let dir = tempdir().unwrap();
    init_repo(dir.path());
    commit_file(dir.path(), "a.txt", "v1", "init");
    // NB: read the default branch name only after the first commit —
    // git_repository_head returns ENOTFOUND on an unborn HEAD.
    let main_branch = head_name(dir.path());
    repository::create_branch(dir.path(), "dev").unwrap();
    repository::checkout_branch(dir.path(), "dev").unwrap();
    commit_file(dir.path(), "a.txt", "v2-on-dev", "dev change");
    repository::checkout_branch(dir.path(), &main_branch).unwrap();
    // Dirty the shared file, then attempt the conflicting checkout.
    fs::write(dir.path().join("a.txt"), "dirty").unwrap();
    let err = repository::checkout_branch(dir.path(), "dev").unwrap_err();
    assert!(err.to_string().contains("无法切换分支"));
}

#[test]
fn checkout_unknown_branch_errors() {
    let dir = tempdir().unwrap();
    init_repo(dir.path());
    commit_file(dir.path(), "a.txt", "v1", "init");
    assert!(repository::checkout_branch(dir.path(), "nope").is_err());
}

#[test]
fn delete_branch_removes_local_branch() {
    let dir = tempdir().unwrap();
    init_repo(dir.path());
    commit_file(dir.path(), "a.txt", "v1", "init");
    repository::create_branch(dir.path(), "tmp").unwrap();
    repository::delete_branch(dir.path(), "tmp").unwrap();
    let branches = repository::list_branches(dir.path()).unwrap();
    assert!(!branches.iter().any(|b| b.name == "tmp"));
}

#[test]
fn delete_head_branch_is_rejected() {
    let dir = tempdir().unwrap();
    init_repo(dir.path());
    commit_file(dir.path(), "a.txt", "v1", "init");
    let current = head_name(dir.path());
    let err = repository::delete_branch(dir.path(), &current).unwrap_err();
    assert!(err.to_string().contains("不能删除当前分支"));
}
```

- [ ] **Step 2: 跑出红** — 运行 `cargo test --manifest-path src-tauri/Cargo.toml --test git_test`，确认编译失败（函数不存在）。

- [ ] **Step 3: 最小实现 — types.rs** — 在 `src-tauri/src/git/types.rs` 末尾追加：

```rust
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchInfo {
    pub name: String,
    pub is_head: bool,
    pub is_remote: bool,
    pub ahead: Option<u32>,
    pub behind: Option<u32>,
}
```

- [ ] **Step 4: 最小实现 — repository.rs** — 在 `src-tauri/src/git/repository.rs` 末尾追加：

```rust
pub fn list_branches(repo_path: &Path) -> Result<Vec<BranchInfo>, NexError> {
    let repo = Repository::open(repo_path)?;
    let mut out = Vec::new();

    for entry in repo.branches(Some(git2::BranchType::Local))? {
        let (branch, _) = entry?;
        let name = branch.name()?.unwrap_or("").to_string();
        let is_head = branch.is_head();
        // ahead/behind is only meaningful for the HEAD branch against its
        // upstream; every other branch reports None (UI shows badges once).
        let (ahead, behind) = if is_head {
            branch
                .upstream()
                .ok()
                .and_then(|u| u.get().target())
                .and_then(|u| branch.get().target().map(|l| (l, u)))
                .map(|(l, u)| {
                    let (a, b) = repo.graph_ahead_behind(l, u).unwrap_or((0, 0));
                    (Some(a as u32), Some(b as u32))
                })
                .unwrap_or((None, None))
        } else {
            (None, None)
        };
        out.push(BranchInfo { name, is_head, is_remote: false, ahead, behind });
    }

    for entry in repo.branches(Some(git2::BranchType::Remote))? {
        let (branch, _) = entry?;
        let name = branch.name()?.unwrap_or("").to_string();
        out.push(BranchInfo { name, is_head: false, is_remote: true, ahead: None, behind: None });
    }

    Ok(out)
}

pub fn checkout_branch(repo_path: &Path, name: &str) -> Result<(), NexError> {
    let repo = Repository::open(repo_path)?;
    let (object, reference) = repo
        .revparse_ext(name)
        .map_err(|e| NexError::Git(format!("branch not found: {name} ({e})")))?;
    repo.checkout_tree(&object, Some(git2::build::CheckoutBuilder::new().safe()))
        .map_err(|e| {
            // libgit2 1.8.1 脏冲突消息为 "N conflict(s) prevent checkout"；
            // 错误码判定（GIT_ECONFLICT）比文案匹配更稳，文案作兜底
            if e.code() == git2::ErrorCode::Conflict
                || (e.message().contains("conflict") && e.message().contains("prevent checkout"))
            {
                NexError::Git("无法切换分支：工作区有未提交的更改".to_string())
            } else {
                NexError::Git(e.message().to_string())
            }
        })?;
    match reference {
        Some(r) => {
            let refname = r
                .name()
                .ok_or_else(|| NexError::Git("invalid reference name".to_string()))?;
            repo.set_head(refname)?;
        }
        None => repo.set_head_detached(object.id())?,
    }
    Ok(())
}

pub fn create_branch(repo_path: &Path, name: &str) -> Result<(), NexError> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(NexError::Git("分支名不能为空".to_string()));
    }
    let repo = Repository::open(repo_path)?;
    let head = repo
        .head()
        .and_then(|h| h.peel_to_commit())
        .map_err(|_| NexError::Git("cannot create a branch on an unborn HEAD".to_string()))?;
    repo.branch(trimmed, &head, false)?;
    Ok(())
}

pub fn delete_branch(repo_path: &Path, name: &str) -> Result<(), NexError> {
    let repo = Repository::open(repo_path)?;
    let mut branch = repo.find_branch(name, git2::BranchType::Local)?;
    if branch.is_head() {
        return Err(NexError::Git("不能删除当前分支".to_string()));
    }
    branch.delete()?;
    Ok(())
}
```

- [ ] **Step 5: 跑出绿** — 运行 `cargo test --manifest-path src-tauri/Cargo.toml --test git_test`，8 个用例全过。

- [ ] **Step 6: command 薄封装** — 在 `src-tauri/src/commands/git_cmds.rs` 末尾追加：

```rust
#[tauri::command]
pub fn git_list_branches(project_path: String) -> Result<Vec<BranchInfo>, NexError> {
    repository::list_branches(Path::new(&project_path))
}

#[tauri::command]
pub fn git_checkout(project_path: String, name: String) -> Result<(), NexError> {
    repository::checkout_branch(Path::new(&project_path), &name)
}

#[tauri::command]
pub fn git_create_branch(project_path: String, name: String) -> Result<(), NexError> {
    repository::create_branch(Path::new(&project_path), &name)
}

#[tauri::command]
pub fn git_delete_branch(project_path: String, name: String) -> Result<(), NexError> {
    repository::delete_branch(Path::new(&project_path), &name)
}
```

- [ ] **Step 7: 注册 invoke_handler** — 在 `src-tauri/src/lib.rs` 的 `commands::git_cmds::git_commit,`（L50）之后插入：

```rust
            commands::git_cmds::git_list_branches,
            commands::git_cmds::git_checkout,
            commands::git_cmds::git_create_branch,
            commands::git_cmds::git_delete_branch,
```

- [ ] **Step 8: 门槛** — `cargo test --manifest-path src-tauri/Cargo.toml`（全部测试通过，含既有 db_test/fs_test）；`pnpm build`（前端未改，应绿）。

- [ ] **Step 9: 提交** —

```
git add src-tauri/tests/git_test.rs src-tauri/src/git/types.rs src-tauri/src/git/repository.rs src-tauri/src/commands/git_cmds.rs src-tauri/src/lib.rs
git commit -m "feat(git): 分支列表/创建/签出/删除后端与集成测试"
```

---

### Task 2: 后端 discard / revert_staged + 测试

**Files:**
- Modify: `src-tauri/src/git/repository.rs`、`src-tauri/src/commands/git_cmds.rs`、`src-tauri/src/lib.rs`、`src-tauri/tests/git_test.rs`

**Interfaces:**
- Consumes: Task 1 的仓库助手（`init_repo`/`commit_file`）、既有 `get_status`（断言用）。
- Produces:
  - `repository.rs`：`pub fn discard_changes(repo_path: &Path, files: &[String]) -> Result<(), NexError>`（未跟踪 → 删盘；已跟踪 → 强制 checkout **index** 覆盖工作区，即还原到暂存版本）、`pub fn revert_staged(repo_path: &Path, files: &[String]) -> Result<(), NexError>`（index 回 HEAD + 工作区回 HEAD 版本；unborn HEAD 时删 index 条目与磁盘文件）。
  - `git_cmds.rs`：`git_discard(project_path: String, files: Vec<String>) -> Result<(), NexError>`、`git_revert_staged(project_path: String, files: Vec<String>) -> Result<(), NexError>`（同步）。
  - lib.rs invoke_handler 追加两条。

- [ ] **Step 1: 先写失败测试** — 在 `src-tauri/tests/git_test.rs` 末尾追加：

```rust
#[test]
fn discard_restores_tracked_and_removes_untracked() {
    let dir = tempdir().unwrap();
    init_repo(dir.path());
    commit_file(dir.path(), "a.txt", "v1", "init");
    fs::write(dir.path().join("a.txt"), "modified").unwrap();
    fs::write(dir.path().join("scratch.tmp"), "junk").unwrap();

    repository::discard_changes(
        dir.path(),
        &["a.txt".to_string(), "scratch.tmp".to_string()],
    )
    .unwrap();

    assert_eq!(fs::read_to_string(dir.path().join("a.txt")).unwrap(), "v1");
    assert!(!dir.path().join("scratch.tmp").exists());
    assert!(repository::get_status(dir.path()).unwrap().files.is_empty());
}

#[test]
fn discard_restores_to_staged_version_not_head() {
    let dir = tempdir().unwrap();
    init_repo(dir.path());
    commit_file(dir.path(), "a.txt", "v1", "init");
    fs::write(dir.path().join("a.txt"), "v2").unwrap();
    repository::stage_files(dir.path(), &["a.txt".to_string()]).unwrap();
    fs::write(dir.path().join("a.txt"), "v3").unwrap();

    repository::discard_changes(dir.path(), &["a.txt".to_string()]).unwrap();

    // Index held v2 → workdir must land on v2, not HEAD's v1.
    assert_eq!(fs::read_to_string(dir.path().join("a.txt")).unwrap(), "v2");
}

#[test]
fn revert_staged_undoes_index_and_workdir_to_head() {
    let dir = tempdir().unwrap();
    init_repo(dir.path());
    commit_file(dir.path(), "a.txt", "v1", "init");
    fs::write(dir.path().join("a.txt"), "v2").unwrap();
    repository::stage_files(dir.path(), &["a.txt".to_string()]).unwrap();

    repository::revert_staged(dir.path(), &["a.txt".to_string()]).unwrap();

    assert_eq!(fs::read_to_string(dir.path().join("a.txt")).unwrap(), "v1");
    assert!(repository::get_status(dir.path()).unwrap().files.is_empty());
}

#[test]
fn revert_staged_on_unborn_head_clears_index_and_disk() {
    let dir = tempdir().unwrap();
    init_repo(dir.path());
    fs::write(dir.path().join("new.txt"), "fresh").unwrap();
    repository::stage_files(dir.path(), &["new.txt".to_string()]).unwrap();

    repository::revert_staged(dir.path(), &["new.txt".to_string()]).unwrap();

    assert!(!dir.path().join("new.txt").exists());
    assert!(repository::get_status(dir.path()).unwrap().files.is_empty());
}
```

- [ ] **Step 2: 跑出红** — `cargo test --manifest-path src-tauri/Cargo.toml --test git_test`，编译失败（函数不存在）。

- [ ] **Step 3: 最小实现** — 在 `src-tauri/src/git/repository.rs` 末尾追加：

```rust
pub fn discard_changes(repo_path: &Path, files: &[String]) -> Result<(), NexError> {
    let repo = Repository::open(repo_path)?;
    let workdir = repo
        .workdir()
        .ok_or_else(|| NexError::Git("cannot discard changes in a bare repository".to_string()))?
        .to_path_buf();

    // Untracked paths have no index entry: delete them from disk directly.
    for file in files {
        if let Ok(s) = repo.status_file(Path::new(file)) {
            if s.is_wt_new() {
                let abs = workdir.join(file);
                if abs.is_dir() {
                    std::fs::remove_dir_all(&abs)?;
                } else if abs.exists() {
                    std::fs::remove_file(&abs)?;
                }
            }
        }
    }

    // Force-checkout the index over the workdir for everything else, so a
    // discarded file lands on its staged version (HEAD when nothing staged).
    let mut co = git2::build::CheckoutBuilder::new();
    co.force();
    for file in files {
        co.path(file);
    }
    repo.checkout_index(None, Some(&mut co))?;
    Ok(())
}

pub fn revert_staged(repo_path: &Path, files: &[String]) -> Result<(), NexError> {
    let repo = Repository::open(repo_path)?;
    match repo.head() {
        Ok(head) => {
            // 1) Reset index entries back to HEAD (unstage)…
            let target = head.peel(git2::ObjectType::Commit)?;
            repo.reset_default(Some(&target), files.iter().map(String::as_str))?;
            // 2) …and restore the workdir to the HEAD version of each file.
            let head_tree = repo.revparse_single("HEAD^{tree}")?;
            let mut co = git2::build::CheckoutBuilder::new();
            co.force();
            for file in files {
                co.path(file);
            }
            repo.checkout_tree(&head_tree, Some(&mut co))?;
        }
        Err(_) => {
            // Unborn HEAD: there is no version to revert to — drop the index
            // entries and remove the files so the change fully disappears.
            let mut index = repo.index()?;
            for file in files {
                index.remove_path(Path::new(file))?;
            }
            index.write()?;
            if let Some(workdir) = repo.workdir() {
                for file in files {
                    let abs = workdir.join(file);
                    if abs.is_file() {
                        std::fs::remove_file(&abs)?;
                    }
                }
            }
        }
    }
    Ok(())
}
```

- [ ] **Step 4: 跑出绿** — `cargo test --manifest-path src-tauri/Cargo.toml --test git_test` 全过。

- [ ] **Step 5: command 薄封装** — 在 `src-tauri/src/commands/git_cmds.rs` 末尾追加：

```rust
#[tauri::command]
pub fn git_discard(project_path: String, files: Vec<String>) -> Result<(), NexError> {
    repository::discard_changes(Path::new(&project_path), &files)
}

#[tauri::command]
pub fn git_revert_staged(project_path: String, files: Vec<String>) -> Result<(), NexError> {
    repository::revert_staged(Path::new(&project_path), &files)
}
```

- [ ] **Step 6: 注册 invoke_handler** — 在 lib.rs 的 `git_delete_branch,` 行之后插入：

```rust
            commands::git_cmds::git_discard,
            commands::git_cmds::git_revert_staged,
```

- [ ] **Step 7: 门槛 + 提交** — `cargo test --manifest-path src-tauri/Cargo.toml` 全绿后：

```
git add src-tauri/src/git/repository.rs src-tauri/src/commands/git_cmds.rs src-tauri/src/lib.rs src-tauri/tests/git_test.rs
git commit -m "feat(git): 丢弃工作区更改与撤销暂存后端"
```

---
### Task 3: 后端 stash 五连 + StashEntry + 测试

**Files:**
- Modify: `src-tauri/src/git/types.rs`、`src-tauri/src/git/repository.rs`、`src-tauri/src/commands/git_cmds.rs`、`src-tauri/src/lib.rs`、`src-tauri/tests/git_test.rs`

**Interfaces:**
- Consumes: Task 1/2 助手与既有函数。
- Produces:
  - `types.rs`：`pub struct StashEntry { pub index: u32, pub message: String }`（`#[derive(Debug, Clone, Serialize)]`，字段单词无需 rename）。
  - `repository.rs`：`pub fn stash_save(repo_path: &Path, message: &str) -> Result<(), NexError>`（空消息自动合成 `WIP on <branch>`；`StashFlags::INCLUDE_UNTRACKED`；unborn HEAD 报中文错）、`pub fn stash_list(repo_path: &Path) -> Result<Vec<StashEntry>, NexError>`、`pub fn stash_apply(repo_path: &Path, index: u32) -> Result<(), NexError>`、`pub fn stash_pop(repo_path: &Path, index: u32) -> Result<(), NexError>`、`pub fn stash_drop(repo_path: &Path, index: u32) -> Result<(), NexError>`。
  - `git_cmds.rs`：`git_stash_save(project_path: String, message: String)`、`git_stash_list(project_path: String) -> Result<Vec<StashEntry>, NexError>`、`git_stash_apply(project_path: String, index: u32)`、`git_stash_pop(project_path: String, index: u32)`、`git_stash_drop(project_path: String, index: u32)`（同步）。
  - lib.rs invoke_handler 追加五条。

- [ ] **Step 1: 先写失败测试** — 在 `src-tauri/tests/git_test.rs` 末尾追加：

```rust
#[test]
fn stash_save_clears_workdir_including_untracked() {
    let dir = tempdir().unwrap();
    init_repo(dir.path());
    commit_file(dir.path(), "a.txt", "v1", "init");
    fs::write(dir.path().join("a.txt"), "dirty").unwrap();
    fs::write(dir.path().join("new.txt"), "untracked").unwrap();

    repository::stash_save(dir.path(), "my stash").unwrap();

    assert!(repository::get_status(dir.path()).unwrap().files.is_empty());
    let list = repository::stash_list(dir.path()).unwrap();
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].index, 0);
    assert!(list[0].message.contains("my stash"));
}

#[test]
fn stash_save_empty_message_synthesizes_default() {
    let dir = tempdir().unwrap();
    init_repo(dir.path());
    commit_file(dir.path(), "a.txt", "v1", "init");
    fs::write(dir.path().join("a.txt"), "dirty").unwrap();

    repository::stash_save(dir.path(), "  ").unwrap();

    let list = repository::stash_list(dir.path()).unwrap();
    assert!(list[0].message.contains("WIP on"));
}

#[test]
fn stash_pop_restores_changes_and_drops_entry() {
    let dir = tempdir().unwrap();
    init_repo(dir.path());
    commit_file(dir.path(), "a.txt", "v1", "init");
    fs::write(dir.path().join("a.txt"), "dirty").unwrap();
    repository::stash_save(dir.path(), "wip").unwrap();

    repository::stash_pop(dir.path(), 0).unwrap();

    assert_eq!(fs::read_to_string(dir.path().join("a.txt")).unwrap(), "dirty");
    assert!(repository::stash_list(dir.path()).unwrap().is_empty());
}

#[test]
fn stash_apply_restores_but_keeps_entry() {
    let dir = tempdir().unwrap();
    init_repo(dir.path());
    commit_file(dir.path(), "a.txt", "v1", "init");
    fs::write(dir.path().join("a.txt"), "dirty").unwrap();
    repository::stash_save(dir.path(), "wip").unwrap();

    repository::stash_apply(dir.path(), 0).unwrap();

    assert_eq!(fs::read_to_string(dir.path().join("a.txt")).unwrap(), "dirty");
    assert_eq!(repository::stash_list(dir.path()).unwrap().len(), 1);
}

#[test]
fn stash_drop_removes_entry_without_restoring() {
    let dir = tempdir().unwrap();
    init_repo(dir.path());
    commit_file(dir.path(), "a.txt", "v1", "init");
    fs::write(dir.path().join("a.txt"), "dirty").unwrap();
    repository::stash_save(dir.path(), "wip").unwrap();

    repository::stash_drop(dir.path(), 0).unwrap();

    assert!(repository::stash_list(dir.path()).unwrap().is_empty());
    assert_eq!(fs::read_to_string(dir.path().join("a.txt")).unwrap(), "v1");
}

#[test]
fn stash_save_on_unborn_head_errors() {
    let dir = tempdir().unwrap();
    init_repo(dir.path());
    let err = repository::stash_save(dir.path(), "wip").unwrap_err();
    assert!(err.to_string().contains("unborn HEAD"));
}
```

- [ ] **Step 2: 跑出红** — `cargo test --manifest-path src-tauri/Cargo.toml --test git_test` 编译失败。

- [ ] **Step 3: 最小实现 — types.rs** — 在 `src-tauri/src/git/types.rs` 末尾追加：

```rust
#[derive(Debug, Clone, Serialize)]
pub struct StashEntry {
    pub index: u32,
    pub message: String,
}
```

- [ ] **Step 4: 最小实现 — repository.rs** — 在 `src-tauri/src/git/repository.rs` 末尾追加：

```rust
pub fn stash_save(repo_path: &Path, message: &str) -> Result<(), NexError> {
    // git2 0.19 的 stash_* 全系 &mut self
    let mut repo = Repository::open(repo_path)?;
    let sig = repo.signature()?;
    if repo.head().and_then(|h| h.peel_to_commit()).is_err() {
        return Err(NexError::Git(
            "cannot stash on an unborn HEAD: commit something first".to_string(),
        ));
    }
    // libgit2 stores an empty message verbatim; synthesize git's default.
    let fallback = match repo.head().ok().and_then(|h| h.shorthand().map(|s| s.to_string())) {
        Some(branch) => format!("WIP on {branch}"),
        None => "WIP on HEAD".to_string(),
    };
    let msg = if message.trim().is_empty() { fallback.as_str() } else { message };
    repo.stash_save(&sig, msg, Some(git2::StashFlags::INCLUDE_UNTRACKED))?;
    Ok(())
}

pub fn stash_list(repo_path: &Path) -> Result<Vec<StashEntry>, NexError> {
    let mut repo = Repository::open(repo_path)?;
    let mut out = Vec::new();
    repo.stash_foreach(|index, message, _oid| {
        out.push(StashEntry { index: index as u32, message: message.to_string() });
        true
    })?;
    Ok(out)
}

// NB: git2 0.19 的 stash_apply/pop/drop 形参是 usize；外部保持 u32，调用点无损转换。
pub fn stash_apply(repo_path: &Path, index: u32) -> Result<(), NexError> {
    let mut repo = Repository::open(repo_path)?;
    repo.stash_apply(index as usize, None)?;
    Ok(())
}

pub fn stash_pop(repo_path: &Path, index: u32) -> Result<(), NexError> {
    let mut repo = Repository::open(repo_path)?;
    repo.stash_pop(index as usize, None)?;
    Ok(())
}

pub fn stash_drop(repo_path: &Path, index: u32) -> Result<(), NexError> {
    let mut repo = Repository::open(repo_path)?;
    repo.stash_drop(index as usize)?;
    Ok(())
}
```

- [ ] **Step 5: 跑出绿** — `cargo test --manifest-path src-tauri/Cargo.toml --test git_test` 全过。

- [ ] **Step 6: command 薄封装** — 在 `src-tauri/src/commands/git_cmds.rs` 末尾追加：

```rust
#[tauri::command]
pub fn git_stash_save(project_path: String, message: String) -> Result<(), NexError> {
    repository::stash_save(Path::new(&project_path), &message)
}

#[tauri::command]
pub fn git_stash_list(project_path: String) -> Result<Vec<StashEntry>, NexError> {
    repository::stash_list(Path::new(&project_path))
}

#[tauri::command]
pub fn git_stash_apply(project_path: String, index: u32) -> Result<(), NexError> {
    repository::stash_apply(Path::new(&project_path), index)
}

#[tauri::command]
pub fn git_stash_pop(project_path: String, index: u32) -> Result<(), NexError> {
    repository::stash_pop(Path::new(&project_path), index)
}

#[tauri::command]
pub fn git_stash_drop(project_path: String, index: u32) -> Result<(), NexError> {
    repository::stash_drop(Path::new(&project_path), index)
}
```

- [ ] **Step 7: 注册 invoke_handler** — 在 lib.rs 的 `git_revert_staged,` 行之后插入：

```rust
            commands::git_cmds::git_stash_save,
            commands::git_cmds::git_stash_list,
            commands::git_cmds::git_stash_apply,
            commands::git_cmds::git_stash_pop,
            commands::git_cmds::git_stash_drop,
```

- [ ] **Step 8: 门槛 + 提交** — `cargo test --manifest-path src-tauri/Cargo.toml` 全绿后：

```
git add src-tauri/src/git/types.rs src-tauri/src/git/repository.rs src-tauri/src/commands/git_cmds.rs src-tauri/src/lib.rs src-tauri/tests/git_test.rs
git commit -m "feat(git): stash 保存/列表/应用/弹出/丢弃后端"
```

---

### Task 4: 凭据 broker（State + credentials 模块 + git_credential_respond + broker 单测）

**Files:**
- Create: `src-tauri/src/git/credentials.rs`
- Modify: `src-tauri/src/git/mod.rs`、`src-tauri/src/commands/git_cmds.rs`、`src-tauri/src/lib.rs`、`src-tauri/tests/git_test.rs`

**Interfaces:**
- Consumes: `uuid = "1"`（Cargo.toml:33，v4+serde）、`tokio`（Cargo.toml:30，full features 含 sync/time/rt/macros）、`NexError`、tauri `AppHandle`/`Emitter`（watcher.rs:18 同款导入）。
- Produces:
  - 模块 `nex_lib::git::credentials`：
    - `pub const GIT_CREDENTIAL_REQUEST_EVENT: &str = "git-credential-request"`；
    - `pub struct CredentialAnswer { pub username: Option<String>, pub secret: Option<String> }`（Clone + Debug）；
    - `pub struct CachedCredential { pub username: String, pub secret: String, pub kind: String }`（Clone + Debug；`kind` ∈ `"https"` | `"ssh-passphrase"`）；
    - `pub struct GitCredentialRequestPayload { pub request_id, pub url: String, pub username_hint: Option<String>, pub kind: String }`（Serialize + `#[serde(rename_all = "camelCase")]`，与 events.ts 对齐）；
    - `#[derive(Clone)] pub struct GitCredentialBroker`（内部两枚 `Arc<Mutex<HashMap>>`）方法：`pub fn new() -> Self`、`pub fn register_pending(&self, url: &str, kind: &str) -> (String, tokio::sync::oneshot::Receiver<Option<CredentialAnswer>>)`、`pub fn request_gui(&self, app: &AppHandle, url: &str, username_hint: Option<&str>, kind: &str) -> Result<Option<CredentialAnswer>, NexError>`（emit 事件后在 `Handle::current().block_on` 内 `tokio::time::timeout(300s)` 等待；只能在 `spawn_blocking` 线程调用）、`pub fn respond(&self, request_id: &str, username: Option<String>, secret: Option<String>, remember: bool) -> Result<(), NexError>`、`pub fn lookup_session(&self, url: &str, kind: &str) -> Option<CachedCredential>`；
    - 纯函数 `pub fn session_key(url: &str, kind: &str) -> String`、`pub fn host_of(url: &str) -> String`。
  - 独立 tauri State：lib.rs setup 内 `app.manage(GitCredentialBroker::new())`（最小改动面：不动 `state.rs` 的 AppState 结构）。
  - `git_cmds.rs`：`git_credential_respond(broker: State<GitCredentialBroker>, request_id: String, username: Option<String>, password: Option<String>, remember: bool) -> Result<(), NexError>`（同步；参数 `password` 映射到 broker 的 `secret`）。
  - lib.rs invoke_handler 追加一条。
- 缓存键决策（微决策）：`remember=true` 的键为 `"{kind}:{host}"`（host 由 `host_of` 从 URL 提取）；spec 提到的「key 指纹」在 v1 以 host 粒度等价满足验收「同 host 不再弹」，避免读取/解析公钥的额外复杂度。

- [ ] **Step 1: 先写失败测试** — 在 `src-tauri/tests/git_test.rs` 顶部 `use` 区追加：

```rust
use nex_lib::git::credentials::{host_of, session_key, GitCredentialBroker};
```

并在文件末尾追加：

```rust
#[test]
fn host_of_parses_common_remote_shapes() {
    assert_eq!(host_of("https://github.com/owner/repo.git"), "github.com");
    assert_eq!(host_of("https://user@codeberg.org:443/o/r"), "codeberg.org");
    assert_eq!(host_of("ssh://git@gitlab.com:22/group/proj.git"), "gitlab.com");
    assert_eq!(host_of("git@github.com:owner/repo.git"), "github.com");
}

#[test]
fn session_key_scopes_cache_by_kind_and_host() {
    assert_eq!(session_key("https://github.com/a/b", "https"), "https:github.com");
    assert_ne!(
        session_key("https://github.com/a/b", "https"),
        session_key("https://github.com/a/b", "ssh-passphrase"),
    );
}

#[tokio::test]
async fn respond_delivers_answer_to_pending_receiver() {
    let broker = GitCredentialBroker::new();
    let (id, rx) = broker.register_pending("https://github.com/a/b", "https");
    broker.respond(&id, Some("u".into()), Some("p".into()), false).unwrap();
    let answer = rx.await.unwrap().expect("answer");
    assert_eq!(answer.username.as_deref(), Some("u"));
    assert_eq!(answer.secret.as_deref(), Some("p"));
}

#[tokio::test]
async fn respond_without_credentials_means_cancel() {
    let broker = GitCredentialBroker::new();
    let (id, rx) = broker.register_pending("https://github.com/a/b", "https");
    broker.respond(&id, None, None, false).unwrap();
    assert!(rx.await.unwrap().is_none());
}

#[tokio::test]
async fn remember_caches_for_same_host_and_kind_only() {
    let broker = GitCredentialBroker::new();
    let (id, rx) = broker.register_pending("https://github.com/a/b", "https");
    broker.respond(&id, Some("u".into()), Some("p".into()), true).unwrap();
    let _ = rx.await;
    assert!(broker.lookup_session("https://github.com/other/repo", "https").is_some());
    assert!(broker.lookup_session("https://gitlab.com/a/b", "https").is_none());
    assert!(broker.lookup_session("https://github.com/a/b", "ssh-passphrase").is_none());
}

#[test]
fn respond_unknown_request_id_errors() {
    let broker = GitCredentialBroker::new();
    let err = broker.respond("nope", Some("u".into()), Some("p".into()), false).unwrap_err();
    assert!(err.to_string().contains("no pending credential request"));
}
```

- [ ] **Step 2: 跑出红** — `cargo test --manifest-path src-tauri/Cargo.toml --test git_test` 编译失败（模块不存在）。

- [ ] **Step 3: 最小实现 — credentials.rs** — 新建 `src-tauri/src/git/credentials.rs`：

```rust
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::error::NexError;

/// Name of the event emitted when a git network operation needs credentials;
/// must match `EVENTS.GIT_CREDENTIAL_REQUEST` in `src/bridge/events.ts`.
pub const GIT_CREDENTIAL_REQUEST_EVENT: &str = "git-credential-request";

/// How long a GUI credential prompt may stay unanswered before the operation
/// fails (seconds). Matches the ~5-minute ceiling in the design spec.
const REQUEST_TIMEOUT_SECS: u64 = 300;

/// A user-supplied answer to a credential prompt. `secret` covers both
/// HTTPS passwords/tokens and SSH key passphrases.
#[derive(Debug, Clone)]
pub struct CredentialAnswer {
    pub username: Option<String>,
    pub secret: Option<String>,
}

/// A session-only cached credential ("remember for this session"). Never
/// persisted to disk; lives until process exit.
#[derive(Debug, Clone)]
pub struct CachedCredential {
    pub username: String,
    pub secret: String,
    pub kind: String, // "https" | "ssh-passphrase"
}

/// Payload of the `git-credential-request` event. Field names must stay
/// camelCase to match `GitCredentialRequestPayload` in `src/bridge/events.ts`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCredentialRequestPayload {
    pub request_id: String,
    pub url: String,
    pub username_hint: Option<String>,
    pub kind: String,
}

struct PendingRequest {
    tx: tokio::sync::oneshot::Sender<Option<CredentialAnswer>>,
    url: String,
    kind: String,
}

/// In-memory credential broker: pairs git2 credential callbacks (blocked on a
/// oneshot channel inside spawn_blocking) with the GUI modal's
/// `git_credential_respond` command. Clone is cheap (Arc handles).
#[derive(Clone)]
pub struct GitCredentialBroker {
    pending: Arc<Mutex<HashMap<String, PendingRequest>>>,
    session_cache: Arc<Mutex<HashMap<String, CachedCredential>>>,
}

impl GitCredentialBroker {
    pub fn new() -> Self {
        Self {
            pending: Arc::new(Mutex::new(HashMap::new())),
            session_cache: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Register a pending prompt; the caller blocks on the returned receiver.
    pub fn register_pending(
        &self,
        url: &str,
        kind: &str,
    ) -> (String, tokio::sync::oneshot::Receiver<Option<CredentialAnswer>>) {
        let request_id = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.pending.lock().unwrap().insert(
            request_id.clone(),
            PendingRequest { tx, url: url.to_string(), kind: kind.to_string() },
        );
        (request_id, rx)
    }

    /// Emit the GUI request, then block the calling spawn_blocking thread
    /// until the user answers, cancels, or the timeout elapses. Must only be
    /// called from inside `tokio::task::spawn_blocking` (needs a runtime
    /// handle on the current thread).
    pub fn request_gui(
        &self,
        app: &AppHandle,
        url: &str,
        username_hint: Option<&str>,
        kind: &str,
    ) -> Result<Option<CredentialAnswer>, NexError> {
        let (request_id, rx) = self.register_pending(url, kind);
        let payload = GitCredentialRequestPayload {
            request_id: request_id.clone(),
            url: url.to_string(),
            username_hint: username_hint.map(|s| s.to_string()),
            kind: kind.to_string(),
        };
        app.emit(GIT_CREDENTIAL_REQUEST_EVENT, payload)
            .map_err(|e| NexError::Internal(format!("failed to emit credential request: {e}")))?;

        let waited = tokio::runtime::Handle::current().block_on(async {
            tokio::time::timeout(std::time::Duration::from_secs(REQUEST_TIMEOUT_SECS), rx).await
        });
        self.pending.lock().unwrap().remove(&request_id);
        match waited {
            Ok(Ok(answer)) => Ok(answer),
            Ok(Err(_)) => Ok(None), // sender dropped → treat as cancel
            Err(_) => Err(NexError::Git("credential request timed out".to_string())),
        }
    }

    /// Deliver a GUI answer. `username=None && secret=None` means the user
    /// cancelled. `remember=true` stores the credential in the session cache
    /// keyed by host+kind (memory only, cleared at process exit).
    pub fn respond(
        &self,
        request_id: &str,
        username: Option<String>,
        secret: Option<String>,
        remember: bool,
    ) -> Result<(), NexError> {
        let entry = self
            .pending
            .lock()
            .unwrap()
            .remove(request_id)
            .ok_or_else(|| NexError::Git("no pending credential request with that id".to_string()))?;
        let answer = match (username.clone(), secret.clone()) {
            (None, None) => None,
            (u, s) => Some(CredentialAnswer { username: u, secret: s }),
        };
        if remember {
            if let (Some(u), Some(s)) = (username, secret) {
                self.session_cache.lock().unwrap().insert(
                    session_key(&entry.url, &entry.kind),
                    CachedCredential { username: u, secret: s, kind: entry.kind.clone() },
                );
            }
        }
        // The receiver may already be gone (timeout raced us) — that is fine.
        let _ = entry.tx.send(answer);
        Ok(())
    }

    pub fn lookup_session(&self, url: &str, kind: &str) -> Option<CachedCredential> {
        self.session_cache.lock().unwrap().get(&session_key(url, kind)).cloned()
    }
}

/// Cache scope: same host + same kind.
pub fn session_key(url: &str, kind: &str) -> String {
    format!("{}:{}", kind, host_of(url))
}

/// Best-effort host extraction from git remote URLs. Handles
/// `https://host/x`, `https://user@host:443/x`, `ssh://git@host:22/x`, and
/// scp-like `git@host:x/y`.
pub fn host_of(url: &str) -> String {
    let after_scheme = url.split_once("://").map(|(_, rest)| rest).unwrap_or(url);
    let authority = after_scheme.split('/').next().unwrap_or("");
    let no_user = authority.rsplit_once('@').map(|(_, rest)| rest).unwrap_or(authority);
    no_user.split(':').next().unwrap_or(no_user).to_string()
}
```

- [ ] **Step 4: 导出模块** — 将 `src-tauri/src/git/mod.rs` 改为：

```rust
pub mod credentials;
pub mod network;
pub mod repository;
pub mod types;
```

注意：`network` 模块到 T5 才创建。若希望 T4 结束后仓库即可编译，本步先只加 `pub mod credentials;`，T5 Step 6 再补 `pub mod network;`。**采用后者**：本步 `git/mod.rs` 内容为

```rust
pub mod credentials;
pub mod repository;
pub mod types;
```

- [ ] **Step 5: 跑出绿** — `cargo test --manifest-path src-tauri/Cargo.toml --test git_test` 全过（broker 六个新用例 + 既有用例）。

- [ ] **Step 6: respond 命令** — 在 `src-tauri/src/commands/git_cmds.rs` 顶部 `use` 区追加：

```rust
use crate::git::credentials::GitCredentialBroker;
use tauri::State;
```

并在文件末尾追加：

```rust
#[tauri::command]
pub fn git_credential_respond(
    broker: State<GitCredentialBroker>,
    request_id: String,
    username: Option<String>,
    password: Option<String>,
    remember: bool,
) -> Result<(), NexError> {
    broker.respond(&request_id, username, password, remember)
}
```

- [ ] **Step 7: 挂 State + 注册命令** — 修改 `src-tauri/src/lib.rs`：
  1. 顶部 `use` 区追加 `use git::credentials::GitCredentialBroker;`；
  2. setup 内 `app.manage(AppState { ... });`（L105-110）之后追加：

```rust
            // In-memory git credential broker for the GUI auth dialog
            // (Plan 3). Independent State: AppState stays untouched.
            app.manage(GitCredentialBroker::new());
```

  3. invoke_handler 的 `git_stash_drop,` 行之后插入：

```rust
            commands::git_cmds::git_credential_respond,
```

- [ ] **Step 8: 门槛 + 提交** — `cargo test --manifest-path src-tauri/Cargo.toml` 全绿后：

```
git add src-tauri/src/git/credentials.rs src-tauri/src/git/mod.rs src-tauri/src/commands/git_cmds.rs src-tauri/src/lib.rs src-tauri/tests/git_test.rs
git commit -m "feat(git): 凭据 broker 与 git_credential_respond 命令"
```

---
### Task 5: 后端网络操作（fetch/pull/push/clone，async + spawn_blocking，接入凭据回调）

**Files:**
- Create: `src-tauri/src/git/network.rs`
- Modify: `src-tauri/src/git/mod.rs`、`src-tauri/src/commands/git_cmds.rs`、`src-tauri/src/lib.rs`、`src-tauri/tests/git_test.rs`

**Interfaces:**
- Consumes: Task 4 的 `GitCredentialBroker`/`CredentialAnswer`/`CachedCredential`、tauri `AppHandle`、既有 `repository::commit/stage_files`（测试造提交用）。
- Produces:
  - 模块 `nex_lib::git::network`：
    - `pub fn build_callbacks<'a>(app: &'a AppHandle, broker: &'a GitCredentialBroker) -> git2::RemoteCallbacks<'a>` — credentials 回调顺序：① `broker.lookup_session`（会话缓存）→ ② 首次尝试 `Cred::credential_helper`（https）/ `Cred::ssh_key_from_agent` + 无口令默认私钥（ssh）→ ③ `broker.request_gui` 阻塞等待（取消 → git2 错误 `authentication cancelled by user`）；`kind` 由 `allowed.contains(CredentialType::SSH_KEY)` 判定。
    - `pub fn fetch_remote(repo_path: &Path, remote_name: &str, callbacks: RemoteCallbacks<'_>) -> Result<(), NexError>`
    - `pub fn push_remote(repo_path: &Path, remote_name: &str, branch: &str, callbacks: RemoteCallbacks<'_>) -> Result<(), NexError>` — `ErrorCode::NotFastForward`（git2 0.19 变体名，对应 libgit2 GIT_ENONFASTFORWARD）或文案 `non-fastforwardable`（libgit2 1.8.1 无连字符）/`non-fast-forward`/`failed to write ref` → 中文「推送被拒绝：非快进，请先拉取合并」；其余拒绝统一包装「推送失败：<原始消息>」。
    - `pub fn pull_remote(repo_path: &Path, remote_name: &str, callbacks: RemoteCallbacks<'_>) -> Result<(), NexError>` — fetch + merge_analysis：up-to-date 直接返回；fast-forward 前先 `worktree_is_dirty` 检查（dirty → 中文「请先提交或存储改动后再拉取」，防 force checkout 丢改），通过后走 `set_target`+`checkout_head(force)`；否则真实 merge，有冲突报中文「合并存在冲突，请手动解决」，无冲突自动产生 merge commit。
    - `pub fn clone_repo(url: &str, dest: &Path, callbacks: RemoteCallbacks<'_>) -> Result<(), NexError>` — `RepoBuilder::fetch_options` 挂 callbacks。
    - `pub fn default_ssh_private_key() -> Option<PathBuf>` — 依次探测 `~/.ssh/id_ed25519`、`id_ecdsa`、`id_rsa`（home 取 `USERPROFILE` 或 `HOME`）。
  - `git_cmds.rs` 异步四连（本仓 git 模块首批 async command；模式＝`State::inner().clone()` + `AppHandle`（均 Clone）移入 `spawn_blocking`，join 错误映射 `NexError::Internal`）：
    - `pub async fn git_fetch(app: AppHandle, broker: State<'_, GitCredentialBroker>, project_path: String, remote: String) -> Result<(), NexError>`
    - `pub async fn git_pull(app: AppHandle, broker: State<'_, GitCredentialBroker>, project_path: String, remote: String) -> Result<(), NexError>`
    - `pub async fn git_push(app: AppHandle, broker: State<'_, GitCredentialBroker>, project_path: String, remote: String, branch: String) -> Result<(), NexError>`
    - `pub async fn git_clone(app: AppHandle, broker: State<'_, GitCredentialBroker>, url: String, dest: String) -> Result<(), NexError>`
  - lib.rs invoke_handler 追加四条。
- 事件模型（裁定 A2）：这些命令**不** emit `git-status-changed`，前端在 store 动作内手动 refresh；command 接收 `AppHandle` 仅为传给 broker 发凭据事件（新命令无签名兼容负担，与 A2「不给既有命令注入 AppHandle」不冲突）。

- [ ] **Step 1: 先写失败测试** — 在 `src-tauri/tests/git_test.rs` 顶部 `use` 区追加：

```rust
use git2::RemoteCallbacks;
use nex_lib::git::network;
```

并在文件末尾追加：

```rust
/// file:// URL for the local transport (works on Windows and Unix alike).
fn file_url(p: &Path) -> String {
    let s = p.to_str().unwrap().replace('\\', "/");
    if s.starts_with('/') { format!("file://{s}") } else { format!("file:///{s}") }
}

/// Clones inherit objects but not identity config; set it on any repo we
/// intend to commit in.
fn set_ident(repo: &Repository) {
    let mut cfg = repo.config().unwrap();
    cfg.set_str("user.name", "Nex Test").unwrap();
    cfg.set_str("user.email", "test@nex.dev").unwrap();
}

#[test]
fn push_pull_round_trip_over_local_bare_remote() {
    // Seed repo with one commit and a bare "remote".
    let seed = tempdir().unwrap();
    init_repo(seed.path());
    commit_file(seed.path(), "a.txt", "v1", "init");
    let branch = head_name(seed.path());
    let bare = tempdir().unwrap();
    Repository::init_bare(bare.path()).unwrap();
    {
        let repo = Repository::open(seed.path()).unwrap();
        repo.remote("origin", &file_url(bare.path())).unwrap();
    }
    network::push_remote(seed.path(), "origin", &branch, RemoteCallbacks::new()).unwrap();

    // Clone the bare remote (local transport: no credentials callback fires).
    let work = tempdir().unwrap();
    let work_path = work.path().join("clone");
    network::clone_repo(&file_url(bare.path()), &work_path, RemoteCallbacks::new()).unwrap();
    assert_eq!(fs::read_to_string(work_path.join("a.txt")).unwrap(), "v1");
    {
        let repo = Repository::open(&work_path).unwrap();
        set_ident(&repo);
    }

    // Advance the seed; the clone fetches + pulls (fast-forward path).
    commit_file(seed.path(), "a.txt", "v2", "second");
    network::push_remote(seed.path(), "origin", &branch, RemoteCallbacks::new()).unwrap();
    network::fetch_remote(&work_path, "origin", RemoteCallbacks::new()).unwrap();
    network::pull_remote(&work_path, "origin", RemoteCallbacks::new()).unwrap();
    assert_eq!(fs::read_to_string(work_path.join("a.txt")).unwrap(), "v2");

    // Diverge the clone, let the seed push again, then expect a readable
    // non-fast-forward rejection.
    commit_file(&work_path, "a.txt", "v3-diverge", "third");
    commit_file(seed.path(), "a.txt", "v4", "fourth");
    network::push_remote(seed.path(), "origin", &branch, RemoteCallbacks::new()).unwrap();
    let err = network::push_remote(&work_path, "origin", &branch, RemoteCallbacks::new())
        .unwrap_err();
    assert!(err.to_string().contains("推送被拒绝"));
}

#[test]
fn clone_creates_working_copy() {
    let seed = tempdir().unwrap();
    init_repo(seed.path());
    commit_file(seed.path(), "README.md", "# hi", "init");

    let dest_parent = tempdir().unwrap();
    let dest = dest_parent.path().join("fresh-clone");
    network::clone_repo(&file_url(seed.path()), &dest, RemoteCallbacks::new()).unwrap();

    assert!(dest.join(".git").exists());
    assert_eq!(fs::read_to_string(dest.join("README.md")).unwrap(), "# hi");
}
```

- [ ] **Step 2: 跑出红** — `cargo test --manifest-path src-tauri/Cargo.toml --test git_test` 编译失败（network 模块不存在）。

- [ ] **Step 3: 最小实现 — network.rs** — 新建 `src-tauri/src/git/network.rs`：

```rust
use std::path::{Path, PathBuf};

use git2::{Cred, CredentialType, RemoteCallbacks, Repository};
use tauri::AppHandle;

use super::credentials::{CachedCredential, CredentialAnswer, GitCredentialBroker};
use crate::error::NexError;

pub fn fetch_remote(
    repo_path: &Path,
    remote_name: &str,
    callbacks: RemoteCallbacks<'_>,
) -> Result<(), NexError> {
    let repo = Repository::open(repo_path)?;
    let mut remote = repo.find_remote(remote_name)?;
    let mut opts = git2::FetchOptions::new();
    opts.remote_callbacks(callbacks);
    remote.fetch(&[] as &[&str], Some(&mut opts), None)?;
    Ok(())
}

pub fn push_remote(
    repo_path: &Path,
    remote_name: &str,
    branch: &str,
    callbacks: RemoteCallbacks<'_>,
) -> Result<(), NexError> {
    let repo = Repository::open(repo_path)?;
    let mut remote = repo.find_remote(remote_name)?;
    let mut opts = git2::PushOptions::new();
    opts.remote_callbacks(callbacks);
    let refspec = format!("refs/heads/{branch}:refs/heads/{branch}");
    remote.push(&[refspec], Some(&mut opts)).map_err(|e| {
        // libgit2 1.8.1 非快进消息为 "cannot push non-fastforwardable reference"
        //（无连字符）+ ErrorCode::NotFastForward（git2 0.19 变体名）；码判优先，
        // 文案兜底，其余拒绝原因（hook/权限/保护分支）统一中文包装透传
        let msg = e.message();
        if e.code() == git2::ErrorCode::NotFastForward
            || msg.contains("non-fastforwardable")
            || msg.contains("non-fast-forward")
            || msg.contains("failed to write ref")
        {
            NexError::Git("推送被拒绝：非快进，请先拉取合并".to_string())
        } else {
            NexError::Git(format!("推送失败：{msg}"))
        }
    })?;
    Ok(())
}

pub fn pull_remote(
    repo_path: &Path,
    remote_name: &str,
    callbacks: RemoteCallbacks<'_>,
) -> Result<(), NexError> {
    fetch_remote(repo_path, remote_name, callbacks)?;

    let repo = Repository::open(repo_path)?;
    let branch = repo
        .head()?
        .shorthand()
        .ok_or_else(|| NexError::Git("cannot pull on an unborn HEAD".to_string()))?
        .to_string();
    let fetch_head = repo.find_reference("FETCH_HEAD")?;
    let fetch_commit = repo.reference_to_annotated_commit(&fetch_head)?;

    let (analysis, _) = repo.merge_analysis(&[&fetch_commit])?;
    if analysis.is_up_to_date() {
        return Ok(());
    }
    if analysis.is_fast_forward() {
        // 快进后的 force checkout 会静默丢弃未提交改动——先拦下（R1）
        if worktree_is_dirty(&repo)? {
            return Err(NexError::Git(
                "请先提交或存储改动后再拉取".to_string(),
            ));
        }
        let refname = format!("refs/heads/{branch}");
        match repo.find_reference(&refname) {
            Ok(mut r) => {
                r.set_target(fetch_commit.id(), "nex fast-forward")?;
            }
            Err(_) => {
                repo.reference(&refname, fetch_commit.id(), true, "nex fast-forward")?;
            }
        }
        repo.set_head(&refname)?;
        repo.checkout_head(Some(git2::build::CheckoutBuilder::default().force()))?;
        return Ok(());
    }

    // Non-fast-forward: perform a real merge. Conflicts are surfaced, not
    // resolved here (no rebase/conflict UI in v1).
    // NB: repo.merge 第三参是 Option<&mut CheckoutBuilder>，对临时值取可变借用。
    repo.merge(&[&fetch_commit], None, Some(&mut git2::build::CheckoutBuilder::default()))?;
    if repo.index()?.has_conflicts() {
        return Err(NexError::Git("合并存在冲突，请手动解决".to_string()));
    }
    let tree_id = repo.index()?.write_tree()?;
    let tree = repo.find_tree(tree_id)?;
    let sig = repo.signature()?;
    let head_commit = repo.head()?.peel_to_commit()?;
    let remote_commit = repo.find_commit(fetch_commit.id())?;
    repo.commit(
        Some("HEAD"),
        &sig,
        &sig,
        &format!("Merge {remote_name}/{branch}"),
        &tree,
        &[&head_commit, &remote_commit],
    )?;
    Ok(())
}

/// 工作区是否存在未提交/未跟踪改动（pull 快进 force checkout 前防丢改，R1）
fn worktree_is_dirty(repo: &Repository) -> Result<bool, NexError> {
    let mut opts = git2::StatusOptions::new();
    opts.include_untracked(true);
    let statuses = repo.statuses(Some(&mut opts))?;
    Ok(statuses
        .iter()
        .any(|s| s.status() != git2::Status::CURRENT))
}

pub fn clone_repo(url: &str, dest: &Path, callbacks: RemoteCallbacks<'_>) -> Result<(), NexError> {
    let mut fo = git2::FetchOptions::new();
    fo.remote_callbacks(callbacks);
    let mut builder = git2::build::RepoBuilder::new();
    builder.fetch_options(fo);
    builder.clone(url, dest)?;
    Ok(())
}

/// First existing default SSH private key, if any (ed25519 → ecdsa → rsa).
pub fn default_ssh_private_key() -> Option<PathBuf> {
    let home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)?;
    let ssh = home.join(".ssh");
    ["id_ed25519", "id_ecdsa", "id_rsa"]
        .iter()
        .map(|name| ssh.join(name))
        .find(|p| p.is_file())
}

fn cred_from_cache(cached: &CachedCredential, username_hint: Option<&str>) -> Result<Cred, git2::Error> {
    match cached.kind.as_str() {
        "ssh-passphrase" => {
            let key_path = default_ssh_private_key()
                .ok_or_else(|| git2::Error::from_str("no default ssh private key found"))?;
            let user = username_hint.unwrap_or("git");
            Cred::ssh_key(user, None, &key_path, Some(&cached.secret))
        }
        _ => Cred::userpass_plaintext(&cached.username, &cached.secret),
    }
}

fn cred_from_answer(
    kind: &str,
    answer: &CredentialAnswer,
    username_hint: Option<&str>,
) -> Result<Cred, git2::Error> {
    match kind {
        "ssh-passphrase" => {
            let key_path = default_ssh_private_key()
                .ok_or_else(|| git2::Error::from_str("no default ssh private key found"))?;
            let user = answer
                .username
                .clone()
                .unwrap_or_else(|| username_hint.unwrap_or("git").to_string());
            Cred::ssh_key(&user, None, &key_path, answer.secret.as_deref())
        }
        _ => {
            let user = answer
                .username
                .clone()
                .unwrap_or_else(|| username_hint.unwrap_or("git").to_string());
            let pass = answer.secret.clone().unwrap_or_default();
            Cred::userpass_plaintext(&user, &pass)
        }
    }
}

/// Build the git2 remote callbacks whose credentials handler tries, in order:
/// ① session cache ("remember for this session"), ② git credential helper /
/// SSH agent / passphrase-less default key (first attempt only), ③ the GUI
/// prompt via the broker (blocks this spawn_blocking thread, ~5 min ceiling).
pub fn build_callbacks<'a>(app: &'a AppHandle, broker: &'a GitCredentialBroker) -> RemoteCallbacks<'a> {
    let mut cb = RemoteCallbacks::new();
    let mut attempts = 0u32;
    cb.credentials(move |url, username_hint, allowed| {
        attempts += 1;
        let kind = if allowed.contains(CredentialType::SSH_KEY) {
            "ssh-passphrase"
        } else {
            "https"
        };

        // ① Session cache — same host+kind never prompts twice.
        if let Some(cached) = broker.lookup_session(url, kind) {
            return cred_from_cache(&cached, username_hint);
        }

        // ② Non-interactive sources, first attempt only.
        if attempts == 1 {
            if allowed.contains(CredentialType::USER_PASS_PLAINTEXT) {
                if let Ok(cfg) = git2::Config::open_default() {
                    if let Ok(cred) = Cred::credential_helper(&cfg, url, username_hint) {
                        return Ok(cred);
                    }
                }
            }
            if allowed.contains(CredentialType::SSH_KEY) {
                let user = username_hint.unwrap_or("git");
                if let Ok(cred) = Cred::ssh_key_from_agent(user) {
                    return Ok(cred);
                }
                if let Some(key_path) = default_ssh_private_key() {
                    if let Ok(cred) = Cred::ssh_key(user, None, &key_path, None) {
                        return Ok(cred);
                    }
                }
            }
        }

        // ③ GUI prompt.
        let answer = broker
            .request_gui(app, url, username_hint, kind)
            .map_err(|e| git2::Error::from_str(&e.to_string()))?;
        match answer {
            Some(a) => cred_from_answer(kind, &a, username_hint),
            None => Err(git2::Error::from_str("authentication cancelled by user")),
        }
    });
    cb
}
```

- [ ] **Step 4: 导出模块** — 将 `src-tauri/src/git/mod.rs` 改为：

```rust
pub mod credentials;
pub mod network;
pub mod repository;
pub mod types;
```

- [ ] **Step 5: 跑出绿** — `cargo test --manifest-path src-tauri/Cargo.toml --test git_test` 全过（含本地远端 push/pull/fetch/clone 两个新用例）。

- [ ] **Step 6: 异步 command** — 在 `src-tauri/src/commands/git_cmds.rs` 顶部 `use` 区追加：

```rust
use crate::git::network;
use std::path::PathBuf;
use tauri::AppHandle;
```

（`State` 已在 T4 引入；`tokio` 经全路径调用，无需 use。）并在文件末尾追加：

```rust
#[tauri::command]
pub async fn git_fetch(
    app: AppHandle,
    broker: State<'_, GitCredentialBroker>,
    project_path: String,
    remote: String,
) -> Result<(), NexError> {
    let broker = broker.inner().clone();
    let path = PathBuf::from(project_path);
    tokio::task::spawn_blocking(move || {
        let cb = network::build_callbacks(&app, &broker);
        network::fetch_remote(&path, &remote, cb)
    })
    .await
    .map_err(|e| NexError::Internal(format!("task join failed: {e}")))?
}

#[tauri::command]
pub async fn git_pull(
    app: AppHandle,
    broker: State<'_, GitCredentialBroker>,
    project_path: String,
    remote: String,
) -> Result<(), NexError> {
    let broker = broker.inner().clone();
    let path = PathBuf::from(project_path);
    tokio::task::spawn_blocking(move || {
        let cb = network::build_callbacks(&app, &broker);
        network::pull_remote(&path, &remote, cb)
    })
    .await
    .map_err(|e| NexError::Internal(format!("task join failed: {e}")))?
}

#[tauri::command]
pub async fn git_push(
    app: AppHandle,
    broker: State<'_, GitCredentialBroker>,
    project_path: String,
    remote: String,
    branch: String,
) -> Result<(), NexError> {
    let broker = broker.inner().clone();
    let path = PathBuf::from(project_path);
    tokio::task::spawn_blocking(move || {
        let cb = network::build_callbacks(&app, &broker);
        network::push_remote(&path, &remote, &branch, cb)
    })
    .await
    .map_err(|e| NexError::Internal(format!("task join failed: {e}")))?
}

#[tauri::command]
pub async fn git_clone(
    app: AppHandle,
    broker: State<'_, GitCredentialBroker>,
    url: String,
    dest: String,
) -> Result<(), NexError> {
    let broker = broker.inner().clone();
    let dest = PathBuf::from(dest);
    tokio::task::spawn_blocking(move || {
        let cb = network::build_callbacks(&app, &broker);
        network::clone_repo(&url, &dest, cb)
    })
    .await
    .map_err(|e| NexError::Internal(format!("task join failed: {e}")))?
}
```

- [ ] **Step 7: 注册 invoke_handler** — 在 lib.rs 的 `git_credential_respond,` 行之后插入：

```rust
            commands::git_cmds::git_fetch,
            commands::git_cmds::git_pull,
            commands::git_cmds::git_push,
            commands::git_cmds::git_clone,
```

- [ ] **Step 8: 门槛 + 提交** — `cargo test --manifest-path src-tauri/Cargo.toml` 全绿后：

```
git add src-tauri/src/git/network.rs src-tauri/src/git/mod.rs src-tauri/src/commands/git_cmds.rs src-tauri/src/lib.rs src-tauri/tests/git_test.rs
git commit -m "feat(git): fetch/pull/push/clone 网络操作与凭据回调"
```

---

### Task 6: 桥接层（commands.ts 常量 + tauri.ts 封装 + events.ts 凭据事件 + 类型）

**Files:**
- Modify: `src/bridge/commands.ts`、`src/bridge/events.ts`、`src/bridge/tauri.ts`

**Interfaces:**
- Consumes: T1–T5 注册的 16 个 command（名称逐字：`git_list_branches`/`git_checkout`/`git_create_branch`/`git_delete_branch`/`git_discard`/`git_revert_staged`/`git_stash_save`/`git_stash_list`/`git_stash_apply`/`git_stash_pop`/`git_stash_drop`/`git_fetch`/`git_pull`/`git_push`/`git_clone`/`git_credential_respond`）+ 既有 `git_log`（commands.ts:30 已声明、从未消费，本任务补封装）+ 事件 `git-credential-request`（T4 常量）。
- Produces:
  - `commands.ts` Git 段新增常量：`GIT_LIST_BRANCHES/GIT_CHECKOUT/GIT_CREATE_BRANCH/GIT_DELETE_BRANCH/GIT_DISCARD/GIT_REVERT_STAGED/GIT_STASH_SAVE/GIT_STASH_LIST/GIT_STASH_APPLY/GIT_STASH_POP/GIT_STASH_DROP/GIT_FETCH/GIT_PULL/GIT_PUSH/GIT_CLONE/GIT_CREDENTIAL_RESPOND`。
  - `events.ts`：`GIT_CREDENTIAL_REQUEST: "git-credential-request"` + `export interface GitCredentialRequestPayload { requestId: string; url: string; usernameHint: string | null; kind: "https" | "ssh-passphrase"; }`（与 Rust 侧 camelCase payload 逐字对齐）。
  - `tauri.ts`：
    - `export interface BranchInfo { name: string; isHead: boolean; isRemote: boolean; ahead: number | null; behind: number | null; }`（`Option<u32>` 序列化为 `number | null`）
    - `export interface StashEntry { index: number; message: string; }`
    - `export interface CommitInfo { hash: string; message: string; author: string; time: number; }`
    - 封装函数（参数一律 camelCase，与 Rust 自动转换对应）：`gitListBranches(projectPath): Promise<BranchInfo[]>`、`gitCheckout(projectPath, name): Promise<void>`、`gitCreateBranch(projectPath, name): Promise<void>`、`gitDeleteBranch(projectPath, name): Promise<void>`、`gitDiscard(projectPath, files: string[]): Promise<void>`、`gitRevertStaged(projectPath, files: string[]): Promise<void>`、`gitStashSave(projectPath, message: string): Promise<void>`、`gitStashList(projectPath): Promise<StashEntry[]>`、`gitStashApply(projectPath, index: number): Promise<void>`、`gitStashPop(projectPath, index: number): Promise<void>`、`gitStashDrop(projectPath, index: number): Promise<void>`、`gitFetch(projectPath, remote: string): Promise<void>`、`gitPull(projectPath, remote: string): Promise<void>`、`gitPush(projectPath, remote: string, branch: string): Promise<void>`、`gitClone(url: string, dest: string): Promise<void>`、`gitCredentialRespond(requestId: string, username: string | null, password: string | null, remember: boolean): Promise<void>`、`gitLog(projectPath: string, limit: number): Promise<CommitInfo[]>`
    - 事件封装：`onGitCredentialRequest(cb: (payload: GitCredentialRequestPayload) => void): Promise<UnlistenFn>`。
- 本任务无独立测试（薄封装，类型正确性由 `pnpm build` 把关；行为在 T7 store 测试中经 mock 覆盖）。

- [ ] **Step 1: commands.ts 常量** — 在 `src/bridge/commands.ts` 的 `GIT_COMMIT: "git_commit",`（L33）之后插入：

```ts
  GIT_LIST_BRANCHES: "git_list_branches",
  GIT_CHECKOUT: "git_checkout",
  GIT_CREATE_BRANCH: "git_create_branch",
  GIT_DELETE_BRANCH: "git_delete_branch",
  GIT_DISCARD: "git_discard",
  GIT_REVERT_STAGED: "git_revert_staged",
  GIT_STASH_SAVE: "git_stash_save",
  GIT_STASH_LIST: "git_stash_list",
  GIT_STASH_APPLY: "git_stash_apply",
  GIT_STASH_POP: "git_stash_pop",
  GIT_STASH_DROP: "git_stash_drop",
  GIT_FETCH: "git_fetch",
  GIT_PULL: "git_pull",
  GIT_PUSH: "git_push",
  GIT_CLONE: "git_clone",
  GIT_CREDENTIAL_RESPOND: "git_credential_respond",
```

- [ ] **Step 2: events.ts 事件与 payload** — 在 `src/bridge/events.ts` 的 `FS_CHANGED: "fs-changed",`（L9）之后插入：

```ts
  GIT_CREDENTIAL_REQUEST: "git-credential-request",
```

并在 `GitStatusChangedPayload` 接口（L24-26）之后追加：

```ts
export interface GitCredentialRequestPayload {
  requestId: string;
  url: string;
  usernameHint: string | null;
  kind: "https" | "ssh-passphrase";
}
```

- [ ] **Step 3: tauri.ts 类型与封装** — 在 `src/bridge/tauri.ts`：
  1. 顶部 `import { EVENTS, ... }` 语句（L4）的导入列表末尾追加 `, type GitCredentialRequestPayload`；
  2. 在 `gitCommit` 封装（L235-237）之后、`// --- Terminal ---` 之前插入：

```ts
export interface BranchInfo {
  name: string;
  isHead: boolean;
  isRemote: boolean;
  ahead: number | null;
  behind: number | null;
}

export interface StashEntry {
  index: number;
  message: string;
}

export interface CommitInfo {
  hash: string;
  message: string;
  author: string;
  time: number;
}

export async function gitLog(projectPath: string, limit: number): Promise<CommitInfo[]> {
  return invoke(COMMANDS.GIT_LOG, { projectPath, limit });
}

export async function gitListBranches(projectPath: string): Promise<BranchInfo[]> {
  return invoke(COMMANDS.GIT_LIST_BRANCHES, { projectPath });
}

export async function gitCheckout(projectPath: string, name: string): Promise<void> {
  return invoke(COMMANDS.GIT_CHECKOUT, { projectPath, name });
}

export async function gitCreateBranch(projectPath: string, name: string): Promise<void> {
  return invoke(COMMANDS.GIT_CREATE_BRANCH, { projectPath, name });
}

export async function gitDeleteBranch(projectPath: string, name: string): Promise<void> {
  return invoke(COMMANDS.GIT_DELETE_BRANCH, { projectPath, name });
}

export async function gitDiscard(projectPath: string, files: string[]): Promise<void> {
  return invoke(COMMANDS.GIT_DISCARD, { projectPath, files });
}

export async function gitRevertStaged(projectPath: string, files: string[]): Promise<void> {
  return invoke(COMMANDS.GIT_REVERT_STAGED, { projectPath, files });
}

export async function gitStashSave(projectPath: string, message: string): Promise<void> {
  return invoke(COMMANDS.GIT_STASH_SAVE, { projectPath, message });
}

export async function gitStashList(projectPath: string): Promise<StashEntry[]> {
  return invoke(COMMANDS.GIT_STASH_LIST, { projectPath });
}

export async function gitStashApply(projectPath: string, index: number): Promise<void> {
  return invoke(COMMANDS.GIT_STASH_APPLY, { projectPath, index });
}

export async function gitStashPop(projectPath: string, index: number): Promise<void> {
  return invoke(COMMANDS.GIT_STASH_POP, { projectPath, index });
}

export async function gitStashDrop(projectPath: string, index: number): Promise<void> {
  return invoke(COMMANDS.GIT_STASH_DROP, { projectPath, index });
}

export async function gitFetch(projectPath: string, remote: string): Promise<void> {
  return invoke(COMMANDS.GIT_FETCH, { projectPath, remote });
}

export async function gitPull(projectPath: string, remote: string): Promise<void> {
  return invoke(COMMANDS.GIT_PULL, { projectPath, remote });
}

export async function gitPush(projectPath: string, remote: string, branch: string): Promise<void> {
  return invoke(COMMANDS.GIT_PUSH, { projectPath, remote, branch });
}

export async function gitClone(url: string, dest: string): Promise<void> {
  return invoke(COMMANDS.GIT_CLONE, { url, dest });
}

export async function gitCredentialRespond(
  requestId: string,
  username: string | null,
  password: string | null,
  remember: boolean,
): Promise<void> {
  return invoke(COMMANDS.GIT_CREDENTIAL_RESPOND, { requestId, username, password, remember });
}
```

  3. 在 `onGitStatusChanged`（L332-334）之后追加：

```ts
export function onGitCredentialRequest(cb: (payload: GitCredentialRequestPayload) => void): Promise<UnlistenFn> {
  return listen(EVENTS.GIT_CREDENTIAL_REQUEST, (e) => cb(e.payload as GitCredentialRequestPayload));
}
```

- [ ] **Step 4: 门槛** — `pnpm lint && pnpm build && pnpm test` 全绿（本任务不改行为，既有测试应不受影响；`pnpm build` 验证四处命名逐字一致，任何拼写偏差会在 T7 之前被类型门槛拦下——此刻尚无消费方，build 只验自身一致性）。

- [ ] **Step 5: 提交** —

```
git add src/bridge/commands.ts src/bridge/events.ts src/bridge/tauri.ts
git commit -m "feat(git): 桥接层补齐 16 个命令封装与凭据事件"
```

---
### Task 7: git.store 扩展（loading 拆分 / opLog / 新状态与动作）+ store 测试

**Files:**
- Modify: `src/stores/git.store.ts`、`src/features/git/GitPanel.tsx`（调用点迁移）
- Create: `src/stores/git.store.test.ts`

**Interfaces:**
- Consumes: T6 全部桥接封装与类型。
- Produces（`git.store.ts` 全量重写后的契约，后续任务逐字引用）：
  - 状态：`status: GitStatus | null`、`diff: string | null`、`diffFile: string | null`、`branches: BranchInfo[]`、`commits: CommitInfo[]`、`stashes: StashEntry[]`、`statusLoading: boolean`、`branchesLoading: boolean`、`historyLoading: boolean`、`stashesLoading: boolean`、`opRunning: string | null`（进行中操作名，如「推送」「拉取」「获取」「克隆」「签出」「存储」「丢弃更改」）、`opLog: string[]`（上限 100 条，格式 `HH:mm:ss 操作：完成` / `HH:mm:ss 操作：失败 — 消息`）、`error: string | null`、`commitMessage: string`、`treeView: boolean`、`historyOpen: boolean`、`opLogOpen: boolean`。
  - 动作：`refresh(projectPath)`/`viewDiff(projectPath, file, staged)`/`stage(projectPath, files)`/`unstage(projectPath, files)` 沿用 `statusLoading`；`commit(projectPath, message): Promise<boolean>`（经 `runOp("提交")`，opRunning 门控）；`setCommitMessage(m)`；`commitWith(projectPath, mode: "commit" | "push" | "sync"): Promise<void>`（空消息直接返回；成功后清空 commitMessage；push→`push()`；sync→`pull()` 成功后 `push()`；末尾 `refresh`）；`loadBranches(projectPath)`（branchesLoading）；`checkout(projectPath, name): Promise<boolean>`（成功后 refresh + loadBranches）；`createBranch(projectPath, name): Promise<boolean>`（成功后 loadBranches）；`deleteBranch(projectPath, name): Promise<boolean>`（成功后 loadBranches）；`fetch(projectPath, remote = "origin")`（完成后 refresh）；`pull(projectPath, remote = "origin"): Promise<boolean>`（成功后 refresh）；`push(projectPath, remote = "origin"): Promise<boolean>`（branch 取自 `status?.branch`，为空或 `"HEAD"` 时设中文错误「无法确定当前分支名，不能推送」并返回 false）；`clone(url, dest): Promise<boolean>`；`loadStashes(projectPath)`（stashesLoading）；`stashSave(projectPath)`/`stashApply(projectPath, index)`/`stashPop(projectPath, index)`/`stashDrop(projectPath, index)`（成功后 refresh 及/或 loadStashes）；`discard(projectPath, files): Promise<boolean>`/`revertStaged(projectPath, files): Promise<boolean>`（成功后 refresh）；`loadHistory(projectPath)`（historyLoading，`gitLog(projectPath, 20)`）；`openCommitDiff(projectPath, commitHash, path?)`（**Plan 4 预留接口**：Plan 4 将以 `git_diff_commit` + `fs.store.diffTabs` 实现编辑器 diff 标签；本任务占位实现＝调 `viewDiff(projectPath, path ?? "", false)`）；`appendLog(line)`/`clearLog()`/`setTreeView(v)`/`setHistoryOpen(v)`/`setOpLogOpen(v)`。
  - `GitPanel.tsx` 迁移：L9 解构中的 `loading` 删除，改为 `statusLoading, opRunning`；L58/L74 两处 `disabled={loading}` 改为 `disabled={statusLoading || !!opRunning}`；**L101 实为 `disabled={loading || !commitMsg.trim()}`**，改为 `disabled={statusLoading || !!opRunning || !commitMsg.trim()}`（保留 commitMsg 门控）；L21-26 `handleCommit` 改为 `const ok = await commit(project.path, commitMsg); if (ok) { setCommitMsg(""); refresh(project.path); }`（commit 现返回 boolean）。
- 内部助手（模块私有）：`timeStamp(): string`、`pushOpLog(set, op, failure?)`（超 100 条从头裁剪）、`runOp(set, name, fn): Promise<boolean>`（设 opRunning/error → 执行 → 记 opLog → finally 清 opRunning）。

- [ ] **Step 1: 先写失败测试** — 新建 `src/stores/git.store.test.ts`（node 环境即可，无 DOM；无需 docblock）：

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const gitStatusMock = vi.fn();
const gitDiffMock = vi.fn();
const gitStageMock = vi.fn();
const gitUnstageMock = vi.fn();
const gitCommitMock = vi.fn();
const gitLogMock = vi.fn();
const gitListBranchesMock = vi.fn();
const gitCheckoutMock = vi.fn();
const gitCreateBranchMock = vi.fn();
const gitDeleteBranchMock = vi.fn();
const gitDiscardMock = vi.fn();
const gitRevertStagedMock = vi.fn();
const gitStashSaveMock = vi.fn();
const gitStashListMock = vi.fn();
const gitStashApplyMock = vi.fn();
const gitStashPopMock = vi.fn();
const gitStashDropMock = vi.fn();
const gitFetchMock = vi.fn();
const gitPullMock = vi.fn();
const gitPushMock = vi.fn();
const gitCloneMock = vi.fn();

vi.mock("../bridge/tauri", () => ({
  gitStatus: (...a: unknown[]) => gitStatusMock(...a),
  gitDiff: (...a: unknown[]) => gitDiffMock(...a),
  gitStage: (...a: unknown[]) => gitStageMock(...a),
  gitUnstage: (...a: unknown[]) => gitUnstageMock(...a),
  gitCommit: (...a: unknown[]) => gitCommitMock(...a),
  gitLog: (...a: unknown[]) => gitLogMock(...a),
  gitListBranches: (...a: unknown[]) => gitListBranchesMock(...a),
  gitCheckout: (...a: unknown[]) => gitCheckoutMock(...a),
  gitCreateBranch: (...a: unknown[]) => gitCreateBranchMock(...a),
  gitDeleteBranch: (...a: unknown[]) => gitDeleteBranchMock(...a),
  gitDiscard: (...a: unknown[]) => gitDiscardMock(...a),
  gitRevertStaged: (...a: unknown[]) => gitRevertStagedMock(...a),
  gitStashSave: (...a: unknown[]) => gitStashSaveMock(...a),
  gitStashList: (...a: unknown[]) => gitStashListMock(...a),
  gitStashApply: (...a: unknown[]) => gitStashApplyMock(...a),
  gitStashPop: (...a: unknown[]) => gitStashPopMock(...a),
  gitStashDrop: (...a: unknown[]) => gitStashDropMock(...a),
  gitFetch: (...a: unknown[]) => gitFetchMock(...a),
  gitPull: (...a: unknown[]) => gitPullMock(...a),
  gitPush: (...a: unknown[]) => gitPushMock(...a),
  gitClone: (...a: unknown[]) => gitCloneMock(...a),
}));

import { useGitStore } from "./git.store";

beforeEach(() => {
  vi.clearAllMocks();
  useGitStore.setState({
    status: null,
    diff: null,
    diffFile: null,
    branches: [],
    commits: [],
    stashes: [],
    statusLoading: false,
    branchesLoading: false,
    historyLoading: false,
    stashesLoading: false,
    opRunning: null,
    opLog: [],
    error: null,
    commitMessage: "",
    treeView: false,
    historyOpen: false,
    opLogOpen: false,
  });
});

const STATUS = { branch: "main", ahead: 0, behind: 0, files: [] };

describe("git.store loading granularity", () => {
  it("refresh toggles statusLoading only", async () => {
    gitStatusMock.mockResolvedValue(STATUS);
    const p = useGitStore.getState().refresh("/p");
    expect(useGitStore.getState().statusLoading).toBe(true);
    await p;
    const s = useGitStore.getState();
    expect(s.statusLoading).toBe(false);
    expect(s.branchesLoading).toBe(false);
    expect(s.status?.branch).toBe("main");
  });

  it("loadBranches toggles branchesLoading only", async () => {
    gitListBranchesMock.mockResolvedValue([]);
    const p = useGitStore.getState().loadBranches("/p");
    expect(useGitStore.getState().branchesLoading).toBe(true);
    await p;
    expect(useGitStore.getState().branchesLoading).toBe(false);
    expect(useGitStore.getState().statusLoading).toBe(false);
  });
});

describe("git.store opLog", () => {
  it("fetch success appends a completion line and clears opRunning", async () => {
    gitFetchMock.mockResolvedValue(undefined);
    gitStatusMock.mockResolvedValue(STATUS);
    await useGitStore.getState().fetch("/p");
    const s = useGitStore.getState();
    expect(s.opRunning).toBeNull();
    expect(s.opLog.some((l) => l.includes("获取") && l.includes("完成"))).toBe(true);
  });

  it("fetch failure records the backend message and still clears opRunning", async () => {
    gitFetchMock.mockRejectedValue({ type: "Git", message: "推送被拒绝：非快进，请先拉取合并" });
    gitStatusMock.mockResolvedValue(STATUS);
    await useGitStore.getState().fetch("/p");
    const s = useGitStore.getState();
    expect(s.error).toBe("推送被拒绝：非快进，请先拉取合并");
    expect(s.opRunning).toBeNull();
    expect(s.opLog.some((l) => l.includes("获取") && l.includes("失败"))).toBe(true);
  });

  it("opLog trims to 100 entries (ring buffer)", () => {
    for (let i = 0; i < 105; i++) useGitStore.getState().appendLog(`line ${i}`);
    const log = useGitStore.getState().opLog;
    expect(log).toHaveLength(100);
    expect(log[log.length - 1]).toContain("line 104");
    expect(log[0]).toContain("line 5");
  });
});

describe("git.store commitWith", () => {
  it("push mode commits then pushes on the current branch", async () => {
    gitCommitMock.mockResolvedValue("oid");
    gitPushMock.mockResolvedValue(undefined);
    gitStatusMock.mockResolvedValue(STATUS);
    useGitStore.setState({ commitMessage: "hello", status: STATUS });
    await useGitStore.getState().commitWith("/p", "push");
    expect(gitCommitMock).toHaveBeenCalledWith("/p", "hello");
    expect(gitPushMock).toHaveBeenCalledWith("/p", "origin", "main");
    expect(useGitStore.getState().commitMessage).toBe("");
  });

  it("empty message is a no-op", async () => {
    useGitStore.setState({ commitMessage: "   " });
    await useGitStore.getState().commitWith("/p", "commit");
    expect(gitCommitMock).not.toHaveBeenCalled();
  });

  it("failed commit does not clear the message nor push", async () => {
    gitCommitMock.mockRejectedValue({ type: "Git", message: "nothing to commit" });
    useGitStore.setState({ commitMessage: "hello", status: STATUS });
    await useGitStore.getState().commitWith("/p", "push");
    expect(useGitStore.getState().commitMessage).toBe("hello");
    expect(gitPushMock).not.toHaveBeenCalled();
  });
});

describe("git.store push guard", () => {
  it("push without a known branch sets a Chinese error and skips the backend", async () => {
    const ok = await useGitStore.getState().push("/p");
    expect(ok).toBe(false);
    expect(gitPushMock).not.toHaveBeenCalled();
    expect(useGitStore.getState().error).toBe("无法确定当前分支名，不能推送");
  });

  it("discard with an empty file list skips the backend entirely", async () => {
    const ok = await useGitStore.getState().discard("/p", []);
    expect(ok).toBe(false);
    expect(gitDiscardMock).not.toHaveBeenCalled();
  });

  it("revertStaged with an empty file list skips the backend entirely", async () => {
    const ok = await useGitStore.getState().revertStaged("/p", []);
    expect(ok).toBe(false);
    expect(gitRevertStagedMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 跑出红** — `pnpm test src/stores/git.store.test.ts` 失败（新状态/动作不存在，类型报错或断言失败）。

- [ ] **Step 3: 最小实现** — 将 `src/stores/git.store.ts` 全量替换为：

```ts
import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import {
  gitStatus, gitDiff, gitStage, gitUnstage, gitCommit, gitLog,
  gitListBranches, gitCheckout, gitCreateBranch, gitDeleteBranch,
  gitDiscard, gitRevertStaged,
  gitStashSave, gitStashList, gitStashApply, gitStashPop, gitStashDrop,
  gitFetch, gitPull, gitPush, gitClone,
  type GitStatus, type BranchInfo, type CommitInfo, type StashEntry,
} from "../bridge/tauri";

const OP_LOG_MAX = 100;

function timeStamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

interface GitStore {
  status: GitStatus | null;
  diff: string | null;
  diffFile: string | null;
  branches: BranchInfo[];
  commits: CommitInfo[];
  stashes: StashEntry[];
  statusLoading: boolean;
  branchesLoading: boolean;
  historyLoading: boolean;
  stashesLoading: boolean;
  opRunning: string | null;
  opLog: string[];
  error: string | null;
  commitMessage: string;
  treeView: boolean;
  historyOpen: boolean;
  opLogOpen: boolean;

  refresh: (projectPath: string) => Promise<void>;
  viewDiff: (projectPath: string, file: string, staged: boolean) => Promise<void>;
  stage: (projectPath: string, files: string[]) => Promise<void>;
  unstage: (projectPath: string, files: string[]) => Promise<void>;
  commit: (projectPath: string, message: string) => Promise<boolean>;
  setCommitMessage: (message: string) => void;
  commitWith: (projectPath: string, mode: "commit" | "push" | "sync") => Promise<void>;
  loadBranches: (projectPath: string) => Promise<void>;
  checkout: (projectPath: string, name: string) => Promise<boolean>;
  createBranch: (projectPath: string, name: string) => Promise<boolean>;
  deleteBranch: (projectPath: string, name: string) => Promise<boolean>;
  fetch: (projectPath: string, remote?: string) => Promise<void>;
  pull: (projectPath: string, remote?: string) => Promise<boolean>;
  push: (projectPath: string, remote?: string) => Promise<boolean>;
  clone: (url: string, dest: string) => Promise<boolean>;
  loadStashes: (projectPath: string) => Promise<void>;
  stashSave: (projectPath: string) => Promise<boolean>;
  stashApply: (projectPath: string, index: number) => Promise<boolean>;
  stashPop: (projectPath: string, index: number) => Promise<boolean>;
  stashDrop: (projectPath: string, index: number) => Promise<boolean>;
  discard: (projectPath: string, files: string[]) => Promise<boolean>;
  revertStaged: (projectPath: string, files: string[]) => Promise<boolean>;
  loadHistory: (projectPath: string) => Promise<void>;
  openCommitDiff: (projectPath: string, commitHash: string, path?: string) => void;
  appendLog: (line: string) => void;
  clearLog: () => void;
  setTreeView: (v: boolean) => void;
  setHistoryOpen: (v: boolean) => void;
  setOpLogOpen: (v: boolean) => void;
}

// Backend errors arrive as { type, message }; fall back to String(err).
function errorMessage(err: unknown): string {
  if (err && typeof err === "object" && "message" in err && typeof (err as { message: unknown }).message === "string") {
    return (err as { message: string }).message;
  }
  return String(err);
}

export const useGitStore = create<GitStore>()(
  immer((set, get) => {
    // Append one op-log line; trim from the front beyond OP_LOG_MAX.
    const logOp = (op: string, failure?: string) =>
      set((s) => {
        s.opLog.push(failure ? `${timeStamp()} ${op}：失败 — ${failure}` : `${timeStamp()} ${op}：完成`);
        if (s.opLog.length > OP_LOG_MAX) s.opLog.splice(0, s.opLog.length - OP_LOG_MAX);
      });

    // Shared bookkeeping for network/destructive ops: opRunning + error +
    // opLog. Returns false on failure so callers can chain conditionally.
    const runOp = async (name: string, fn: () => Promise<void>): Promise<boolean> => {
      set((s) => { s.opRunning = name; s.error = null; });
      try {
        await fn();
        logOp(name);
        return true;
      } catch (err) {
        const msg = errorMessage(err);
        set((s) => { s.error = msg; });
        logOp(name, msg);
        return false;
      } finally {
        set((s) => { s.opRunning = null; });
      }
    };

    // Status-scope load: statusLoading flag, shared error slot.
    const loadStatus = async (fn: () => Promise<void>) => {
      set((s) => { s.statusLoading = true; s.error = null; });
      try {
        await fn();
      } catch (err) {
        set((s) => { s.error = errorMessage(err); });
      } finally {
        set((s) => { s.statusLoading = false; });
      }
    };

    return {
      status: null,
      diff: null,
      diffFile: null,
      branches: [],
      commits: [],
      stashes: [],
      statusLoading: false,
      branchesLoading: false,
      historyLoading: false,
      stashesLoading: false,
      opRunning: null,
      opLog: [],
      error: null,
      commitMessage: "",
      treeView: false,
      historyOpen: false,
      opLogOpen: false,

      refresh: async (projectPath) =>
        loadStatus(async () => {
          const status = await gitStatus(projectPath);
          set((s) => { s.status = status; });
        }),

      viewDiff: async (projectPath, file, staged) =>
        loadStatus(async () => {
          const diff = await gitDiff(projectPath, file, staged);
          set((s) => { s.diff = diff; s.diffFile = file; });
        }),

      stage: async (projectPath, files) =>
        loadStatus(async () => {
          await gitStage(projectPath, files);
        }),

      unstage: async (projectPath, files) =>
        loadStatus(async () => {
          await gitUnstage(projectPath, files);
        }),

      commit: (projectPath, message) => runOp("提交", () => gitCommit(projectPath, message).then(() => undefined)),

      setCommitMessage: (message) => set((s) => { s.commitMessage = message; }),

      commitWith: async (projectPath, mode) => {
        const msg = get().commitMessage.trim();
        if (!msg || get().opRunning) return;
        const ok = await get().commit(projectPath, msg);
        if (!ok) return;
        set((s) => { s.commitMessage = ""; });
        if (mode === "push") {
          await get().push(projectPath);
        } else if (mode === "sync") {
          const pulled = await get().pull(projectPath);
          if (pulled) await get().push(projectPath);
        }
        await get().refresh(projectPath);
      },

      loadBranches: async (projectPath) => {
        set((s) => { s.branchesLoading = true; });
        try {
          const branches = await gitListBranches(projectPath);
          set((s) => { s.branches = branches; });
        } catch (err) {
          set((s) => { s.error = errorMessage(err); });
        } finally {
          set((s) => { s.branchesLoading = false; });
        }
      },

      checkout: async (projectPath, name) => {
        const ok = await runOp("签出", () => gitCheckout(projectPath, name));
        if (ok) {
          await get().refresh(projectPath);
          await get().loadBranches(projectPath);
        }
        return ok;
      },

      createBranch: async (projectPath, name) => {
        const ok = await runOp("新建分支", () => gitCreateBranch(projectPath, name));
        if (ok) await get().loadBranches(projectPath);
        return ok;
      },

      deleteBranch: async (projectPath, name) => {
        const ok = await runOp("删除分支", () => gitDeleteBranch(projectPath, name));
        if (ok) await get().loadBranches(projectPath);
        return ok;
      },

      fetch: async (projectPath, remote = "origin") => {
        await runOp("获取", () => gitFetch(projectPath, remote));
        await get().refresh(projectPath);
      },

      pull: async (projectPath, remote = "origin") => {
        const ok = await runOp("拉取", () => gitPull(projectPath, remote));
        if (ok) await get().refresh(projectPath);
        return ok;
      },

      push: async (projectPath, remote = "origin") => {
        const branch = get().status?.branch;
        if (!branch || branch === "HEAD") {
          set((s) => { s.error = "无法确定当前分支名，不能推送"; });
          return false;
        }
        const ok = await runOp("推送", () => gitPush(projectPath, remote, branch));
        if (ok) await get().refresh(projectPath);
        return ok;
      },

      clone: (url, dest) => runOp("克隆", () => gitClone(url, dest)),

      loadStashes: async (projectPath) => {
        set((s) => { s.stashesLoading = true; });
        try {
          const stashes = await gitStashList(projectPath);
          set((s) => { s.stashes = stashes; });
        } catch (err) {
          set((s) => { s.error = errorMessage(err); });
        } finally {
          set((s) => { s.stashesLoading = false; });
        }
      },

      stashSave: async (projectPath) => {
        const ok = await runOp("存储", () => gitStashSave(projectPath, ""));
        if (ok) {
          await get().refresh(projectPath);
          await get().loadStashes(projectPath);
        }
        return ok;
      },

      stashApply: async (projectPath, index) => {
        const ok = await runOp("应用存储", () => gitStashApply(projectPath, index));
        if (ok) await get().refresh(projectPath);
        return ok;
      },

      stashPop: async (projectPath, index) => {
        const ok = await runOp("弹出存储", () => gitStashPop(projectPath, index));
        if (ok) {
          await get().refresh(projectPath);
          await get().loadStashes(projectPath);
        }
        return ok;
      },

      stashDrop: async (projectPath, index) => {
        const ok = await runOp("删除存储", () => gitStashDrop(projectPath, index));
        if (ok) await get().loadStashes(projectPath);
        return ok;
      },

      discard: async (projectPath, files) => {
        if (files.length === 0) return false; // 后端 checkout_index 空 paths = 全仓库，严禁下传空数组
        const ok = await runOp("丢弃更改", () => gitDiscard(projectPath, files));
        if (ok) await get().refresh(projectPath);
        return ok;
      },

      revertStaged: async (projectPath, files) => {
        if (files.length === 0) return false; // 后端 reset_default 空 paths = 全仓库，严禁下传空数组
        const ok = await runOp("撤销暂存更改", () => gitRevertStaged(projectPath, files));
        if (ok) await get().refresh(projectPath);
        return ok;
      },

      loadHistory: async (projectPath) => {
        set((s) => { s.historyLoading = true; });
        try {
          const commits = await gitLog(projectPath, 20);
          set((s) => { s.commits = commits; });
        } catch (err) {
          set((s) => { s.error = errorMessage(err); });
        } finally {
          set((s) => { s.historyLoading = false; });
        }
      },

      openCommitDiff: (projectPath, _commitHash, path) => {
        // Plan 4 replaces this with a real read-only diff tab in the editor
        // panel (fs.store.diffTabs + git_diff_commit). Until then, reuse the
        // existing inline diff slot so the click is not dead.
        void get().viewDiff(projectPath, path ?? "", false);
      },

      appendLog: (line) =>
        set((s) => {
          s.opLog.push(`${timeStamp()} ${line}`);
          if (s.opLog.length > OP_LOG_MAX) s.opLog.splice(0, s.opLog.length - OP_LOG_MAX);
        }),

      clearLog: () => set((s) => { s.opLog = []; }),
      setTreeView: (v) => set((s) => { s.treeView = v; }),
      setHistoryOpen: (v) => set((s) => { s.historyOpen = v; }),
      setOpLogOpen: (v) => set((s) => { s.opLogOpen = v; }),
    };
  })
);
```

- [ ] **Step 4: 跑出绿** — `pnpm test src/stores/git.store.test.ts` 全过。

- [ ] **Step 5: 迁移 GitPanel 调用点** — 修改 `src/features/git/GitPanel.tsx`：
  1. L9 解构改为：`const { status, diff, diffFile, statusLoading, opRunning, error, refresh, viewDiff, stage, unstage, commit } = useGitStore();`
  2. L21-26 `handleCommit` 改为：

```tsx
  const handleCommit = async () => {
    if (!commitMsg.trim()) return;
    const ok = await commit(project.path, commitMsg);
    if (ok) {
      setCommitMsg("");
      refresh(project.path);
    }
  };
```

  3. L58/L74 两处 `disabled={loading}` 改为 `disabled={statusLoading || !!opRunning}`；L101 实为 `disabled={loading || !commitMsg.trim()}`，改为 `disabled={statusLoading || !!opRunning || !commitMsg.trim()}`（保留 commitMsg 门控，勿丢）。

- [ ] **Step 6: 门槛** — `pnpm lint && pnpm build && pnpm test` 全绿（lint warning 数保持 6，不得新增 error）。

- [ ] **Step 7: 提交** —

```
git add src/stores/git.store.ts src/stores/git.store.test.ts src/features/git/GitPanel.tsx
git commit -m "feat(git): store 拆分 loading 粒度并新增操作日志与全部动作"
```

---

### Task 8: GitCredentialModal + 凭据小 store + 根挂载（jsdom 测试）

**Files:**
- Create: `src/features/git/credentialRequest.store.ts`、`src/features/git/GitCredentialModal.tsx`、`src/features/git/GitCredentialModal.test.tsx`
- Modify: `src/App.tsx`

**Interfaces:**
- Consumes: T6 的 `onGitCredentialRequest`/`gitCredentialRespond`/`GitCredentialRequestPayload`；T7 的 `useGitStore.getState().appendLog`；既有 `ui/dialog`、`ui/input`、`ui/label`、`ui/button`。
- Produces:
  - `credentialRequest.store.ts`：`useGitCredentialStore`，状态 `queue: GitCredentialRequestPayload[]`，动作 `pushRequest(req)`、`removeRequest(requestId)`（普通 zustand，无 immer 需要）。
  - `GitCredentialModal.tsx`：`export function GitCredentialModal()`——useEffect 内 `onGitCredentialRequest` → `pushRequest` + `appendLog("凭据请求：<host>")`（cleanup unlisten）；渲染 `queue[0]`：标题「Git 认证」、描述显示 host 与类型（https / SSH 密钥口令）；https 显示可编辑用户名（预填 `usernameHint`），ssh-passphrase 隐藏用户名；口令输入 `type="password"`，https 标签「密码 / 访问令牌」、ssh 标签「密钥口令」；原生 checkbox「本次会话记住（仅内存）」；「确定」→ `gitCredentialRespond(requestId, username || null, password || null, remember)`，「取消」及 Esc/遮罩关闭 → `gitCredentialRespond(requestId, null, null, false)`；完成后 `removeRequest`。`showCloseButton={false}`（关闭语义＝取消，统一走 respond）。
  - `App.tsx`：`<KeybindingHost />` 与 `<SettingsDialog />` 旁挂 `<GitCredentialModal />`。

- [ ] **Step 1: 先写失败测试** — 新建 `src/features/git/GitCredentialModal.test.tsx`：

```tsx
/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const gitCredentialRespond = vi.fn();
vi.mock("../../bridge/tauri", () => ({
  gitCredentialRespond: (...a: unknown[]) => gitCredentialRespond(...a),
  onGitCredentialRequest: () => Promise.resolve(() => {}),
}));
vi.mock("../../stores/git.store", () => ({
  useGitStore: { getState: () => ({ appendLog: vi.fn() }) },
}));

import { GitCredentialModal } from "./GitCredentialModal";
import { useGitCredentialStore } from "./credentialRequest.store";

beforeEach(() => {
  vi.clearAllMocks();
  gitCredentialRespond.mockResolvedValue(undefined);
  useGitCredentialStore.setState({ queue: [] });
});
afterEach(() => {
  cleanup();
});

const REQ = {
  requestId: "r1",
  url: "https://github.com/owner/repo.git",
  usernameHint: "octocat",
  kind: "https" as const,
};

describe("GitCredentialModal", () => {
  it("shows the host and prefills the username hint", () => {
    useGitCredentialStore.setState({ queue: [REQ] });
    render(<GitCredentialModal />);
    expect(screen.getByText(/github\.com/)).toBeTruthy();
    expect((screen.getByLabelText("用户名") as HTMLInputElement).value).toBe("octocat");
  });

  it("submit sends credentials without remember and clears the queue", async () => {
    useGitCredentialStore.setState({ queue: [REQ] });
    render(<GitCredentialModal />);
    fireEvent.change(screen.getByLabelText("密码 / 访问令牌"), { target: { value: "tok" } });
    fireEvent.click(screen.getByRole("button", { name: "确定" }));
    await waitFor(() =>
      expect(gitCredentialRespond).toHaveBeenCalledWith("r1", "octocat", "tok", false),
    );
    await waitFor(() => expect(useGitCredentialStore.getState().queue).toHaveLength(0));
  });

  it("remember toggle propagates to the backend", async () => {
    useGitCredentialStore.setState({ queue: [REQ] });
    render(<GitCredentialModal />);
    fireEvent.change(screen.getByLabelText("密码 / 访问令牌"), { target: { value: "tok" } });
    fireEvent.click(screen.getByLabelText(/本次会话记住/));
    fireEvent.click(screen.getByRole("button", { name: "确定" }));
    await waitFor(() =>
      expect(gitCredentialRespond).toHaveBeenCalledWith("r1", "octocat", "tok", true),
    );
  });

  it("cancel responds with nulls and clears the queue", async () => {
    useGitCredentialStore.setState({ queue: [REQ] });
    render(<GitCredentialModal />);
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    await waitFor(() =>
      expect(gitCredentialRespond).toHaveBeenCalledWith("r1", null, null, false),
    );
    await waitFor(() => expect(useGitCredentialStore.getState().queue).toHaveLength(0));
  });

  it("ssh-passphrase kind hides the username field and relabels the secret", () => {
    useGitCredentialStore.setState({ queue: [{ ...REQ, kind: "ssh-passphrase" }] });
    render(<GitCredentialModal />);
    expect(screen.queryByLabelText("用户名")).toBeNull();
    expect(screen.getByLabelText("密钥口令")).toBeTruthy();
  });

  it("renders nothing when the queue is empty", () => {
    render(<GitCredentialModal />);
    expect(screen.queryByText("Git 认证")).toBeNull();
  });
});
```

- [ ] **Step 2: 跑出红** — `pnpm test src/features/git/GitCredentialModal.test.tsx` 失败（模块不存在）。

- [ ] **Step 3: 最小实现 — 小 store** — 新建 `src/features/git/credentialRequest.store.ts`：

```ts
import { create } from "zustand";
import type { GitCredentialRequestPayload } from "../../bridge/events";

interface GitCredentialRequestStore {
  queue: GitCredentialRequestPayload[];
  pushRequest: (req: GitCredentialRequestPayload) => void;
  removeRequest: (requestId: string) => void;
}

export const useGitCredentialStore = create<GitCredentialRequestStore>()((set) => ({
  queue: [],
  pushRequest: (req) => set((s) => ({ queue: [...s.queue, req] })),
  removeRequest: (requestId) =>
    set((s) => ({ queue: s.queue.filter((r) => r.requestId !== requestId) })),
}));
```

- [ ] **Step 4: 最小实现 — 弹窗组件** — 新建 `src/features/git/GitCredentialModal.tsx`：

```tsx
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { gitCredentialRespond, onGitCredentialRequest } from "../../bridge/tauri";
import { useGitStore } from "../../stores/git.store";
import { useGitCredentialStore } from "./credentialRequest.store";

/** Host portion of a remote URL, for display. Mirrors Rust host_of(). */
function hostOf(url: string): string {
  const afterScheme = url.split("://")[1] ?? url;
  const authority = afterScheme.split("/")[0] ?? "";
  const noUser = authority.includes("@")
    ? authority.slice(authority.lastIndexOf("@") + 1)
    : authority;
  return noUser.split(":")[0] ?? noUser;
}

/**
 * Root-mounted modal pairing with the Rust GitCredentialBroker: a
 * `git-credential-request` event pushes a prompt; submit/cancel answer via
 * `git_credential_respond`. Credentials are never persisted — "remember" is
 * a memory-only session cache on the backend.
 */
export function GitCredentialModal() {
  const queue = useGitCredentialStore((s) => s.queue);
  const pushRequest = useGitCredentialStore((s) => s.pushRequest);
  const removeRequest = useGitCredentialStore((s) => s.removeRequest);
  const current = queue[0] ?? null;

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(false);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    const un = onGitCredentialRequest((req) => {
      pushRequest(req);
      useGitStore.getState().appendLog(`凭据请求：${hostOf(req.url)}`);
    });
    return () => {
      void un.then((fn) => fn());
    };
  }, [pushRequest]);

  // Prefill fields whenever a new request becomes the active prompt.
  useEffect(() => {
    setUsername(current?.usernameHint ?? "");
    setPassword("");
    setRemember(false);
    setSending(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.requestId]);

  const respond = async (withCredential: boolean) => {
    if (!current || sending) return;
    setSending(true);
    try {
      await gitCredentialRespond(
        current.requestId,
        withCredential ? username || null : null,
        withCredential ? password || null : null,
        withCredential ? remember : false,
      );
    } finally {
      removeRequest(current.requestId);
    }
  };

  const isSsh = current?.kind === "ssh-passphrase";
  const secretLabel = isSsh ? "密钥口令" : "密码 / 访问令牌";

  return (
    <Dialog
      open={current !== null}
      onOpenChange={(open) => {
        if (!open) void respond(false);
      }}
    >
      <DialogContent className="sm:max-w-sm" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Git 认证</DialogTitle>
          <DialogDescription>
            {current
              ? `${hostOf(current.url)} 需要凭据（${isSsh ? "SSH 密钥口令" : "HTTPS"}）`
              : ""}
          </DialogDescription>
        </DialogHeader>
        {current && (
          <div className="grid gap-3">
            {!isSsh && (
              <div className="grid gap-1.5">
                <Label htmlFor="git-cred-user">用户名</Label>
                <Input
                  id="git-cred-user"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="用户名"
                  autoFocus
                />
              </div>
            )}
            <div className="grid gap-1.5">
              <Label htmlFor="git-cred-pass">{secretLabel}</Label>
              <Input
                id="git-cred-pass"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={secretLabel}
                autoFocus={isSsh}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void respond(true);
                }}
              />
            </div>
            <label className="flex items-center gap-2 text-sm text-[var(--text-secondary)] cursor-pointer">
              <input
                type="checkbox"
                checked={remember}
                onChange={(e) => setRemember(e.target.checked)}
                className="accent-[var(--accent)]"
              />
              本次会话记住（仅内存）
            </label>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" disabled={sending} onClick={() => void respond(false)}>
            取消
          </Button>
          <Button disabled={sending || !password} onClick={() => void respond(true)}>
            确定
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 5: 跑出绿** — `pnpm test src/features/git/GitCredentialModal.test.tsx` 六个用例全过。

- [ ] **Step 6: 根挂载** — 修改 `src/App.tsx`：顶部 import 区追加 `import { GitCredentialModal } from "./features/git/GitCredentialModal";`；JSX 中 `<SettingsDialog />`（L100）之后插入 `<GitCredentialModal />`。

- [ ] **Step 7: 门槛** — `pnpm lint && pnpm build && pnpm test` 全绿。

- [ ] **Step 8: 提交** —

```
git add src/features/git/credentialRequest.store.ts src/features/git/GitCredentialModal.tsx src/features/git/GitCredentialModal.test.tsx src/App.tsx
git commit -m "feat(git): GUI 凭据弹窗与会话级记住"
```

---
### Task 9: 破坏性确认对话框 + 分支选择器 + GitPanel 头部重构

**Files:**
- Create: `src/features/git/GitConfirmDialog.tsx`、`src/features/git/BranchSelector.tsx`、`src/features/git/BranchSelector.test.tsx`
- Modify: `src/features/git/GitPanel.tsx`

**Interfaces:**
- Consumes: T7 store 的 `branches/loadBranches/checkout/createBranch/deleteBranch/opRunning`；`ui/dialog`（`showCloseButton` 支持）、`ui/input`、`ui/button`（`destructive` 变体）。
- Produces:
  - `GitConfirmDialog`：`{ open, title, description, confirmLabel, busy?, onConfirm, onCancel }`——基于 `ui/dialog` 手搓的 AlertDialog 替代品（仓库无 `components/ui/alert-dialog`，控制器 A6 裁定不新增依赖）；确认按钮 `variant="destructive"`，`showCloseButton={false}`（关闭即取消）。
  - `BranchSelector`：`{ projectPath, open, onOpenChange }`——Dialog（sm:max-w-sm）：搜索 Input；「本地」分组（GitBranch 图标 + 名称 + HEAD 项 Check 标记；点击 → `checkout`，成功关闭；非 HEAD 项 hover 出现 Trash2 → `GitConfirmDialog`「删除分支」→ `deleteBranch`）；「远程」分组（点击同样走 checkout；分组尾注「签出远程分支将进入分离 HEAD 状态」——后端 T1 `checkout_branch` 对远程名按 revparse 直接检出，不建跟踪分支）；底部「新建分支…」内联 Input + 创建按钮 → `createBranch` 成功后自动 `checkout` 新分支并关闭；`open` 变 true 时 `loadBranches`。
  - `GitPanel.tsx` 头部：分支按钮（GitBranch + truncate 分支名 + ChevronDown）打开 `BranchSelector`；保留 ↑ahead ↓behind 徽标；右侧刷新按钮（RefreshCw，`statusLoading` 时 `animate-spin`，`disabled={statusLoading || !!opRunning}`，点击 `refresh + loadBranches + loadStashes`）；错误条从文件列表区移到头部下方独占一行；新增 `branchSelectorOpen` 本地状态并挂载 `<BranchSelector>`。

- [ ] **Step 1: 先写失败测试** — 新建 `src/features/git/BranchSelector.test.tsx`：

```tsx
/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

let gitState: {
  branches: { name: string; isHead: boolean; isRemote: boolean; ahead: number | null; behind: number | null }[];
  opRunning: string | null;
  loadBranches: ReturnType<typeof vi.fn>;
  checkout: ReturnType<typeof vi.fn>;
  createBranch: ReturnType<typeof vi.fn>;
  deleteBranch: ReturnType<typeof vi.fn>;
};
vi.mock("../../stores/git.store", () => ({
  useGitStore: (selector?: (s: typeof gitState) => unknown) => (selector ? selector(gitState) : gitState),
}));

import { BranchSelector } from "./BranchSelector";

beforeEach(() => {
  vi.clearAllMocks();
  gitState = {
    branches: [
      { name: "main", isHead: true, isRemote: false, ahead: 0, behind: 0 },
      { name: "feature", isHead: false, isRemote: false, ahead: null, behind: null },
      { name: "origin/main", isHead: false, isRemote: true, ahead: null, behind: null },
    ],
    opRunning: null,
    loadBranches: vi.fn().mockResolvedValue(undefined),
    checkout: vi.fn().mockResolvedValue(true),
    createBranch: vi.fn().mockResolvedValue(true),
    deleteBranch: vi.fn().mockResolvedValue(true),
  };
});
afterEach(() => cleanup());

describe("BranchSelector", () => {
  it("loads branches on open and marks the head branch", () => {
    render(<BranchSelector projectPath="/p" open onOpenChange={() => {}} />);
    expect(gitState.loadBranches).toHaveBeenCalledWith("/p");
    // HEAD 行带 ✓ 图标（lucide Check 渲染为 svg），用分支名行的 data-testid 定位
    expect(screen.getByTestId("branch-main")).toBeTruthy();
  });

  it("checking out a branch closes the selector on success", async () => {
    const onOpenChange = vi.fn();
    render(<BranchSelector projectPath="/p" open onOpenChange={onOpenChange} />);
    fireEvent.click(screen.getByTestId("branch-feature"));
    await waitFor(() => expect(gitState.checkout).toHaveBeenCalledWith("/p", "feature"));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it("creates a new branch then checks it out", async () => {
    render(<BranchSelector projectPath="/p" open onOpenChange={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /新建分支/ }));
    fireEvent.change(screen.getByPlaceholderText("新分支名"), { target: { value: "hotfix" } });
    fireEvent.click(screen.getByRole("button", { name: "创建" }));
    await waitFor(() => expect(gitState.createBranch).toHaveBeenCalledWith("/p", "hotfix"));
    await waitFor(() => expect(gitState.checkout).toHaveBeenCalledWith("/p", "hotfix"));
  });

  it("deleting a branch goes through the confirm dialog", async () => {
    render(<BranchSelector projectPath="/p" open onOpenChange={() => {}} />);
    fireEvent.click(screen.getByTestId("delete-feature"));
    expect(screen.getByText(/确定删除分支「feature」/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    await waitFor(() => expect(gitState.deleteBranch).toHaveBeenCalledWith("/p", "feature"));
  });
});
```

- [ ] **Step 2: 跑出红** — `pnpm test src/features/git/BranchSelector.test.tsx` 失败（组件不存在）。

- [ ] **Step 3: 最小实现 — GitConfirmDialog** — 新建 `src/features/git/GitConfirmDialog.tsx`：

```tsx
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface GitConfirmDialogProps {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Destructive-action confirm. Hand-built on ui/dialog because the repo has no
 * alert-dialog component and the controller ruled out new UI deps (A6).
 * Closing by any means (Esc / overlay / 取消) equals cancel.
 */
export function GitConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  busy,
  onConfirm,
  onCancel,
}: GitConfirmDialogProps) {
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onCancel(); }}>
      <DialogContent className="sm:max-w-sm" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onCancel}>
            取消
          </Button>
          <Button variant="destructive" disabled={busy} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 4: 最小实现 — BranchSelector** — 新建 `src/features/git/BranchSelector.tsx`：

```tsx
import { useEffect, useState } from "react";
import { Check, GitBranch, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useGitStore } from "../../stores/git.store";
import { GitConfirmDialog } from "./GitConfirmDialog";

interface BranchSelectorProps {
  projectPath: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Branch switcher/creator/deleter dialog opened from the Git panel header. */
export function BranchSelector({ projectPath, open, onOpenChange }: BranchSelectorProps) {
  const branches = useGitStore((s) => s.branches);
  const opRunning = useGitStore((s) => s.opRunning);
  const loadBranches = useGitStore((s) => s.loadBranches);
  const checkout = useGitStore((s) => s.checkout);
  const createBranch = useGitStore((s) => s.createBranch);
  const deleteBranch = useGitStore((s) => s.deleteBranch);
  // R1：store error 被对话框遮罩盖住 GitPanel 错误条——对话框内自行回显
  const error = useGitStore((s) => s.error);

  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [toDelete, setToDelete] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setQuery("");
      setCreating(false);
      setNewName("");
      setToDelete(null);
      void loadBranches(projectPath);
    }
  }, [open, projectPath, loadBranches]);

  const busy = !!opRunning;
  const q = query.trim().toLowerCase();
  const match = (name: string) => name.toLowerCase().includes(q);
  const locals = branches.filter((b) => !b.isRemote && match(b.name));
  const remotes = branches.filter((b) => b.isRemote && match(b.name));

  const doCheckout = async (name: string) => {
    if (busy) return;
    const ok = await checkout(projectPath, name);
    if (ok) onOpenChange(false);
  };

  const doCreate = async () => {
    const name = newName.trim();
    if (!name || busy) return;
    const ok = await createBranch(projectPath, name);
    if (!ok) return;
    setCreating(false);
    setNewName("");
    const switched = await checkout(projectPath, name);
    if (switched) onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>切换分支</DialogTitle>
        </DialogHeader>
        <Input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索分支…"
        />
        <div className="max-h-72 -mx-1 overflow-y-auto">
          <div className="px-2 py-1 text-xs text-[var(--text-tertiary)]">本地</div>
          {locals.map((b) => (
            <div
              key={b.name}
              data-testid={`branch-${b.name}`}
              className="group flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 hover:bg-[var(--overlay-hover)]"
              onClick={() => void doCheckout(b.name)}
            >
              <GitBranch size={13} className="shrink-0 text-[var(--text-tertiary)]" />
              <span className="flex-1 truncate text-sm">{b.name}</span>
              {b.isHead ? (
                <Check size={13} className="shrink-0 text-[var(--accent)]" />
              ) : (
                <button
                  data-testid={`delete-${b.name}`}
                  className="shrink-0 text-[var(--text-tertiary)] opacity-0 transition-opacity hover:text-[var(--error)] group-hover:opacity-100"
                  title="删除分支"
                  onClick={(e) => {
                    e.stopPropagation();
                    setToDelete(b.name);
                  }}
                >
                  <Trash2 size={13} />
                </button>
              )}
            </div>
          ))}
          {locals.length === 0 && (
            <div className="px-2 py-1.5 text-xs text-[var(--text-tertiary)]">无匹配分支</div>
          )}
          {remotes.length > 0 && (
            <>
              <div className="mt-1 border-t border-[var(--border-subtle)] px-2 py-1 pt-2 text-xs text-[var(--text-tertiary)]">
                远程
              </div>
              {remotes.map((b) => (
                <div
                  key={b.name}
                  data-testid={`branch-${b.name}`}
                  className="group flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 hover:bg-[var(--overlay-hover)]"
                  onClick={() => void doCheckout(b.name)}
                >
                  <GitBranch size={13} className="shrink-0 text-[var(--text-tertiary)]" />
                  <span className="flex-1 truncate text-sm">{b.name}</span>
                </div>
              ))}
              <div className="px-2 py-1 text-xs text-[var(--text-tertiary)]">
                签出远程分支将进入分离 HEAD 状态
              </div>
            </>
          )}
        </div>
        {error && (
          <p className="px-1 text-xs text-[var(--error)]">{error}</p>
        )}
        <div className="border-t border-[var(--border-subtle)] pt-3">
          {creating ? (
            <div className="flex gap-2">
              <Input
                autoFocus
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="新分支名"
                onKeyDown={(e) => {
                  if (e.key === "Enter") void doCreate();
                }}
              />
              <Button size="sm" disabled={!newName.trim() || busy} onClick={() => void doCreate()}>
                <Plus size={13} /> 创建
              </Button>
            </div>
          ) : (
            <Button variant="outline" size="sm" className="w-full" onClick={() => setCreating(true)}>
              <Plus size={13} /> 新建分支…
            </Button>
          )}
        </div>
        <GitConfirmDialog
          open={toDelete !== null}
          title="删除分支"
          description={`确定删除分支「${toDelete ?? ""}」？未合并的提交将无法找回。`}
          confirmLabel="删除"
          busy={busy}
          onCancel={() => setToDelete(null)}
          onConfirm={async () => {
            // R2：await 期间保持对话框打开让 busy 禁用态可渲染，成功后再关
            const name = toDelete;
            if (!name) return;
            const ok = await deleteBranch(projectPath, name);
            if (ok) setToDelete(null);
          }}
        />
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 5: 跑出绿** — `pnpm test src/features/git/BranchSelector.test.tsx` 四个用例全过。

- [ ] **Step 6: 重构 GitPanel 头部** — 修改 `src/features/git/GitPanel.tsx`：
  1. import 区：`lucide-react` 改为 `import { GitBranch, Plus, Minus, Check, ChevronDown, RefreshCw } from "lucide-react";`；追加 `import { BranchSelector } from "./BranchSelector";`。
  2. 解构行（T7 已改为 `statusLoading, opRunning` 的那行）追加两个动作（loadBranches、loadStashes）：`const { status, diff, diffFile, statusLoading, opRunning, error, refresh, viewDiff, stage, unstage, commit, loadBranches, loadStashes } = useGitStore();`
  3. `const [commitMsg, setCommitMsg] = useState("");` 下方追加 `const [branchSelectorOpen, setBranchSelectorOpen] = useState(false);`
  4. 将现有头部块（`{/* Header */}` 起到其闭合 `</div>` 止，即 `GitBranch size={14}` 所在的 flex 容器）整体替换为：

```tsx
      {/* Header */}
      <div className="flex items-center gap-1.5 px-3 py-2.5 border-b border-[color:var(--border-subtle)]">
        <Button
          variant="ghost"
          size="xs"
          className="max-w-[55%] gap-1.5"
          onClick={() => setBranchSelectorOpen(true)}
        >
          <GitBranch size={13} className="shrink-0 text-[var(--accent)]" />
          <span className="truncate">{status?.branch || "—"}</span>
          <ChevronDown size={12} className="shrink-0 text-[var(--text-tertiary)]" />
        </Button>
        {status && (status.ahead > 0 || status.behind > 0) && (
          <span className="text-[var(--text-tertiary)] text-xs">↑{status.ahead} ↓{status.behind}</span>
        )}
        <div className="flex-1" />
        <Button
          variant="ghost"
          size="icon-xs"
          title="刷新"
          disabled={statusLoading || !!opRunning}
          onClick={() => {
            refresh(project.path);
            loadBranches(project.path);
            loadStashes(project.path);
          }}
        >
          <RefreshCw size={13} className={statusLoading ? "animate-spin" : ""} />
        </Button>
      </div>
      {error && (
        <p className="border-b border-[color:var(--border-subtle)] px-4 py-1.5 text-xs text-[var(--error)]">{error}</p>
      )}
```

  5. 删除文件列表区内的旧错误行 `{error && <p className="text-[var(--error)] text-xs px-2 mt-2">{error}</p>}`（已上移到头部下方）。
  6. 在最外层容器闭合 `</div>` 之前（Diff viewer 块之后）挂载：

```tsx
      <BranchSelector
        projectPath={project.path}
        open={branchSelectorOpen}
        onOpenChange={setBranchSelectorOpen}
      />
```

- [ ] **Step 7: 门槛** — `pnpm lint && pnpm build && pnpm test` 全绿（warning 数保持 6）。

- [ ] **Step 8: 提交** —

```
git add src/features/git/GitConfirmDialog.tsx src/features/git/BranchSelector.tsx src/features/git/BranchSelector.test.tsx src/features/git/GitPanel.tsx
git commit -m "feat(git): 分支选择器与破坏性操作确认对话框"
```

---

### Task 10: 提交区组件化 + Ctrl+Enter 走命令注册（含三处测试扩展）

**Files:**
- Create: `src/features/git/CommitSection.tsx`、`src/features/git/CommitSection.test.tsx`
- Modify: `src/commands/registry.ts`、`src/commands/KeybindingHost.tsx`、`src/features/git/GitPanel.tsx`、`src/commands/registry.test.ts`、`src/commands/registry.run.test.ts`、`src/commands/KeybindingHost.test.tsx`

**Interfaces:**
- Consumes: T7 的 `commitMessage/setCommitMessage/commitWith/opRunning`；命令框架 `Command { id, title, category, defaultKey, when?, run }`、`k()` 助手、`ALLOW_IN_INPUT` 白名单。
- Produces:
  - `CommitSection`：`{ projectPath }`——提交消息 Input（`data-scm-commit-input` 属性，值绑定 `commitMessage`，**裸 Enter**（非 Ctrl/Meta、非 IME 合成中）→ `commitWith(projectPath, "commit")`）；分裂按钮：主按钮「提交」（accent 配色沿用原 GitPanel，`opRunning === "提交"` 时 Loader2 旋转否则 Check 图标）+ 右侧 ChevronDown 触发 DropdownMenu，两项「提交并推送」→ `commitWith(path, "push")`、「提交并同步（拉取后推送）」→ `commitWith(path, "sync")`；`canCommit = message 非空 && !opRunning`。
  - `registry.ts` 新命令 `scm.commit`：title「提交（提交框）」、category「Git」、`defaultKey: k("enter", { primary: true })`（canonical `primary+enter`，与现有种子绑定均不冲突）、`when: () => !!document.activeElement?.closest("[data-scm-commit-input]")`、run＝取活动项目路径 → `commitWith(path, "commit")`；新 import `useProjectStore`、`useGitStore`。
    - **选命令注册而非组件内 keydown 的理由**：机制现成（registry + ALLOW_IN_INPUT + when 三件套），约 3 处改动即得一个**可被键位编辑器重绑定**的 Ctrl+Enter；组件内局部 keydown 是死绑定。双触发安全性：KeybindingHost 在 window 捕获阶段先于 React 合成事件处理并 `stopImmediatePropagation`，且 `commitWith` 开头有 `opRunning` 守卫兜底。
  - `KeybindingHost.tsx`：`ALLOW_IN_INPUT` 追加 `"scm.commit"`（Enter 为非打印键，白名单放行条件天然满足）。
  - `GitPanel.tsx`：提交区（原 Input + Commit Button 块）替换为 `<CommitSection projectPath={project.path} />`；删除本地 `commitMsg` 状态、`handleCommit`、T9 遗留的 `commit` 解构项与 `Check` 图标 import（`Plus`/`Minus` 暂留，T11 替换文件列表后清理）。

- [ ] **Step 1: 先写失败测试 — CommitSection** — 新建 `src/features/git/CommitSection.test.tsx`：

```tsx
/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

let gitState: {
  commitMessage: string;
  opRunning: string | null;
  setCommitMessage: ReturnType<typeof vi.fn>;
  commitWith: ReturnType<typeof vi.fn>;
};
vi.mock("../../stores/git.store", () => ({
  useGitStore: (selector?: (s: typeof gitState) => unknown) => (selector ? selector(gitState) : gitState),
}));

import { CommitSection } from "./CommitSection";

beforeEach(() => {
  vi.clearAllMocks();
  gitState = {
    commitMessage: "hello",
    opRunning: null,
    setCommitMessage: vi.fn(),
    commitWith: vi.fn().mockResolvedValue(undefined),
  };
});
afterEach(() => cleanup());

describe("CommitSection", () => {
  it("bare Enter in the commit input commits", () => {
    render(<CommitSection projectPath="/p" />);
    const input = document.querySelector("[data-scm-commit-input]")!;
    fireEvent.keyDown(input, { key: "Enter" });
    expect(gitState.commitWith).toHaveBeenCalledWith("/p", "commit");
  });

  it("Ctrl+Enter is left to the global keybinding (local handler skips it)", () => {
    render(<CommitSection projectPath="/p" />);
    const input = document.querySelector("[data-scm-commit-input]")!;
    fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });
    expect(gitState.commitWith).not.toHaveBeenCalled();
  });

  it("dropdown item 提交并推送 uses push mode", async () => {
    render(<CommitSection projectPath="/p" />);
    fireEvent.pointerDown(screen.getByTitle("更多提交方式"));
    const item = await screen.findByText("提交并推送");
    fireEvent.click(item);
    await waitFor(() => expect(gitState.commitWith).toHaveBeenCalledWith("/p", "push"));
  });

  it("empty message disables the commit button", () => {
    gitState.commitMessage = "   ";
    render(<CommitSection projectPath="/p" />);
    expect((screen.getByRole("button", { name: "提交" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
```

- [ ] **Step 2: 最小实现 — CommitSection** — 新建 `src/features/git/CommitSection.tsx`：

```tsx
import { Check, ChevronDown, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { useGitStore } from "../../stores/git.store";

/** Commit box + split button (提交 / 提交并推送 / 提交并同步). */
export function CommitSection({ projectPath }: { projectPath: string }) {
  const commitMessage = useGitStore((s) => s.commitMessage);
  const setCommitMessage = useGitStore((s) => s.setCommitMessage);
  const commitWith = useGitStore((s) => s.commitWith);
  const opRunning = useGitStore((s) => s.opRunning);

  const busy = opRunning !== null;
  const canCommit = commitMessage.trim().length > 0 && !busy;

  return (
    <div className="border-t border-[color:var(--border-subtle)] p-4">
      <Input
        data-scm-commit-input
        value={commitMessage}
        onChange={(e) => setCommitMessage(e.target.value)}
        placeholder="提交消息（Enter 提交）"
        className="font-normal text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)]"
        onKeyDown={(e) => {
          // Ctrl/Cmd+Enter is owned by the scm.commit command (KeybindingHost);
          // the local handler only takes bare Enter, and never mid-IME.
          if (e.key === "Enter" && !e.ctrlKey && !e.metaKey && !e.nativeEvent.isComposing) {
            void commitWith(projectPath, "commit");
          }
        }}
      />
      <div className="mt-3 flex gap-1">
        <Button
          className="flex-1 h-auto bg-[var(--accent)] py-2.5 text-white hover:bg-[var(--accent-hover)] dark:bg-[var(--accent)] dark:text-white dark:hover:bg-[var(--accent-hover)]"
          disabled={!canCommit}
          onClick={() => void commitWith(projectPath, "commit")}
        >
          {opRunning === "提交" ? (
            <Loader2 size={14} className="mr-2 animate-spin" />
          ) : (
            <Check size={14} className="mr-2" />
          )}
          提交
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              title="更多提交方式"
              className="h-auto bg-[var(--accent)] px-2 py-2.5 text-white hover:bg-[var(--accent-hover)] dark:bg-[var(--accent)] dark:text-white dark:hover:bg-[var(--accent-hover)]"
              disabled={!canCommit}
            >
              <ChevronDown size={14} />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            <DropdownMenuItem onSelect={() => void commitWith(projectPath, "push")}>
              提交并推送
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void commitWith(projectPath, "sync")}>
              提交并同步（拉取后推送）
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: 跑出绿** — `pnpm test src/features/git/CommitSection.test.tsx` 全过。

- [ ] **Step 4: 注册 scm.commit 命令** — 修改 `src/commands/registry.ts`：
  1. 顶部 import 区追加：

```ts
import { useProjectStore } from "../stores/project.store";
import { useGitStore } from "../stores/git.store";
```

  2. 在 `COMMANDS` 数组 `scm.focus` 条目之后插入：

```ts
  {
    id: "scm.commit",
    title: "提交（提交框）",
    category: "Git",
    defaultKey: k("enter", { primary: true }),
    // Only meaningful while the SCM commit input is focused; doubles as a
    // guard so a user-rebound bare "enter" cannot eat Return in other inputs.
    when: () => !!document.activeElement?.closest("[data-scm-commit-input]"),
    run: () => {
      const { projects, activeProjectId } = useProjectStore.getState();
      const path = projects.find((p) => p.id === activeProjectId)?.path;
      if (path) void useGitStore.getState().commitWith(path, "commit");
    },
  },
```

- [ ] **Step 5: 白名单放行** — 修改 `src/commands/KeybindingHost.tsx` L12：

```ts
const ALLOW_IN_INPUT = new Set(["editor.save", "editor.close", "scm.commit"]);
```

- [ ] **Step 6: 扩展 registry.test.ts** — 在 `seeds the core VSCode-style defaults` 用例内（`workbench.newConversation` 断言之后）追加一行：

```ts
    expect(byId("scm.commit")).toBe("primary+enter");
```

（`primary+enter` 未被其他种子命令占用，唯一性用例保持通过。）

- [ ] **Step 7: 扩展 registry.run.test.ts** — 修改 `src/commands/registry.run.test.ts`：
  1. 模块级 let 区追加：

```ts
let projectState: { projects: { id: string; path: string }[]; activeProjectId: string | null };
let gitCmdState: { commitWith: ReturnType<typeof vi.fn> };
```

  2. mock 工厂区追加：

```ts
vi.mock("../stores/project.store", () => ({
  useProjectStore: { getState: () => projectState },
}));
vi.mock("../stores/git.store", () => ({
  useGitStore: { getState: () => gitCmdState },
}));
```

  3. `beforeEach` 内追加：

```ts
  projectState = { projects: [], activeProjectId: null };
  gitCmdState = { commitWith: vi.fn() };
```

  4. 文件末尾追加 describe：

```ts
describe("scm.commit run", () => {
  it("commits via the git store for the active project", () => {
    projectState = { projects: [{ id: "p1", path: "/proj" }], activeProjectId: "p1" };
    getCommand("scm.commit")!.run();
    expect(gitCmdState.commitWith).toHaveBeenCalledWith("/proj", "commit");
  });

  it("is a no-op without an active project", () => {
    getCommand("scm.commit")!.run();
    expect(gitCmdState.commitWith).not.toHaveBeenCalled();
  });

  it("when() matches only the commit input", () => {
    const commitInput = document.createElement("input");
    commitInput.setAttribute("data-scm-commit-input", "");
    document.body.appendChild(commitInput);
    const other = document.createElement("input");
    document.body.appendChild(other);

    const when = getCommand("scm.commit")!.when!;
    commitInput.focus();
    expect(when()).toBe(true);
    other.focus();
    expect(when()).toBe(false);
    document.body.innerHTML = "";
  });
});
```

- [ ] **Step 8: 扩展 KeybindingHost.test.tsx** — 修改 `src/commands/KeybindingHost.test.tsx`：
  1. `const close = vi.fn();` 下方追加 `const scmCommit = vi.fn();`
  2. 被 mock 的 `listCommands` 数组追加一项：

```ts
    {
      id: "scm.commit",
      title: "k",
      category: "c",
      defaultKey: null,
      when: () => !!document.activeElement?.closest("[data-scm-commit-input]"),
      run: scmCommit,
    },
```

  3. mock 的 `resolve` 内（`editor.close` 分支之后）追加：

```ts
        if (id === "scm.commit") return { primary: true, key: "enter" };
```

  4. describe 内追加两个用例：

```ts
  it("scm.commit fires on Ctrl+Enter from the commit input", () => {
    const input = document.createElement("input");
    input.setAttribute("data-scm-commit-input", "");
    document.body.appendChild(input);
    input.focus();
    fire(window, { key: "Enter", code: "Enter", ctrlKey: true });
    expect(scmCommit).toHaveBeenCalledTimes(1);
  });

  it("scm.commit does not fire from an unrelated input", () => {
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    fire(window, { key: "Enter", code: "Enter", ctrlKey: true });
    expect(scmCommit).not.toHaveBeenCalled();
  });
```

- [ ] **Step 9: GitPanel 接入 CommitSection** — 修改 `src/features/git/GitPanel.tsx`：
  1. import 区：`lucide-react` 去掉 `Check`（`import { GitBranch, Plus, Minus, ChevronDown, RefreshCw } from "lucide-react";`）；追加 `import { CommitSection } from "./CommitSection";`；删除 `import { Input } from "@/components/ui/input";`（提交框已移入 CommitSection，面板内不再直接用 Input）。
  2. 解构行去掉 `commit`：`const { status, diff, diffFile, statusLoading, opRunning, error, refresh, viewDiff, stage, unstage, loadBranches, loadStashes } = useGitStore();`
  3. 删除 `const [commitMsg, setCommitMsg] = useState("");` 与整个 `handleCommit` 函数（T7 版本：`const ok = await commit(...)` 那一段）。
  4. 将「Commit area」整块（`{/* Commit area */}` 起到其闭合 `</div>` 止）替换为：

```tsx
      {/* Commit area */}
      <CommitSection projectPath={project.path} />
```

- [ ] **Step 10: 跑出绿与门槛** — `pnpm test src/commands src/features/git && pnpm lint && pnpm build && pnpm test` 全绿。

- [ ] **Step 11: 提交** —

```
git add src/features/git/CommitSection.tsx src/features/git/CommitSection.test.tsx src/commands/registry.ts src/commands/KeybindingHost.tsx src/commands/registry.test.ts src/commands/registry.run.test.ts src/commands/KeybindingHost.test.tsx src/features/git/GitPanel.tsx
git commit -m "feat(git): 提交区组件化与 Ctrl+Enter 提交命令"
```

---

### Task 11: 变更/暂存文件组重构（折叠分组 + 组动作 + 每行 4 悬停图标 + 状态色 + 树形视图）

**Files:**
- Create: `src/features/git/ChangesSection.tsx`、`src/features/git/ChangesSection.test.tsx`
- Modify: `src/features/git/GitPanel.tsx`

**Interfaces:**
- Consumes:
  - T7 store：`status`（`GitStatus.files: GitFileChange[]`）、`statusLoading`、`opRunning`、`treeView`/`setTreeView`、`stage(projectPath, files)`、`unstage(projectPath, files)`、`discard(projectPath, files): Promise<boolean>`、`revertStaged(projectPath, files): Promise<boolean>`、`viewDiff(projectPath, file, staged)`。
  - T6 类型：`GitFileChange { path, status: "modified" | "added" | "deleted" | "untracked", staged }`（path 为仓库根相对路径、`/` 分隔；后端 `discard_changes`/`revert_staged` 语义见 T2：discard＝未跟踪删盘/已跟踪还原到暂存版本，revert_staged＝index 与工作区同回 HEAD）。
  - T9 `GitConfirmDialog`（丢弃与还原暂存的破坏性确认）。
  - `useFsStore.getState().openFile(filePath)`（fs.store 既有动作，「打开文件」图标用；需要绝对路径，组件内拼 `projectPath + "/" + rel`，Windows 文件 API 同样接受 `/` 分隔）。
  - 折叠样式沿用 `src/features/files/FileTree.tsx` 的视觉惯例（ChevronRight `rotate-90`、`depth * 12` 缩进、Folder/File 图标）；但 FileTree 与 fs.store 的 `nodesByDir/expandedDirs` 强耦合，不可复用其组件，本任务按 `/` 分段自建纯前端树（数据不变，仅视图切换，对齐 spec F2「树视图」条）。
- Produces:
  - `ChangesSection`：`{ projectPath }`——顶部一行右对齐的列表/树视图切换按钮（`List`/`FolderTree` 图标互换，读写 store `treeView`）；「更改」「暂存的更改」两个 `FileGroup`（按 `f.staged` 拆分，空组不渲染；两者皆空显示「无更改，工作区干净」）。
  - `FileGroup`（模块内组件）：折叠组头（ChevronRight + 标题 + `(计数)` + 组动作按钮，本地 `collapsed` 状态、默认展开）。「更改」组动作：「全部暂存」（Plus）→ `stage(projectPath, 全部路径)`、「丢弃全部更改」（Trash2，destructive 悬停色）→ 经 `GitConfirmDialog` 确认后 `discard`；「暂存的更改」组动作：「全部取消暂存」（Minus）→ `unstage`、「还原暂存更改」（Undo2）→ 经确认后 `revertStaged`。组动作按钮 `disabled={busy}`（`busy = statusLoading || opRunning !== null`）且 `stopPropagation`（不误触折叠）。
  - `FileRow`（模块内组件）：状态字母 `status[0].toUpperCase()`（M/A/D/U），颜色映射 `modified → var(--warning)`（黄）、`added → var(--success)`（绿）、`deleted → var(--error)`（红）、`untracked → var(--success)`（绿）——变量名以仓库 CSS 现状为准（既有 GitPanel 已用 `--warning`/`--success`/`--error`，仓库无 `--warn`/`--danger`）。整行点击 → `viewDiff(projectPath, f.path, f.staged)`（**Plan 4 将此调用点改为 `openDiffInEditor` 在编辑器开只读 diff 标签**，本计划保留内联窗格，注释标明）。hover 出现 4 个图标（`opacity-0 group-hover:opacity-100`，均 `stopPropagation`）：① 打开文件（File → `useFsStore.getState().openFile(absPath)`）；② 打开 diff（FileDiff → `viewDiff`，同样注释 Plan 4 替换点）；③ 暂存（Plus，仅未暂存行）/ 取消暂存（Minus，仅已暂存行）；④ 丢弃（Trash2，destructive 悬停色；未暂存行 → 确认 → `discard`，已暂存行 → 确认 → `revertStaged`）。
  - `ChangeTreeView`（模块内组件）：`buildTree(files)` 按 `/` 分段把文件挂到目录节点（`{ name, path, dirs, files }`，目录按名排序、文件按路径排序），目录行（Folder 图标 + ChevronRight）点击切换本地 `collapsed: Set<string>`（默认全展开），文件行复用 `FileRow`（树模式显示 basename，列表模式显示全相对路径）。
  - 确认对话框在 `ChangesSection` 顶层只挂一个，由本地 `pendingDiscard: { files: string[]; staged: boolean } | null` 驱动：标题/描述按 `staged` 分两套文案。
  - `GitPanel.tsx`：文件列表整块替换为 `<ChangesSection projectPath={project.path} />`；解构行移除 `viewDiff/stage/unstage`（全部迁入 ChangesSection）；删除 `handleStage`/`handleUnstage` 两函数与 `staged`/`unstaged` 两条派生 const；lucide import 去掉 `Plus`/`Minus`（T10 遗留，至此清理完毕）。

- [ ] **Step 1: 先写失败测试** — 新建 `src/features/git/ChangesSection.test.tsx`：

```tsx
/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

type ChangeFile = {
  path: string;
  status: "modified" | "added" | "deleted" | "untracked";
  staged: boolean;
};
let gitState: {
  status: { files: ChangeFile[] } | null;
  statusLoading: boolean;
  opRunning: string | null;
  treeView: boolean;
  setTreeView: ReturnType<typeof vi.fn>;
  stage: ReturnType<typeof vi.fn>;
  unstage: ReturnType<typeof vi.fn>;
  discard: ReturnType<typeof vi.fn>;
  revertStaged: ReturnType<typeof vi.fn>;
  viewDiff: ReturnType<typeof vi.fn>;
};
vi.mock("../../stores/git.store", () => ({
  useGitStore: (selector?: (s: typeof gitState) => unknown) => (selector ? selector(gitState) : gitState),
}));

const openFileMock = vi.fn();
vi.mock("../../stores/fs.store", () => ({
  useFsStore: { getState: () => ({ openFile: openFileMock }) },
}));

import { ChangesSection } from "./ChangesSection";

beforeEach(() => {
  vi.clearAllMocks();
  gitState = {
    status: {
      files: [
        { path: "a.txt", status: "modified", staged: false },
        { path: "b.txt", status: "untracked", staged: false },
        { path: "c.txt", status: "added", staged: true },
      ],
    },
    statusLoading: false,
    opRunning: null,
    treeView: false,
    setTreeView: vi.fn(),
    stage: vi.fn().mockResolvedValue(undefined),
    unstage: vi.fn().mockResolvedValue(undefined),
    discard: vi.fn().mockResolvedValue(true),
    revertStaged: vi.fn().mockResolvedValue(true),
    viewDiff: vi.fn().mockResolvedValue(undefined),
  };
});
afterEach(() => cleanup());

describe("ChangesSection", () => {
  it("renders both groups with counts", () => {
    render(<ChangesSection projectPath="/p" />);
    expect(screen.getByText("更改 (2)")).toBeTruthy();
    expect(screen.getByText("暂存的更改 (1)")).toBeTruthy();
  });

  it("per-row stage icon stages a single file", () => {
    render(<ChangesSection projectPath="/p" />);
    fireEvent.click(screen.getByTestId("stage-a.txt"));
    expect(gitState.stage).toHaveBeenCalledWith("/p", ["a.txt"]);
  });

  it("group unstage button unstages every staged file", () => {
    render(<ChangesSection projectPath="/p" />);
    fireEvent.click(screen.getByTestId("unstage-all"));
    expect(gitState.unstage).toHaveBeenCalledWith("/p", ["c.txt"]);
  });

  it("discard goes through the confirm dialog before calling the store", () => {
    render(<ChangesSection projectPath="/p" />);
    fireEvent.click(screen.getByTestId("discard-a.txt"));
    expect(screen.getByText(/丢弃 1 个文件的更改/)).toBeTruthy();
    expect(gitState.discard).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "丢弃" }));
    expect(gitState.discard).toHaveBeenCalledWith("/p", ["a.txt"]);
  });

  it("tree view groups files by directory and directory rows collapse", () => {
    gitState.treeView = true;
    gitState.status = {
      files: [
        { path: "src/app.ts", status: "modified", staged: false },
        { path: "src/lib/util.ts", status: "modified", staged: false },
      ],
    };
    render(<ChangesSection projectPath="/p" />);
    expect(screen.getByTestId("dir-src")).toBeTruthy();
    expect(screen.getByTestId("row-src/app.ts")).toBeTruthy();
    fireEvent.click(screen.getByTestId("dir-src"));
    expect(screen.queryByTestId("row-src/app.ts")).toBeNull();
    expect(screen.queryByTestId("row-src/lib/util.ts")).toBeNull();
    fireEvent.click(screen.getByTestId("dir-src"));
    expect(screen.getByTestId("row-src/app.ts")).toBeTruthy();
  });

  it("row click opens the inline diff (Plan 4 will swap this call site)", () => {
    render(<ChangesSection projectPath="/p" />);
    fireEvent.click(screen.getByTestId("row-a.txt"));
    expect(gitState.viewDiff).toHaveBeenCalledWith("/p", "a.txt", false);
  });
});
```

- [ ] **Step 2: 跑出红** — `pnpm test src/features/git/ChangesSection.test.tsx` 失败（组件不存在）。

- [ ] **Step 3: 最小实现** — 新建 `src/features/git/ChangesSection.tsx`：

```tsx
import { useMemo, useState } from "react";
import {
  ChevronRight,
  File,
  FileDiff,
  Folder,
  FolderTree,
  List,
  Minus,
  Plus,
  Trash2,
  Undo2,
} from "lucide-react";
import { useGitStore } from "../../stores/git.store";
import { useFsStore } from "../../stores/fs.store";
import type { GitFileChange } from "../../bridge/tauri";
import { GitConfirmDialog } from "./GitConfirmDialog";

/** VSCode 状态色惯例：modified 黄 / added 绿 / deleted 红 / untracked 绿。 */
const STATUS_COLORS: Record<GitFileChange["status"], string> = {
  modified: "var(--warning)",
  added: "var(--success)",
  deleted: "var(--error)",
  untracked: "var(--success)",
};

// GitFileChange.path 是仓库根相对路径（/ 分隔）；fs store 的 openFile 需要
// 绝对路径。Windows 文件 API 同样接受 "/" 分隔符。
function absPath(projectPath: string, rel: string): string {
  return `${projectPath}/${rel}`;
}

function basename(rel: string): string {
  const i = rel.lastIndexOf("/");
  return i >= 0 ? rel.slice(i + 1) : rel;
}

interface PendingDiscard {
  files: string[];
  staged: boolean;
}

const ICON_BUTTON =
  "rounded p-0.5 text-[var(--text-tertiary)] transition-colors duration-100 hover:bg-[var(--overlay-hover)] hover:text-[var(--text-primary)] disabled:opacity-40";

interface FileRowProps {
  projectPath: string;
  file: GitFileChange;
  /** 列表模式显示完整相对路径，树模式显示 basename。 */
  display: string;
  busy: boolean;
  onDiscard: (pending: PendingDiscard) => void;
}

function FileRow({ projectPath, file, display, busy, onDiscard }: FileRowProps) {
  const stage = useGitStore((s) => s.stage);
  const unstage = useGitStore((s) => s.unstage);
  const viewDiff = useGitStore((s) => s.viewDiff);

  return (
    <div
      data-testid={`row-${file.path}`}
      className="group flex cursor-pointer items-center gap-2 rounded-[var(--radius-sm)] px-2.5 py-1.5 transition-colors duration-100 hover:bg-[var(--overlay-hover)]"
      onClick={() =>
        // Plan 4 将此调用点改为 openDiffInEditor（编辑器只读 diff 标签）；
        // 本计划沿用 GitPanel 底部内联 diff 窗格。
        void viewDiff(projectPath, file.path, file.staged)
      }
    >
      <span className="w-3 shrink-0 text-center text-xs" style={{ color: STATUS_COLORS[file.status] }}>
        {file.status[0].toUpperCase()}
      </span>
      <span className="min-w-0 flex-1 truncate text-[var(--text-secondary)]">{display}</span>
      <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
        <button
          data-testid={`open-${file.path}`}
          title="打开文件"
          disabled={busy}
          className={ICON_BUTTON}
          onClick={(e) => {
            e.stopPropagation();
            void useFsStore.getState().openFile(absPath(projectPath, file.path));
          }}
        >
          <File size={13} />
        </button>
        <button
          data-testid={`diff-${file.path}`}
          title="打开 diff"
          disabled={busy}
          className={ICON_BUTTON}
          onClick={(e) => {
            e.stopPropagation();
            // Plan 4 改为 openDiffInEditor。
            void viewDiff(projectPath, file.path, file.staged);
          }}
        >
          <FileDiff size={13} />
        </button>
        {file.staged ? (
          <button
            data-testid={`unstage-${file.path}`}
            title="取消暂存"
            disabled={busy}
            className={ICON_BUTTON}
            onClick={(e) => {
              e.stopPropagation();
              void unstage(projectPath, [file.path]);
            }}
          >
            <Minus size={13} />
          </button>
        ) : (
          <button
            data-testid={`stage-${file.path}`}
            title="暂存"
            disabled={busy}
            className={ICON_BUTTON}
            onClick={(e) => {
              e.stopPropagation();
              void stage(projectPath, [file.path]);
            }}
          >
            <Plus size={13} />
          </button>
        )}
        <button
          data-testid={`discard-${file.path}`}
          title={file.staged ? "还原暂存更改" : "丢弃更改"}
          disabled={busy}
          className={`${ICON_BUTTON} hover:!text-[var(--error)]`}
          onClick={(e) => {
            e.stopPropagation();
            onDiscard({ files: [file.path], staged: file.staged });
          }}
        >
          <Trash2 size={13} />
        </button>
      </span>
    </div>
  );
}

interface TreeDir {
  name: string;
  /** 完整相对目录路径（作为折叠集合的键）。 */
  path: string;
  dirs: TreeDir[];
  files: GitFileChange[];
}

/** 按 "/" 分段把平铺文件列表挂成目录树；根级文件进 root.files。 */
function buildTree(files: GitFileChange[]): TreeDir {
  interface Builder {
    name: string;
    path: string;
    dirs: Map<string, Builder>;
    files: GitFileChange[];
  }
  const root: Builder = { name: "", path: "", dirs: new Map(), files: [] };
  for (const f of files) {
    const parts = f.path.split("/");
    parts.pop(); // 文件名留在 FileRow 里按 basename 显示
    let node = root;
    let acc = "";
    for (const part of parts) {
      acc = acc ? `${acc}/${part}` : part;
      let child = node.dirs.get(part);
      if (!child) {
        child = { name: part, path: acc, dirs: new Map(), files: [] };
        node.dirs.set(part, child);
      }
      node = child;
    }
    node.files.push(f);
  }
  const finalize = (b: Builder): TreeDir => ({
    name: b.name,
    path: b.path,
    dirs: [...b.dirs.values()]
      .sort((x, y) => x.name.localeCompare(y.name))
      .map(finalize),
    files: [...b.files].sort((x, y) => x.path.localeCompare(y.path)),
  });
  return finalize(root);
}

interface ChangeTreeViewProps {
  projectPath: string;
  files: GitFileChange[];
  busy: boolean;
  onDiscard: (pending: PendingDiscard) => void;
}

function ChangeTreeView({ projectPath, files, busy, onDiscard }: ChangeTreeViewProps) {
  const tree = useMemo(() => buildTree(files), [files]);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());

  const toggle = (path: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const renderDir = (dir: TreeDir, depth: number) => {
    const isCollapsed = collapsed.has(dir.path);
    return (
      <div key={`dir-${dir.path}`}>
        <div
          data-testid={`dir-${dir.path}`}
          className="flex cursor-pointer items-center gap-2 rounded-[var(--radius-sm)] px-2.5 py-1.5 hover:bg-[var(--overlay-hover)]"
          style={{ paddingLeft: depth * 12 + 10 }}
          onClick={() => toggle(dir.path)}
        >
          <ChevronRight
            size={12}
            className={`shrink-0 text-[var(--text-tertiary)] transition-transform duration-150 ${isCollapsed ? "" : "rotate-90"}`}
          />
          <Folder size={13} className="shrink-0 text-[var(--accent)]" />
          <span className="truncate text-[var(--text-secondary)]">{dir.name}</span>
        </div>
        {!isCollapsed && (
          <>
            {dir.dirs.map((d) => renderDir(d, depth + 1))}
            {dir.files.map((f) => (
              <div key={f.path} style={{ paddingLeft: (depth + 1) * 12 }}>
                <FileRow
                  projectPath={projectPath}
                  file={f}
                  display={basename(f.path)}
                  busy={busy}
                  onDiscard={onDiscard}
                />
              </div>
            ))}
          </>
        )}
      </div>
    );
  };

  return (
    <div>
      {tree.dirs.map((d) => renderDir(d, 0))}
      {tree.files.map((f) => (
        <FileRow key={f.path} projectPath={projectPath} file={f} display={f.path} busy={busy} onDiscard={onDiscard} />
      ))}
    </div>
  );
}

interface FileGroupProps {
  projectPath: string;
  title: string;
  files: GitFileChange[];
  staged: boolean;
  busy: boolean;
  treeView: boolean;
  onDiscard: (pending: PendingDiscard) => void;
}

/** 折叠分组头：标题 + 计数 + 组动作（全部暂存/取消暂存 + 整组破坏性动作）。 */
function FileGroup({ projectPath, title, files, staged, busy, treeView, onDiscard }: FileGroupProps) {
  const stage = useGitStore((s) => s.stage);
  const unstage = useGitStore((s) => s.unstage);
  const [collapsed, setCollapsed] = useState(false);
  const paths = files.map((f) => f.path);

  return (
    <div className="mb-2">
      <div
        data-testid={staged ? "group-staged" : "group-unstaged"}
        className="flex cursor-pointer items-center gap-1.5 px-2 py-1.5 text-xs text-[var(--text-tertiary)] hover:bg-[var(--overlay-hover)]"
        onClick={() => setCollapsed((c) => !c)}
      >
        <ChevronRight size={12} className={`transition-transform duration-150 ${collapsed ? "" : "rotate-90"}`} />
        <span>
          {title} ({files.length})
        </span>
        <div className="flex-1" />
        {staged ? (
          <>
            <button
              data-testid="unstage-all"
              title="全部取消暂存"
              disabled={busy}
              className={ICON_BUTTON}
              onClick={(e) => {
                e.stopPropagation();
                void unstage(projectPath, paths);
              }}
            >
              <Minus size={13} />
            </button>
            <button
              data-testid="revert-all"
              title="还原暂存更改"
              disabled={busy}
              className={`${ICON_BUTTON} hover:!text-[var(--error)]`}
              onClick={(e) => {
                e.stopPropagation();
                onDiscard({ files: paths, staged: true });
              }}
            >
              <Undo2 size={13} />
            </button>
          </>
        ) : (
          <>
            <button
              data-testid="stage-all"
              title="全部暂存"
              disabled={busy}
              className={ICON_BUTTON}
              onClick={(e) => {
                e.stopPropagation();
                void stage(projectPath, paths);
              }}
            >
              <Plus size={13} />
            </button>
            <button
              data-testid="discard-all"
              title="丢弃全部更改"
              disabled={busy}
              className={`${ICON_BUTTON} hover:!text-[var(--error)]`}
              onClick={(e) => {
                e.stopPropagation();
                onDiscard({ files: paths, staged: false });
              }}
            >
              <Trash2 size={13} />
            </button>
          </>
        )}
      </div>
      {!collapsed &&
        (treeView ? (
          <ChangeTreeView projectPath={projectPath} files={files} busy={busy} onDiscard={onDiscard} />
        ) : (
          files.map((f) => (
            <FileRow key={f.path} projectPath={projectPath} file={f} display={f.path} busy={busy} onDiscard={onDiscard} />
          ))
        ))}
    </div>
  );
}

/** 更改 / 暂存的更改 两组 + 列表/树视图切换。提交区（T10）不动。 */
export function ChangesSection({ projectPath }: { projectPath: string }) {
  const status = useGitStore((s) => s.status);
  const statusLoading = useGitStore((s) => s.statusLoading);
  const opRunning = useGitStore((s) => s.opRunning);
  const treeView = useGitStore((s) => s.treeView);
  const setTreeView = useGitStore((s) => s.setTreeView);
  const discard = useGitStore((s) => s.discard);
  const revertStaged = useGitStore((s) => s.revertStaged);

  const [pendingDiscard, setPendingDiscard] = useState<PendingDiscard | null>(null);

  const files = status?.files ?? [];
  const unstaged = files.filter((f) => !f.staged);
  const staged = files.filter((f) => f.staged);
  const busy = statusLoading || opRunning !== null;

  return (
    <div className="flex-1 overflow-y-auto px-2 py-2">
      <div className="flex items-center justify-end px-2 pb-1">
        <button
          data-testid="toggle-tree-view"
          title={treeView ? "切换为列表视图" : "切换为树视图"}
          className={ICON_BUTTON}
          onClick={() => setTreeView(!treeView)}
        >
          {treeView ? <List size={13} /> : <FolderTree size={13} />}
        </button>
      </div>
      {files.length === 0 && (
        <div className="px-2.5 py-2 text-xs text-[var(--text-tertiary)]">无更改，工作区干净</div>
      )}
      {unstaged.length > 0 && (
        <FileGroup
          projectPath={projectPath}
          title="更改"
          files={unstaged}
          staged={false}
          busy={busy}
          treeView={treeView}
          onDiscard={setPendingDiscard}
        />
      )}
      {staged.length > 0 && (
        <FileGroup
          projectPath={projectPath}
          title="暂存的更改"
          files={staged}
          staged
          busy={busy}
          treeView={treeView}
          onDiscard={setPendingDiscard}
        />
      )}
      <GitConfirmDialog
        open={pendingDiscard !== null}
        title={pendingDiscard?.staged ? "还原暂存更改" : "丢弃更改"}
        description={
          pendingDiscard?.staged
            ? `还原 ${pendingDiscard.files.length} 个文件至 HEAD 版本？暂存内容与工作区改动都会被重置，此操作不可撤销。`
            : `丢弃 ${pendingDiscard?.files.length ?? 0} 个文件的更改？未跟踪文件将被删除，已跟踪文件还原到暂存版本，此操作不可撤销。`
        }
        confirmLabel={pendingDiscard?.staged ? "还原" : "丢弃"}
        busy={busy}
        onCancel={() => setPendingDiscard(null)}
        onConfirm={() => {
          const pending = pendingDiscard;
          setPendingDiscard(null);
          if (!pending) return;
          if (pending.staged) void revertStaged(projectPath, pending.files);
          else void discard(projectPath, pending.files);
        }}
      />
    </div>
  );
}
```

- [ ] **Step 4: 跑出绿** — `pnpm test src/features/git/ChangesSection.test.tsx` 六个用例全过。

- [ ] **Step 5: GitPanel 接入** — 修改 `src/features/git/GitPanel.tsx`（T10 完成后的形态）：
  1. import 区：lucide 去掉 `Plus`/`Minus`，改为 `import { GitBranch, ChevronDown, RefreshCw } from "lucide-react";`；追加 `import { ChangesSection } from "./ChangesSection";`。
  2. 解构行移除 `viewDiff`/`stage`/`unstage`：`const { status, diff, diffFile, statusLoading, opRunning, error, refresh, loadBranches, loadStashes } = useGitStore();`
  3. 删除 `handleStage`、`handleUnstage` 两个函数与紧随其后的 `const staged = status?.files.filter((f) => f.staged) || [];`、`const unstaged = status?.files.filter((f) => !f.staged) || [];` 两条派生行。
  4. 将 `{/* File lists */}` 注释起到其 `<div className="flex-1 overflow-y-auto px-4 py-3">…</div>` 闭合止的整块替换为：

```tsx
      {/* File lists */}
      <ChangesSection projectPath={project.path} />
```

- [ ] **Step 6: 门槛** — `pnpm lint && pnpm build && pnpm test` 全绿（warning 数保持 6）。

- [ ] **Step 7: 提交** —

```
git add src/features/git/ChangesSection.tsx src/features/git/ChangesSection.test.tsx src/features/git/GitPanel.tsx
git commit -m "feat(git): 变更分组重构——折叠组、组动作、悬停图标与树视图"
```

---

### Task 12: ··· 操作菜单（pull/push/fetch/clone/检出远端 + stash 子菜单 + 显示操作日志 + clone 目录选择）

**Files:**
- Create: `src/features/git/GitActionsMenu.tsx`、`src/features/git/GitActionsMenu.test.tsx`
- Modify: `src/stores/git.store.ts`（`stashSave` 追加可选消息参数）、`src/features/git/GitPanel.tsx`（头部挂载菜单、底部挂载日志面板）

**Interfaces:**
- Consumes:
  - T7 store：`opRunning`（语义＝进行中操作名，逐字匹配 T7 `runOp` 名：`"拉取"`/`"推送"`/`"获取"`/`"克隆"`/`"存储"`/`"应用存储"`/`"弹出存储"`/`"删除存储"`）、`opLog`/`opLogOpen`/`setOpLogOpen`/`clearLog`（日志上限 100 条由 store 环形裁剪，面板只渲染）、`stashes`/`loadStashes`、`fetch(projectPath, remote?)`/`pull`/`push`/`clone(url, dest): Promise<boolean>`/`stashApply`/`stashPop`/`stashDrop`、`stashSave`（本任务扩展，见 Produces）。组件**不**直连桥接——T6 的 `gitFetch/gitPull/gitPush/gitClone/gitStash*` 封装已由 T7 store 动作包裹（含 opRunning/opLog/refresh 簿记），越过 store 直调会丢操作日志。
  - T9 `GitConfirmDialog`（删除存储确认）与 T9 落在 GitPanel 的 `branchSelectorOpen` 状态（经 `onOpenBranchSelector` 回调 prop 复用，「检出远端分支…」不新造选择器）。
  - 组件库：`ui/dropdown-menu`（勘察实录确认已玻璃化、含 Sub/CheckboxItem/Label 全套，直接用）、`ui/dialog`、`ui/input`、`ui/button`。**不引用** `alert-dialog`/`popover`/`scroll-area`（仓库均不存在；OpLogPanel 用 `div + max-h-40 overflow-y-auto` 普通滚动，免新组件）。
  - dialog 插件目录选择：照抄 `src/features/projects/ProjectSelector.tsx:85` 模式——`import { open } from "@tauri-apps/plugin-dialog"` + 先 `await getCurrentWindow().setFocus().catch(() => {})` 尽力前台、再 `await open({ directory: true, multiple: false, title: … })`、`typeof selected === "string"` 判定（该注释说明不经 setFocus 在 Windows 上系统对话框可能落到应用后方）。
- Produces:
  - `git.store.ts` 微调（两处）：接口 `stashSave: (projectPath: string, message?: string) => Promise<boolean>;`；实现体 `gitStashSave(projectPath, message ?? "")`（T7 原实现硬编码空串、后端会合成 `WIP on <branch>`；扩展后菜单可传用户消息，缺省行为不变）。
  - `GitActionsMenu`：`{ projectPath, onOpenBranchSelector }`——头部右侧 `MoreHorizontal` ghost 图标按钮触发的 DropdownMenu（`align="end"`、`w-56`）：
    - 网络四项「拉取」「推送」「获取」「克隆…」→ 对应 store 动作（克隆打开本组件内的 `CloneDialog`）。
    - 「检出远端分支…」→ `onOpenBranchSelector()`（`busy` 时禁用；远程分组与分离 HEAD 提示已在 T9 BranchSelector 内）。
    - `busy`（`opRunning !== null`）时：进行中项前缀 `Loader2` `animate-spin` 且**不**禁用自身（store 内 `runOp` 已有 opRunning 守卫兜底重入），其余网络项 `disabled`。
    - 「存储」子菜单（`DropdownMenuSub`，受控 `open`，展开时 `loadStashes`）：「新建存储…」→ 本组件内 `StashDialog`（消息 Input，空则后端合成默认消息）→ `stashSave(projectPath, message)`；分隔线 + 存储列表（`stash@{index}: message`，点击选中、选中项前置 `Check`，非空列表自动选中首项）；「弹出存储」「应用存储」「删除存储」三项作用于选中条目（`selectedStash === null` 或 `busy` 时禁用），删除经 `GitConfirmDialog`（标题「删除存储」，描述含 `stash@{index}` 与消息）→ `stashDrop`。
    - `DropdownMenuCheckboxItem`「显示操作日志」⇄ `opLogOpen`。
  - `OpLogPanel`（同文件导出）：`opLogOpen` 为 false 返回 null；否则底部折叠面板：标题行「操作日志 (N)」+ 「清空」按钮（`clearLog`）+ 收起按钮（`setOpLogOpen(false)`）+ `div`（`max-h-40 overflow-y-auto`）逐行渲染 `opLog`（`font-mono text-[11px]`，格式 `HH:mm:ss 操作：完成/失败 — 消息` 由 T7 store 产出）。
  - `GitPanel.tsx`：头部刷新按钮之后挂 `<GitActionsMenu projectPath={project.path} onOpenBranchSelector={() => setBranchSelectorOpen(true)} />`；Diff viewer 块之后、`BranchSelector` 挂载之前挂 `<OpLogPanel />`。

- [ ] **Step 1: 先写失败测试** — 新建 `src/features/git/GitActionsMenu.test.tsx`：

```tsx
/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

let gitState: {
  opRunning: string | null;
  stashes: { index: number; message: string }[];
  opLog: string[];
  opLogOpen: boolean;
  setOpLogOpen: ReturnType<typeof vi.fn>;
  clearLog: ReturnType<typeof vi.fn>;
  loadStashes: ReturnType<typeof vi.fn>;
  fetch: ReturnType<typeof vi.fn>;
  pull: ReturnType<typeof vi.fn>;
  push: ReturnType<typeof vi.fn>;
  clone: ReturnType<typeof vi.fn>;
  stashSave: ReturnType<typeof vi.fn>;
  stashApply: ReturnType<typeof vi.fn>;
  stashPop: ReturnType<typeof vi.fn>;
  stashDrop: ReturnType<typeof vi.fn>;
};
vi.mock("../../stores/git.store", () => ({
  useGitStore: (selector?: (s: typeof gitState) => unknown) => (selector ? selector(gitState) : gitState),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ setFocus: vi.fn().mockResolvedValue(undefined) }),
}));

import { GitActionsMenu } from "./GitActionsMenu";

beforeEach(() => {
  vi.clearAllMocks();
  gitState = {
    opRunning: null,
    stashes: [],
    opLog: [],
    opLogOpen: false,
    setOpLogOpen: vi.fn(),
    clearLog: vi.fn(),
    loadStashes: vi.fn().mockResolvedValue(undefined),
    fetch: vi.fn().mockResolvedValue(undefined),
    pull: vi.fn().mockResolvedValue(true),
    push: vi.fn().mockResolvedValue(true),
    clone: vi.fn().mockResolvedValue(true),
    stashSave: vi.fn().mockResolvedValue(true),
    stashApply: vi.fn().mockResolvedValue(true),
    stashPop: vi.fn().mockResolvedValue(true),
    stashDrop: vi.fn().mockResolvedValue(true),
  };
});
afterEach(() => cleanup());

const openMenu = async () => {
  render(<GitActionsMenu projectPath="/p" onOpenBranchSelector={() => {}} />);
  // radix DropdownMenuTrigger 只以 onPointerDown/onKeyDown 开启，无 onClick 路径
  fireEvent.pointerDown(screen.getByTitle("更多操作"));
  await screen.findByText("拉取");
};

describe("GitActionsMenu", () => {
  it("renders the remote ops, stash submenu and log toggle", async () => {
    await openMenu();
    expect(screen.getByText("推送")).toBeTruthy();
    expect(screen.getByText("获取")).toBeTruthy();
    expect(screen.getByText("克隆…")).toBeTruthy();
    expect(screen.getByText("存储")).toBeTruthy();
    expect(screen.getByText("显示操作日志")).toBeTruthy();
  });

  it("clicking 拉取 calls store.pull with the project path", async () => {
    await openMenu();
    fireEvent.click(screen.getByText("拉取"));
    expect(gitState.pull).toHaveBeenCalledWith("/p");
  });

  it("a running op shows its spinner and disables the other network items", async () => {
    gitState.opRunning = "推送";
    await openMenu();
    const pushItem = screen.getByText("推送").closest("[role=menuitem]")!;
    expect(pushItem.querySelector("svg.animate-spin")).toBeTruthy();
    expect(pushItem.hasAttribute("data-disabled")).toBe(false);
    const fetchItem = screen.getByText("获取").closest("[role=menuitem]")!;
    expect(fetchItem.hasAttribute("data-disabled")).toBe(true);
  });

  it("dropping a stash goes through the confirm dialog", async () => {
    gitState.stashes = [{ index: 0, message: "wip" }];
    await openMenu();
    fireEvent.click(screen.getByText("存储"));
    fireEvent.click(await screen.findByTestId("stash-0"));
    fireEvent.click(screen.getByTestId("stash-drop"));
    expect(await screen.findByText(/永久删除存储条目 stash@\{0\}/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    await waitFor(() => expect(gitState.stashDrop).toHaveBeenCalledWith("/p", 0));
  });
});
```

- [ ] **Step 2: 跑出红** — `pnpm test src/features/git/GitActionsMenu.test.tsx` 失败（组件不存在）。

- [ ] **Step 3: 扩展 stashSave 签名** — 修改 `src/stores/git.store.ts`（T7 全量版）两处：
  1. `GitStore` 接口内 `stashSave: (projectPath: string) => Promise<boolean>;` 改为：

```ts
  stashSave: (projectPath: string, message?: string) => Promise<boolean>;
```

  2. 实现体 `stashSave: async (projectPath) => { const ok = await runOp("存储", () => gitStashSave(projectPath, ""));` 改为：

```ts
      stashSave: async (projectPath, message) => {
        const ok = await runOp("存储", () => gitStashSave(projectPath, message ?? ""));
```

（函数体余下部分——`if (ok) { refresh + loadStashes } return ok;`——不动。）

- [ ] **Step 4: 最小实现** — 新建 `src/features/git/GitActionsMenu.tsx`：

```tsx
import { useEffect, useState } from "react";
import { Check, ChevronDown, Loader2, MoreHorizontal } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { useGitStore } from "../../stores/git.store";
import type { StashEntry } from "../../bridge/tauri";
import { GitConfirmDialog } from "./GitConfirmDialog";

interface GitActionsMenuProps {
  projectPath: string;
  /** 复用 T9 落在 GitPanel 的 BranchSelector（检出远端分支项）。 */
  onOpenBranchSelector: () => void;
}

/** GitPanel 头部 ··· 菜单：远端操作 / 检出 / 存储子菜单 / 操作日志开关。 */
export function GitActionsMenu({ projectPath, onOpenBranchSelector }: GitActionsMenuProps) {
  const opRunning = useGitStore((s) => s.opRunning);
  const stashes = useGitStore((s) => s.stashes);
  const opLogOpen = useGitStore((s) => s.opLogOpen);
  const setOpLogOpen = useGitStore((s) => s.setOpLogOpen);
  const loadStashes = useGitStore((s) => s.loadStashes);
  const gitFetchOp = useGitStore((s) => s.fetch);
  const gitPullOp = useGitStore((s) => s.pull);
  const gitPushOp = useGitStore((s) => s.push);
  const gitCloneOp = useGitStore((s) => s.clone);
  const stashSave = useGitStore((s) => s.stashSave);
  const stashApply = useGitStore((s) => s.stashApply);
  const stashPop = useGitStore((s) => s.stashPop);
  const stashDrop = useGitStore((s) => s.stashDrop);

  const [cloneOpen, setCloneOpen] = useState(false);
  const [cloneUrl, setCloneUrl] = useState("");
  const [cloneDest, setCloneDest] = useState("");
  const [stashDialogOpen, setStashDialogOpen] = useState(false);
  const [stashMsg, setStashMsg] = useState("");
  const [stashSubOpen, setStashSubOpen] = useState(false);
  const [selectedStash, setSelectedStash] = useState<number | null>(null);
  const [toDrop, setToDrop] = useState<StashEntry | null>(null);

  const busy = opRunning !== null;
  // 进行中的项显示 spinner 但不禁用自身（store runOp 有 opRunning 重入守卫）；
  // 其余网络项在任一操作进行时禁用。
  const isRunning = (op: string) => opRunning === op;
  const othersDisabled = (op: string) => busy && opRunning !== op;

  // 列表刷新后自动选中首条，让弹出/应用/删除开箱即用。
  useEffect(() => {
    if (selectedStash === null && stashes.length > 0) setSelectedStash(stashes[0].index);
  }, [stashes, selectedStash]);

  // 照抄 ProjectSelector.tsx:85 模式：先尽力前台再开原生目录对话框，
  // 否则 Windows 上系统对话框可能落到应用窗口后方。
  const pickCloneDest = async () => {
    await getCurrentWindow().setFocus().catch(() => {});
    const selected = await open({ directory: true, multiple: false, title: "选择克隆目标目录" });
    if (selected && typeof selected === "string") setCloneDest(selected);
  };

  const confirmClone = async () => {
    const url = cloneUrl.trim();
    if (!url || !cloneDest || busy) return;
    const ok = await gitCloneOp(url, cloneDest);
    if (ok) {
      setCloneOpen(false);
      setCloneUrl("");
      setCloneDest("");
    }
  };

  const confirmStashSave = async () => {
    const ok = await stashSave(projectPath, stashMsg.trim());
    if (ok) {
      setStashDialogOpen(false);
      setStashMsg("");
    }
  };

  const spinner = (op: string) => (isRunning(op) ? <Loader2 size={13} className="mr-2 animate-spin" /> : null);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-xs" title="更多操作">
            <MoreHorizontal size={13} />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuItem disabled={othersDisabled("拉取")} onSelect={() => void gitPullOp(projectPath)}>
            {spinner("拉取")}拉取
          </DropdownMenuItem>
          <DropdownMenuItem disabled={othersDisabled("推送")} onSelect={() => void gitPushOp(projectPath)}>
            {spinner("推送")}推送
          </DropdownMenuItem>
          <DropdownMenuItem disabled={othersDisabled("获取")} onSelect={() => void gitFetchOp(projectPath)}>
            {spinner("获取")}获取
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={othersDisabled("克隆")}
            onSelect={() => setCloneOpen(true)}
          >
            {spinner("克隆")}克隆…
          </DropdownMenuItem>
          <DropdownMenuItem disabled={busy} onSelect={onOpenBranchSelector}>
            检出远端分支…
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuSub
            open={stashSubOpen}
            onOpenChange={(o) => {
              setStashSubOpen(o);
              if (o) void loadStashes(projectPath);
            }}
          >
            <DropdownMenuSubTrigger data-testid="stash-subtrigger" onClick={() => setStashSubOpen(true)}>
              存储
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-64">
              <DropdownMenuItem data-testid="stash-new" onSelect={() => setStashDialogOpen(true)}>
                新建存储…
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>存储列表（点选后下方三项作用于选中条目）</DropdownMenuLabel>
              {stashes.map((s) => (
                <DropdownMenuItem key={s.index} data-testid={`stash-${s.index}`} onSelect={(e) => { e.preventDefault(); setSelectedStash(s.index); }}>
                  <span className="mr-1 inline-flex w-3 justify-center">
                    {selectedStash === s.index ? <Check size={12} /> : ""}
                  </span>
                  {`stash@{${s.index}}: ${s.message || "（无消息）"}`}
                </DropdownMenuItem>
              ))}
              {stashes.length === 0 && <DropdownMenuItem disabled>暂无存储条目</DropdownMenuItem>}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                disabled={selectedStash === null || busy}
                onSelect={() => {
                  if (selectedStash !== null) {
                    const idx = selectedStash;
                    // R2：pop 成功后 stash 索引整体前移——清选中让自动选首项接管
                    void stashPop(projectPath, idx).then((ok) => {
                      if (ok) setSelectedStash(null);
                    });
                  }
                }}
              >
                弹出存储
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={selectedStash === null || busy}
                onSelect={() => {
                  if (selectedStash !== null) void stashApply(projectPath, selectedStash);
                }}
              >
                应用存储
              </DropdownMenuItem>
              <DropdownMenuItem
                data-testid="stash-drop"
                disabled={selectedStash === null || busy}
                onSelect={() => {
                  const entry = stashes.find((x) => x.index === selectedStash);
                  if (entry) setToDrop(entry);
                }}
              >
                删除存储
              </DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSeparator />
          <DropdownMenuCheckboxItem checked={opLogOpen} onCheckedChange={(v) => setOpLogOpen(!!v)}>
            显示操作日志
          </DropdownMenuCheckboxItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* 克隆对话框：URL 输入 + 原生目录选择（父目录，后端在其下建同名子目录） */}
      <Dialog open={cloneOpen} onOpenChange={setCloneOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>克隆仓库</DialogTitle>
            <DialogDescription>输入仓库 URL（https / ssh / file），并选择存放的父目录。</DialogDescription>
          </DialogHeader>
          <Input
            autoFocus
            value={cloneUrl}
            onChange={(e) => setCloneUrl(e.target.value)}
            placeholder="https://github.com/user/repo.git"
          />
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-xs text-[var(--text-tertiary)]">
              {cloneDest || "尚未选择目标目录"}
            </span>
            <Button variant="outline" size="sm" onClick={() => void pickCloneDest()}>
              选择目录…
            </Button>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCloneOpen(false)}>
              取消
            </Button>
            <Button disabled={!cloneUrl.trim() || !cloneDest || busy} onClick={() => void confirmClone()}>
              {isRunning("克隆") && <Loader2 size={13} className="mr-2 animate-spin" />}
              克隆
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 新建存储对话框：消息可空，空则后端合成「WIP on <分支>」 */}
      <Dialog open={stashDialogOpen} onOpenChange={setStashDialogOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>新建存储</DialogTitle>
            <DialogDescription>把工作区改动（含未跟踪文件）存入 stash。</DialogDescription>
          </DialogHeader>
          <Input
            autoFocus
            value={stashMsg}
            onChange={(e) => setStashMsg(e.target.value)}
            placeholder="存储消息（可空）"
            onKeyDown={(e) => {
              if (e.key === "Enter") void confirmStashSave();
            }}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setStashDialogOpen(false)}>
              取消
            </Button>
            <Button disabled={busy} onClick={() => void confirmStashSave()}>
              {isRunning("存储") && <Loader2 size={13} className="mr-2 animate-spin" />}
              存储
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <GitConfirmDialog
        open={toDrop !== null}
        title="删除存储"
        description={`永久删除存储条目 stash@{${toDrop?.index ?? ""}}「${toDrop?.message ?? ""}」？此操作不可撤销。`}
        confirmLabel="删除"
        busy={busy}
        onCancel={() => setToDrop(null)}
        onConfirm={async () => {
          // R2：await 期间保持确认框打开渲染 busy；成功后关框并清选中（索引前移）
          const entry = toDrop;
          if (!entry) return;
          const ok = await stashDrop(projectPath, entry.index);
          if (ok) {
            setToDrop(null);
            setSelectedStash(null);
          }
        }}
      />
    </>
  );
}

/** 底部操作日志折叠面板：由菜单「显示操作日志」切换；100 条上限由 T7 store 裁剪。 */
export function OpLogPanel() {
  const opLog = useGitStore((s) => s.opLog);
  const opLogOpen = useGitStore((s) => s.opLogOpen);
  const setOpLogOpen = useGitStore((s) => s.setOpLogOpen);
  const clearLog = useGitStore((s) => s.clearLog);

  if (!opLogOpen) return null;
  return (
    <div className="border-t border-[color:var(--border-subtle)]">
      <div className="flex items-center gap-2 px-3 py-1.5 text-xs text-[var(--text-tertiary)]">
        <span>操作日志 ({opLog.length})</span>
        <div className="flex-1" />
        <button
          title="清空日志"
          className="rounded px-1 py-0.5 transition-colors duration-100 hover:bg-[var(--overlay-hover)] hover:text-[var(--text-primary)]"
          onClick={clearLog}
        >
          清空
        </button>
        <button
          title="收起"
          className="rounded p-0.5 transition-colors duration-100 hover:bg-[var(--overlay-hover)] hover:text-[var(--text-primary)]"
          onClick={() => setOpLogOpen(false)}
        >
          <ChevronDown size={12} />
        </button>
      </div>
      <div className="max-h-40 overflow-y-auto">
        <div className="space-y-0.5 px-3 pb-2 font-mono text-[11px] leading-relaxed text-[var(--text-secondary)]">
          {opLog.length === 0 ? (
            <div className="text-[var(--text-tertiary)]">暂无操作记录</div>
          ) : (
            opLog.map((line, i) => <div key={`${i}-${line}`}>{line}</div>)
          )}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: 跑出绿** — `pnpm test src/features/git/GitActionsMenu.test.tsx` 四个用例全过；`pnpm test src/stores/git.store.test.ts` 保持全过（`stashSave` 新参数可选，T7 用例不受影响）。

- [ ] **Step 6: GitPanel 接入** — 修改 `src/features/git/GitPanel.tsx`（T11 完成后的形态）：
  1. import 区追加：`import { GitActionsMenu, OpLogPanel } from "./GitActionsMenu";`
  2. 头部刷新按钮（T9 版，`<Button variant="ghost" size="icon-xs" title="刷新" …>` 整块）之后插入：

```tsx
        <GitActionsMenu projectPath={project.path} onOpenBranchSelector={() => setBranchSelectorOpen(true)} />
```

  3. 在 Diff viewer 块（`{diff && diffFile && (…)}`）之后、`<BranchSelector …>` 挂载之前插入：

```tsx
      <OpLogPanel />
```

- [ ] **Step 7: 门槛** — `pnpm lint && pnpm build && pnpm test` 全绿（warning 数保持 6）。

- [ ] **Step 8: 提交** —

```
git add src/features/git/GitActionsMenu.tsx src/features/git/GitActionsMenu.test.tsx src/stores/git.store.ts src/features/git/GitPanel.tsx
git commit -m "feat(git): ··· 操作菜单——远端操作、存储子菜单与操作日志面板"
```

---

### Task 13: 提交历史（折叠历史区 + 挂载自动加载 + 点击占位 + Plan 4 接口注记）

**Files:**
- Create: `src/features/git/HistorySection.tsx`、`src/features/git/HistorySection.test.tsx`
- Modify: `src/stores/git.store.test.ts`（追加 `loadHistory` 两个用例）、`src/features/git/GitPanel.tsx`（挂载历史区）

**Interfaces:**
- Consumes:
  - T6 桥接：`gitLog(projectPath, limit): Promise<CommitInfo[]>` 封装（**T6 Step 3 已定义**，已核实在计划 L1620——本任务不重复补写；`COMMANDS.GIT_LOG` 常量现状在 commands.ts:30）与类型 `CommitInfo { hash, message, author, time }`。字段实况：后端 `get_log` 以 `c.time().seconds()` 输出 **Unix 秒**、hash 截前 7 位、message 取 `summary()`（已是首行）、author 取 `name()`。
  - T7 store：`commits: CommitInfo[]`、`historyLoading`、`historyOpen`/`setHistoryOpen`、`loadHistory(projectPath)`（内部 `gitLog(projectPath, 20)`、`historyLoading` 门控、失败写共享 `error`）、`openCommitDiff(projectPath, commitHash, path?)`。**store 本任务零改动**——这些状态与动作 T7 已全量实现（含 `loadHistory` 实现体），此处仅消费并补其测试覆盖。
- Produces:
  - `HistorySection`：`{ projectPath }`——底部折叠「历史」区：组头（ChevronRight 旋转指示 + 「历史」+ 计数 + 刷新按钮，`historyLoading` 时 RefreshCw `animate-spin`，点击 `stopPropagation`）切换 store `historyOpen`；展开内容 `max-h-56` 滚动，每行：短哈希（`font-mono`、accent 色）+ message + 作者 + 相对时间（模块内 `relTime(unixSeconds)`：<60s「刚刚」、<1h「N 分钟前」、<24h「N 小时前」、否则「N 天前」）；空列表显示「暂无提交历史」。
  - 挂载自动加载：组件内 `useEffect`——`commits.length === 0` **或 projectPath 变化**（`useRef` 记前值比较，R1 防跨项目串显）时 `loadHistory(projectPath)`（deps `[projectPath, commits.length, loadHistory]`；`loadHistory` 为 zustand 建 store 时创建的稳定引用；加载成功后 `commits.length` 变非零，effect 重跑但两条件皆不满足、不重复请求）。GitPanel 挂载本组件即得此行为。
  - 点击占位行为：行点击 → 本地 `selectedCommit` 高亮 + 调 `openCommitDiff(projectPath, c.hash)`。
  - **Plan 4 预留接口注记**：`openCommitDiff(projectPath: string, commitHash: string, path?: string): void` 已由 T7 定义并落占位实现（转发既有内联 diff 槽 `viewDiff(projectPath, path ?? "", false)`）；**Plan 4 将替换其实现**为编辑器只读 diff 标签（后端新增 `git_diff_commit` + `fs.store.diffTabs`，见 spec F3），本计划不实现编辑器 diff。本任务只保证调用点就位、注释标明替换位置。

- [ ] **Step 1: 先写失败测试 — store 层** — 在 `src/stores/git.store.test.ts`（T7 所建，`gitLogMock` 已在该文件 mock 工厂中就位）末尾追加：

```ts
describe("git.store loadHistory", () => {
  it("stores commits returned by gitLog", async () => {
    gitLogMock.mockResolvedValue([{ hash: "abc1234", message: "init", author: "a", time: 1 }]);
    await useGitStore.getState().loadHistory("/p");
    expect(gitLogMock).toHaveBeenCalledWith("/p", 20);
    expect(useGitStore.getState().commits).toHaveLength(1);
    expect(useGitStore.getState().historyLoading).toBe(false);
  });

  it("records the backend error on failure", async () => {
    gitLogMock.mockRejectedValue({ type: "Git", message: "reference not found" });
    await useGitStore.getState().loadHistory("/p");
    expect(useGitStore.getState().error).toBe("reference not found");
    expect(useGitStore.getState().commits).toHaveLength(0);
    expect(useGitStore.getState().historyLoading).toBe(false);
  });
});
```

- [ ] **Step 2: 先写失败测试 — 组件层** — 新建 `src/features/git/HistorySection.test.tsx`：

```tsx
/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

let gitState: {
  commits: { hash: string; message: string; author: string; time: number }[];
  historyLoading: boolean;
  historyOpen: boolean;
  setHistoryOpen: ReturnType<typeof vi.fn>;
  loadHistory: ReturnType<typeof vi.fn>;
  openCommitDiff: ReturnType<typeof vi.fn>;
};
vi.mock("../../stores/git.store", () => ({
  useGitStore: (selector?: (s: typeof gitState) => unknown) => (selector ? selector(gitState) : gitState),
}));

import { HistorySection } from "./HistorySection";

const NOW_S = Math.floor(Date.now() / 1000);
const COMMIT = { hash: "abc1234", message: "fix: bug", author: "张三", time: NOW_S - 3600 };

beforeEach(() => {
  vi.clearAllMocks();
  gitState = {
    commits: [],
    historyLoading: false,
    historyOpen: true,
    setHistoryOpen: vi.fn(),
    loadHistory: vi.fn().mockResolvedValue(undefined),
    openCommitDiff: vi.fn(),
  };
});
afterEach(() => cleanup());

describe("HistorySection", () => {
  it("auto-loads on mount only when the history is empty", () => {
    render(<HistorySection projectPath="/p" />);
    expect(gitState.loadHistory).toHaveBeenCalledWith("/p");

    cleanup();
    gitState.commits = [COMMIT];
    render(<HistorySection projectPath="/p" />);
    // 第二次挂载时 commits 非空：仍是同一次调用，未重复请求
    expect(gitState.loadHistory).toHaveBeenCalledTimes(1);
  });

  it("reloads when the project path changes even if history is non-empty (R1)", () => {
    gitState.commits = [COMMIT];
    const utils = render(<HistorySection projectPath="/a" />);
    // commits 非空且路径未变 → 不加载
    expect(gitState.loadHistory).not.toHaveBeenCalled();
    utils.rerender(<HistorySection projectPath="/b" />);
    expect(gitState.loadHistory).toHaveBeenCalledWith("/b");
  });

  it("renders commit rows with hash, message, author and relative time", () => {
    gitState.commits = [COMMIT];
    render(<HistorySection projectPath="/p" />);
    expect(screen.getByText("abc1234")).toBeTruthy();
    expect(screen.getByText("fix: bug")).toBeTruthy();
    expect(screen.getByText("张三")).toBeTruthy();
    expect(screen.getByText("1 小时前")).toBeTruthy();
  });

  it("header click toggles the collapsed state via the store", () => {
    gitState.commits = [COMMIT];
    render(<HistorySection projectPath="/p" />);
    fireEvent.click(screen.getByText("历史"));
    expect(gitState.setHistoryOpen).toHaveBeenCalledWith(false);
  });

  it("clicking a commit highlights it and invokes the Plan 4 placeholder", () => {
    gitState.commits = [COMMIT];
    render(<HistorySection projectPath="/p" />);
    fireEvent.click(screen.getByTestId("commit-abc1234"));
    expect(gitState.openCommitDiff).toHaveBeenCalledWith("/p", "abc1234");
    expect(screen.getByTestId("commit-abc1234").className).toContain("accent");
  });
});
```

- [ ] **Step 3: 跑出红** — `pnpm test src/stores/git.store.test.ts src/features/git/HistorySection.test.tsx` 中组件测试失败（`HistorySection` 不存在）；store 两个用例此时应已为绿（T7 已实现 `loadHistory`，此步只是把覆盖落盘）。

- [ ] **Step 4: 最小实现** — 新建 `src/features/git/HistorySection.tsx`：

```tsx
import { useEffect, useRef, useState } from "react";
import { ChevronRight, RefreshCw } from "lucide-react";
import { useGitStore } from "../../stores/git.store";

/**
 * 相对时间。后端 CommitInfo.time 为 Unix 秒（repository::get_log 取
 * c.time().seconds()），故先除以 1000 再作差。
 */
function relTime(unixSeconds: number): string {
  const delta = Math.max(0, Math.floor(Date.now() / 1000) - unixSeconds);
  if (delta < 60) return "刚刚";
  if (delta < 3600) return `${Math.floor(delta / 60)} 分钟前`;
  if (delta < 86400) return `${Math.floor(delta / 3600)} 小时前`;
  return `${Math.floor(delta / 86400)} 天前`;
}

/** 底部可折叠提交历史区；数据走 T7 loadHistory（gitLog 封装 T6 已定义）。 */
export function HistorySection({ projectPath }: { projectPath: string }) {
  const commits = useGitStore((s) => s.commits);
  const historyLoading = useGitStore((s) => s.historyLoading);
  const historyOpen = useGitStore((s) => s.historyOpen);
  const setHistoryOpen = useGitStore((s) => s.setHistoryOpen);
  const loadHistory = useGitStore((s) => s.loadHistory);
  const openCommitDiff = useGitStore((s) => s.openCommitDiff);

  const [selectedCommit, setSelectedCommit] = useState<string | null>(null);

  // GitPanel 挂载时若历史为空自动加载一次；项目切换则无条件重载——
  // commits 是全局 store 字段、切项目不清空（R1：只按「空」判定会让 B 项目
  // 显示 A 项目的提交，点击还拿 A 的 hash 配 B 的路径出错）。
  const prevPath = useRef(projectPath);
  useEffect(() => {
    const projectChanged = prevPath.current !== projectPath;
    prevPath.current = projectPath;
    if (commits.length === 0 || projectChanged) void loadHistory(projectPath);
  }, [projectPath, commits.length, loadHistory]);

  return (
    <div className="border-t border-[color:var(--border-subtle)]">
      <div
        className="flex cursor-pointer items-center gap-1.5 px-3 py-2 text-xs text-[var(--text-tertiary)] hover:bg-[var(--overlay-hover)]"
        onClick={() => setHistoryOpen(!historyOpen)}
      >
        <ChevronRight size={12} className={`transition-transform duration-150 ${historyOpen ? "rotate-90" : ""}`} />
        <span className="font-medium">历史</span>
        {commits.length > 0 && <span>({commits.length})</span>}
        <div className="flex-1" />
        <button
          title="刷新历史"
          className="rounded p-0.5 transition-colors duration-100 hover:bg-[var(--overlay-hover)] hover:text-[var(--text-primary)]"
          onClick={(e) => {
            e.stopPropagation();
            void loadHistory(projectPath);
          }}
        >
          <RefreshCw size={12} className={historyLoading ? "animate-spin" : ""} />
        </button>
      </div>
      {historyOpen && (
        <div className="max-h-56 overflow-y-auto pb-1">
          {commits.length === 0 && (
            <div className="px-3 py-1.5 text-xs text-[var(--text-tertiary)]">暂无提交历史</div>
          )}
          {commits.map((c) => (
            <div
              key={c.hash}
              data-testid={`commit-${c.hash}`}
              className={`flex cursor-pointer items-baseline gap-2 px-3 py-1 text-xs transition-colors duration-100 hover:bg-[var(--overlay-hover)] ${
                selectedCommit === c.hash ? "bg-[var(--accent)]/15" : ""
              }`}
              onClick={() => {
                setSelectedCommit(c.hash);
                // Plan 4 将把 T7 的占位实现替换为编辑器只读 diff 标签
                //（git_diff_commit + fs.store.diffTabs）；现状转发内联 diff 槽。
                openCommitDiff(projectPath, c.hash);
              }}
            >
              <span className="shrink-0 font-mono text-[var(--accent)]">{c.hash}</span>
              <span className="min-w-0 flex-1 truncate text-[var(--text-secondary)]">{c.message}</span>
              <span className="shrink-0 text-[var(--text-tertiary)]">{c.author}</span>
              <span className="shrink-0 text-[var(--text-tertiary)]">{relTime(c.time)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 5: 跑出绿** — `pnpm test src/stores/git.store.test.ts src/features/git/HistorySection.test.tsx` 全过（store 11 例、组件 4 例）。

- [ ] **Step 6: GitPanel 接入** — 修改 `src/features/git/GitPanel.tsx`（T12 完成后的形态）：
  1. import 区追加：`import { HistorySection } from "./HistorySection";`
  2. 在 Diff viewer 块之后、T12 挂载的 `<OpLogPanel />` 之前插入：

```tsx
      <HistorySection projectPath={project.path} />
```

（至此 GitPanel 纵向布局：头部（分支按钮 + ↑↓ 徽标 + 刷新 + ··· 菜单）→ 错误条 → ChangesSection（flex-1）→ CommitSection → Diff viewer → HistorySection → OpLogPanel → BranchSelector。）

- [ ] **Step 7: 门槛** — `pnpm lint && pnpm build && pnpm test` 全绿（warning 数保持 6）。

- [ ] **Step 8: 提交** —

```
git add src/features/git/HistorySection.tsx src/features/git/HistorySection.test.tsx src/stores/git.store.test.ts src/features/git/GitPanel.tsx
git commit -m "feat(git): 提交历史折叠区与挂载自动加载"
```

---

### Task 14: 全量门槛 + 计划-实现 diff 自检 + 手工冒烟清单

**Files:**
- 无代码改动（纯验证任务）。冒烟中发现的缺陷就地修复，按 `fix(git): 中文描述` 单独小提交，不与验证混提。

**Interfaces:**
- Consumes: T1–T13 全部产出；spec `docs/superpowers/specs/2026-07-30-vscode-ux-alignment-design.md`「## 验收」Git 条与 F2 面板结构条目。
- Produces: 一次全绿门槛记录 + 一份逐条冒烟结果（发现即修）。

- [ ] **Step 1: 前端全量门槛** — 运行：

```
pnpm lint && pnpm build && pnpm test
```

预期：
- `pnpm test` 报 **155 个用例全过**＝既有基线 108 + 本计划新增 47。新增分布逐文件核对：T7 `src/stores/git.store.test.ts` +11（loading 粒度 2 / opLog 3 / commitWith 3 / push 守卫 1 / 空数组守卫 2）+ T13 同文件再 +2（loadHistory 成功/失败）；T8 `GitCredentialModal.test.tsx` +6；T9 `BranchSelector.test.tsx` +4；T10 `CommitSection.test.tsx` +4、`registry.run.test.ts` +3、`KeybindingHost.test.tsx` +2；T11 `ChangesSection.test.tsx` +6；T12 `GitActionsMenu.test.tsx` +4；T13 `HistorySection.test.tsx` +5（含 R1 跨项目重载锁定）。任一文件用例数与此不符，说明前序任务有漏写，回对应任务补齐再重跑。
- `pnpm lint` warning 数保持 **6**（既有基线），零新增 error。
- `pnpm build`（tsc + vite）零错误——T6 四处命名契约（git_cmds.rs / lib.rs / commands.ts / tauri.ts）的类型一致性在此最终把关。

- [ ] **Step 2: 后端全量门槛** — 运行：

```
cargo test --manifest-path src-tauri/Cargo.toml
```

预期全绿，且 `git_test.rs` 全部用例在列：T1 分支四连（list/checkout/create/delete，含 detached HEAD 与脏工作区错误文案）、T2 `discard_restores_tracked_and_removes_untracked` / `discard_restores_to_staged_version_not_head` / revert_staged 用例、T3 stash 五连用例（save 清工作区含未跟踪 / 空消息合成 `WIP on` / pop 还原并删条目 / apply 保留条目 / drop）、T4 broker 单测（会话缓存命中 / GUI 请求-应答握手 / 超时取消）、T5 `push_pull_round_trip_over_local_bare_remote`（含非快进中文拒绝断言 `推送被拒绝`）与 `clone_creates_working_copy`；既有 `db_test` / `fs_test` 不受影响。

- [ ] **Step 3: 计划-实现 diff 自检** — 运行：

```
git diff main...HEAD --stat
git diff main...HEAD --name-only | sort
```

将 `--name-only` 输出与下列预期集合逐行对照（＝T1–T13 各任务 **Files:** 段去重并集，共 34 个文件）：

```
src-tauri/src/commands/git_cmds.rs
src-tauri/src/git/credentials.rs
src-tauri/src/git/mod.rs
src-tauri/src/git/network.rs
src-tauri/src/git/repository.rs
src-tauri/src/git/types.rs
src-tauri/src/lib.rs
src-tauri/tests/git_test.rs
src/App.tsx
src/bridge/commands.ts
src/bridge/events.ts
src/bridge/tauri.ts
src/commands/KeybindingHost.test.tsx
src/commands/KeybindingHost.tsx
src/commands/registry.run.test.ts
src/commands/registry.test.ts
src/commands/registry.ts
src/features/git/BranchSelector.test.tsx
src/features/git/BranchSelector.tsx
src/features/git/ChangesSection.test.tsx
src/features/git/ChangesSection.tsx
src/features/git/CommitSection.test.tsx
src/features/git/CommitSection.tsx
src/features/git/GitActionsMenu.test.tsx
src/features/git/GitActionsMenu.tsx
src/features/git/GitConfirmDialog.tsx
src/features/git/GitCredentialModal.test.tsx
src/features/git/GitCredentialModal.tsx
src/features/git/GitPanel.tsx
src/features/git/HistorySection.test.tsx
src/features/git/HistorySection.tsx
src/features/git/credentialRequest.store.ts
src/stores/git.store.test.ts
src/stores/git.store.ts
```

验收规则：
1. 无集合外文件——出现 `src/features/search/`、设置弹窗、编辑器面板等路径即越界（属 Plan 4–6），须 `git checkout` 撤回或拆出。
2. 集合内无缺项——缺文件说明某任务步骤漏做，回补。
3. 残留检查：`git diff main...HEAD | grep -nE "console\.log|dbg!|FIXME"` 应无输出（计划文本内的代码块不含这些，命中即真实残留）。

- [ ] **Step 4: 手工冒烟清单** — 桌面端 `pnpm tauri dev` 启动。预备：一个带远端的测试仓库（本地 bare 仓库作 origin 即可验 push/pull/fetch/非快进；https 凭据弹窗用任一需要认证的 https 远端；ssh 弹窗用一把带口令的 ed25519 私钥配 `git@` 远端）。逐条执行并记录结果，覆盖 spec「## 验收」Git 项全部要素：

分支（T1/T9）：
1. 点头部分支按钮 → BranchSelector 打开，「本地」「远程」分组渲染，当前分支带 ✓。
2. 点击非当前本地分支 → 切换成功、头部分支名更新、选择器自动关闭。
3. 「新建分支…」→ 输入名 → 创建 → 自动签出新分支并关闭。
4. hover 非 HEAD 本地分支 → 垃圾桶出现 → 点击弹确认对话框 → 确认删除 → 列表中消失。

更改组（T2/T11）：
5. 工作区制造 修改/新增/删除/未跟踪 四类文件 → 「更改」「暂存的更改」两组计数正确；状态字母 M/A/D/U 着色正确（M 黄、A 绿、D 红、U 绿）。
6. 单行 hover 出 4 图标：打开文件（编辑器开页签）、打开 diff（底部内联窗格，+/- 着色、二进制中文占位）、暂存/取消暂存（文件在两组间移动）、丢弃。
7. 组头「全部暂存」/「全部取消暂存」整组生效。
8. 丢弃未跟踪文件 → 确认对话框 → 磁盘删除；丢弃已跟踪改动 → 还原到暂存版本。
9. 「还原暂存更改」（整组与单行）→ 确认 → index 与工作区同回 HEAD。
10. 右上角切换树视图：文件按目录分层、目录行可折叠/展开；切回列表视图恢复全相对路径。

提交（T10）：
11. 输入消息点「提交」→ 提交成功、消息清空、列表刷新、opLog 记「提交：完成」。
12. 提交框内 Ctrl+Enter 提交（scm.commit 命令路径）；裸 Enter 亦提交；空消息时按钮禁用。
13. 分裂按钮「提交并推送」「提交并同步（拉取后推送）」可用。

远端（T5/T6/T7/T12）：
14. ··· 菜单 → 获取/拉取/推送：进行中该项显示 spinner、其余网络项禁用；完成后操作日志记完成行。
15. 制造非快进（远端先进一步）再推送 → 错误条显示「推送被拒绝：非快进，请先拉取合并」；拉取后推送成功。
16. 拉取脏工作区快进场景 → 报错「请先提交或存储改动后再拉取」。
17. 克隆… → 输入 URL、选目标父目录（原生目录对话框）→ 克隆成功并记日志。

存储（T3/T12）：
18. ··· → 存储 → 新建存储…（带消息）→ 工作区清空、子菜单列表出现 `stash@{0}: <消息>`。
19. 选中条目 → 应用存储 → 改动恢复、条目保留；弹出存储 → 恢复且条目消失。
20. 删除存储 → 确认对话框（含 `stash@{index}` 与消息）→ 条目消失。

凭据（T4/T5/T8）：
21. 向需认证 https 远端推送 → 弹「Git 认证」：host、可编辑用户名（预填 hint）、标签「密码 / 访问令牌」→ 输入正确凭据 → 推送成功。
22. 勾选「本次会话记住（仅内存）」再推一次 → 同 host 不再弹窗（会话缓存命中）。
23. ssh 远端 + 带口令私钥 → 弹窗无用户名字段、标签为「密钥口令」→ 输入口令 → 成功。
24. 凭据弹窗点取消 → 后端认证失败、错误条与操作日志文案可读。

历史与日志（T7/T12/T13）：
25. 面板挂载后「历史」区自动加载一次（不重复请求）；刷新按钮可用；每行显示短哈希 + message 首行 + 作者 + 相对时间。
26. 点击提交 → 行高亮；（Plan 4 将改为编辑器只读 diff 标签，本计划为内联 diff 占位，注释已在调用点标明。）
27. 「显示操作日志」勾选 → 底部面板展开；失败行含中文原因；清空按钮生效；连续操作超 100 条时最早条目被裁掉（store 环形缓冲）。

多项目（R1 回归）：
28. 双项目切换（需预备第二个 git 仓库）：项目 A 已加载分支列表与提交历史后切到项目 B → 分支按钮、历史区、更改列表均显示 B 的内容，无 A 的旧数据串显（R1）；B 的历史条目点击行为正常。

- [ ] **Step 5: 收尾** — 本任务无计划内代码改动：工作树干净则跳过提交；冒烟中修复的缺陷按 `fix(git): 中文描述` 分别小提交，每条修复重跑 Step 1/2 门槛确认不回归。全清单通过后，本计划（Plan 3）完结。

---
