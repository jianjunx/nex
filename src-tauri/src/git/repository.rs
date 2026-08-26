use super::types::*;
use crate::error::NexError;
use git2::{DiffFormat, ErrorClass, ErrorCode, Repository, StatusOptions};
use std::path::Path;

/// Cheap probe: does `path` look like a git worktree or a bare repo?
///
/// Used to skip libgit2 entirely on folders that were never `git init`'d, so
/// opening a project cannot surface `could not find repository … NotFound`.
pub fn has_git_metadata(path: &Path) -> bool {
    let git = path.join(".git");
    if git.exists() {
        return true;
    }
    // Bare repository opened as the project folder (HEAD + objects + refs).
    path.join("HEAD").is_file() && path.join("objects").is_dir() && path.join("refs").is_dir()
}

/// True when libgit2 failed because `path` is not a git repository.
/// Scoped to `Repository::open` only — `NotFound` elsewhere means a missing
/// ref/object, not a missing repo.
fn is_repository_not_found(err: &git2::Error) -> bool {
    err.code() == ErrorCode::NotFound
        || (err.class() == ErrorClass::Repository
            && err.message().contains("could not find repository"))
}

/// Open the repo at `path`. `Ok(None)` means the directory has no git
/// metadata — probe callers (status / log / branches) treat that as empty,
/// not as an error.
fn open_repo(path: &Path) -> Result<Option<Repository>, NexError> {
    if !has_git_metadata(path) {
        return Ok(None);
    }
    match Repository::open(path) {
        Ok(repo) => Ok(Some(repo)),
        Err(e) if is_repository_not_found(&e) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

fn require_repo(path: &Path) -> Result<Repository, NexError> {
    open_repo(path)?.ok_or_else(|| NexError::Git("当前项目不是 Git 仓库".into()))
}

/// `None` when `repo_path` is not a git repository (no `.git`).
pub fn get_status(repo_path: &Path) -> Result<Option<GitStatus>, NexError> {
    let Some(repo) = open_repo(repo_path)? else {
        return Ok(None);
    };
    let head = repo.head().ok();
    let branch = head
        .as_ref()
        .and_then(|h| h.shorthand().map(|s| s.to_string()))
        .unwrap_or_else(|| "HEAD".to_string());

    // Best-effort ahead/behind against the upstream tracking branch.
    let (ahead, behind) = match repo.head() {
        Ok(head_ref) => {
            let local = head_ref.target();
            let upstream = head_ref
                .shorthand()
                .and_then(|name| repo.find_branch(name, git2::BranchType::Local).ok())
                .and_then(|b| b.upstream().ok())
                .and_then(|u| u.get().target());
            match (local, upstream) {
                (Some(l), Some(u)) => {
                    let (a, b) = repo.graph_ahead_behind(l, u).unwrap_or((0, 0));
                    (a as u32, b as u32)
                }
                _ => (0, 0),
            }
        }
        Err(_) => (0, 0),
    };

    let mut opts = StatusOptions::new();
    opts.include_untracked(true).recurse_untracked_dirs(true);
    let statuses = repo.statuses(Some(&mut opts))?;

    let mut files = Vec::new();
    for entry in statuses.iter() {
        let path = entry.path().unwrap_or("").to_string();
        let s = entry.status();

        if s.is_index_new() || s.is_index_modified() || s.is_index_deleted() {
            let status = if s.is_index_new() {
                "added"
            } else if s.is_index_deleted() {
                "deleted"
            } else {
                "modified"
            };
            files.push(GitFileChange {
                path: path.clone(),
                status: status.to_string(),
                staged: true,
            });
        }
        if s.is_wt_modified() || s.is_wt_deleted() || s.is_wt_new() {
            let status = if s.is_wt_new() {
                "untracked"
            } else if s.is_wt_deleted() {
                "deleted"
            } else {
                "modified"
            };
            files.push(GitFileChange {
                path,
                status: status.to_string(),
                staged: false,
            });
        }
    }

    Ok(Some(GitStatus {
        branch,
        ahead,
        behind,
        files,
    }))
}

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

pub fn get_diff(repo_path: &Path, file: &str, staged: bool) -> Result<String, NexError> {
    let repo = require_repo(repo_path)?;
    let mut opts = git2::DiffOptions::new();
    opts.pathspec(file);

    let diff = if staged {
        // Staged changes: HEAD tree vs index (empty tree when HEAD is unborn).
        let head_tree = repo.head().ok().and_then(|h| h.peel_to_tree().ok());
        repo.diff_tree_to_index(head_tree.as_ref(), None, Some(&mut opts))?
    } else {
        // Unstaged changes: index vs workdir, including untracked file contents.
        opts.include_untracked(true);
        repo.diff_index_to_workdir(None, Some(&mut opts))?
    };

    render_patch(&diff)
}

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
pub fn get_diff_contents(
    repo_path: &Path,
    file: &str,
    staged: bool,
) -> Result<DiffContents, NexError> {
    let repo = require_repo(repo_path)?;

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
        let workdir = repo
            .workdir()
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
    let repo = require_repo(repo_path)?;
    let obj = repo.revparse_single(&format!("{hash}^{{commit}}"))?;
    let commit = obj.peel_to_commit()?;
    let parent_tree = commit.parent(0).ok().and_then(|p| p.tree().ok());
    let tree = commit.tree()?;
    let diff = repo.diff_tree_to_tree(parent_tree.as_ref(), Some(&tree), None)?;
    render_patch(&diff)
}

pub fn get_log(repo_path: &Path, limit: usize) -> Result<Vec<CommitInfo>, NexError> {
    let Some(repo) = open_repo(repo_path)? else {
        return Ok(Vec::new());
    };
    // Fresh repo with no commits yet: HEAD is unborn, so there is simply
    // no history — return an empty list instead of erroring.
    if repo.head().is_err() {
        return Ok(Vec::new());
    }
    let mut walk = repo.revwalk()?;
    walk.push_head()?;
    walk.set_sorting(git2::Sort::TIME)?;

    let commits: Vec<CommitInfo> = walk
        .flatten()
        .take(limit)
        .filter_map(|oid| repo.find_commit(oid).ok())
        .map(|c| CommitInfo {
            hash: c.id().to_string()[..7].to_string(),
            message: c.summary().unwrap_or("").to_string(),
            author: c.author().name().unwrap_or("").to_string(),
            time: c.time().seconds(),
        })
        .collect();

    Ok(commits)
}

pub fn stage_files(repo_path: &Path, files: &[String]) -> Result<(), NexError> {
    let repo = require_repo(repo_path)?;
    let workdir = repo
        .workdir()
        .ok_or_else(|| NexError::Git("cannot stage files in a bare repository".to_string()))?;
    let mut index = repo.index()?;
    for file in files {
        let path = std::path::Path::new(file);
        if workdir.join(path).exists() {
            index.add_path(path)?;
        } else {
            // File is gone from the workdir: staging records the deletion.
            index.remove_path(path)?;
        }
    }
    index.write()?;
    Ok(())
}

pub fn unstage_files(repo_path: &Path, files: &[String]) -> Result<(), NexError> {
    let repo = require_repo(repo_path)?;
    match repo.head() {
        Ok(head) => {
            // Reset the index entries for these paths back to HEAD.
            let target = head.peel(git2::ObjectType::Commit)?;
            repo.reset_default(Some(&target), files.iter().map(String::as_str))?;
        }
        Err(_) => {
            // Unborn HEAD: unstaging an added file means dropping its index entry.
            let mut index = repo.index()?;
            for file in files {
                index.remove_path(std::path::Path::new(file))?;
            }
            index.write()?;
        }
    }
    Ok(())
}

pub fn commit(repo_path: &Path, message: &str) -> Result<String, NexError> {
    let repo = require_repo(repo_path)?;
    let mut index = repo.index()?;
    let tree_id = index.write_tree()?;
    let tree = repo.find_tree(tree_id)?;
    let sig = repo.signature()?;
    // Unborn HEAD (fresh repo): the first commit has no parents.
    let parents = match repo.head().and_then(|h| h.peel_to_commit()) {
        Ok(head) => vec![head],
        Err(_) => Vec::new(),
    };
    // Reject no-op commits: staging identical to HEAD would silently create
    // an empty commit (git CLI refuses this without --allow-empty).
    if let Some(parent) = parents.first() {
        if parent.tree_id() == tree_id {
            return Err(NexError::Git("暂存区为空：没有可提交的更改".to_string()));
        }
    }
    let parent_refs: Vec<&git2::Commit> = parents.iter().collect();
    let oid = repo.commit(Some("HEAD"), &sig, &sig, message, &tree, &parent_refs)?;
    Ok(oid.to_string())
}

fn branch_tip_time(branch: &git2::Branch<'_>) -> Option<i64> {
    branch
        .get()
        .peel_to_commit()
        .ok()
        .map(|c| c.time().seconds())
}

pub fn list_branches(repo_path: &Path) -> Result<Vec<BranchInfo>, NexError> {
    let Some(repo) = open_repo(repo_path)? else {
        return Ok(Vec::new());
    };
    let mut out = Vec::new();

    for entry in repo.branches(Some(git2::BranchType::Local))? {
        let (branch, _) = entry?;
        let name = branch.name()?.unwrap_or("").to_string();
        let is_head = branch.is_head();
        let tip_time = branch_tip_time(&branch);
        // ahead/behind is only meaningful for the HEAD branch against its
        // upstream; every other branch reports None (UI shows badges once).
        let (ahead, behind) = if is_head {
            branch
                .upstream()
                .ok()
                .and_then(|u| u.get().target())
                .zip(branch.get().target())
                .map(|(u, l)| {
                    let (a, b) = repo.graph_ahead_behind(l, u).unwrap_or((0, 0));
                    (Some(a as u32), Some(b as u32))
                })
                .unwrap_or((None, None))
        } else {
            (None, None)
        };
        out.push(BranchInfo {
            name,
            is_head,
            is_remote: false,
            ahead,
            behind,
            tip_time,
        });
    }

    for entry in repo.branches(Some(git2::BranchType::Remote))? {
        let (branch, _) = entry?;
        let name = branch.name()?.unwrap_or("").to_string();
        let tip_time = branch_tip_time(&branch);
        out.push(BranchInfo {
            name,
            is_head: false,
            is_remote: true,
            ahead: None,
            behind: None,
            tip_time,
        });
    }

    Ok(out)
}

pub fn checkout_branch(repo_path: &Path, name: &str) -> Result<(), NexError> {
    let repo = require_repo(repo_path)?;

    // 远程跟踪分支（如 origin/feature）：同步为本地同名分支并签出，
    // 而不是进入分离 HEAD（旧行为）。本地已存在则直接签出本地分支。
    if repo.find_branch(name, git2::BranchType::Remote).is_ok() {
        return checkout_remote_as_local(repo_path, name);
    }

    checkout_local_ref(&repo, name)
}

/// 从 `origin/foo/bar` 解析本地名 `foo/bar`（按已配置 remote 前缀剥离）。
fn local_name_from_remote_branch(
    repo: &Repository,
    remote_branch: &str,
) -> Result<String, NexError> {
    let remotes = repo
        .remotes()
        .map_err(|e| NexError::Git(e.message().to_string()))?;
    let mut names: Vec<&str> = remotes.iter().flatten().collect();
    // 较长 remote 名优先，避免误剥前缀。
    names.sort_by_key(|n| std::cmp::Reverse(n.len()));
    for remote in names {
        let prefix = format!("{remote}/");
        if let Some(rest) = remote_branch.strip_prefix(&prefix) {
            if !rest.is_empty() {
                return Ok(rest.to_string());
            }
        }
    }
    remote_branch
        .split_once('/')
        .map(|(_, rest)| rest.to_string())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| NexError::Git(format!("无法解析远程分支名: {remote_branch}")))
}

/// 远程分支 → 本地跟踪分支并签出。先尽量 fetch 该 remote，再创建/签出。
fn checkout_remote_as_local(repo_path: &Path, remote_branch: &str) -> Result<(), NexError> {
    let remote_name = remote_branch
        .split_once('/')
        .map(|(r, _)| r)
        .unwrap_or("origin");
    // 尽力同步远端 tip；离线时仍可用已有 remote-tracking ref。
    let fetch_result = super::network::fetch_remote(repo_path, remote_name);

    let repo = require_repo(repo_path)?;
    let local_name = local_name_from_remote_branch(&repo, remote_branch)?;

    if repo
        .find_branch(&local_name, git2::BranchType::Local)
        .is_ok()
    {
        let _ = fetch_result; // 已存在本地分支：fetch 成败都不挡签出
        return checkout_local_ref(&repo, &local_name);
    }

    let remote = match repo.find_branch(remote_branch, git2::BranchType::Remote) {
        Ok(b) => b,
        Err(e) => {
            return Err(fetch_result.err().unwrap_or_else(|| {
                NexError::Git(format!("远程分支不存在: {remote_branch} ({e})"))
            }));
        }
    };
    let commit = remote
        .get()
        .peel_to_commit()
        .map_err(|e| NexError::Git(e.message().to_string()))?;
    let mut local = repo
        .branch(&local_name, &commit, false)
        .map_err(|e| NexError::Git(e.message().to_string()))?;
    // upstream 名形如 "origin/foo"
    local
        .set_upstream(Some(remote_branch))
        .map_err(|e| NexError::Git(format!("设置上游分支失败: {e}")))?;

    checkout_local_ref(&repo, &local_name)
}

fn checkout_local_ref(repo: &Repository, name: &str) -> Result<(), NexError> {
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
    let repo = require_repo(repo_path)?;
    let head = repo
        .head()
        .and_then(|h| h.peel_to_commit())
        .map_err(|_| NexError::Git("cannot create a branch on an unborn HEAD".to_string()))?;
    repo.branch(trimmed, &head, false)?;
    Ok(())
}

pub fn delete_branch(repo_path: &Path, name: &str) -> Result<(), NexError> {
    let repo = require_repo(repo_path)?;
    let mut branch = repo.find_branch(name, git2::BranchType::Local)?;
    if branch.is_head() {
        return Err(NexError::Git("不能删除当前分支".to_string()));
    }
    branch.delete()?;
    Ok(())
}

/// Rejects repo-relative paths that could escape the working directory
/// (`..` components, absolute paths). All discard/revert file lists pass
/// through here before touching the filesystem or checkout APIs.
fn validate_repo_relative(file: &str) -> Result<(), NexError> {
    let p = Path::new(file);
    if p.is_absolute()
        || p.components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err(NexError::Git(format!("非法的仓库相对路径: {file}")));
    }
    Ok(())
}

pub fn discard_changes(repo_path: &Path, files: &[String]) -> Result<(), NexError> {
    let repo = require_repo(repo_path)?;
    let workdir = repo
        .workdir()
        .ok_or_else(|| NexError::Git("cannot discard changes in a bare repository".to_string()))?
        .to_path_buf();

    for file in files {
        validate_repo_relative(file)?;
    }

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
    let repo = require_repo(repo_path)?;
    for file in files {
        validate_repo_relative(file)?;
    }
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

pub fn stash_save(repo_path: &Path, message: &str) -> Result<(), NexError> {
    // git2 0.19 的 stash_* 全系 &mut self
    let mut repo = require_repo(repo_path)?;
    let sig = repo.signature()?;
    if repo.head().and_then(|h| h.peel_to_commit()).is_err() {
        return Err(NexError::Git(
            "cannot stash on an unborn HEAD: commit something first".to_string(),
        ));
    }
    // libgit2 stores an empty message verbatim; synthesize git's default.
    let fallback = match repo
        .head()
        .ok()
        .and_then(|h| h.shorthand().map(|s| s.to_string()))
    {
        Some(branch) => format!("WIP on {branch}"),
        None => "WIP on HEAD".to_string(),
    };
    let msg = if message.trim().is_empty() {
        fallback.as_str()
    } else {
        message
    };
    repo.stash_save(&sig, msg, Some(git2::StashFlags::INCLUDE_UNTRACKED))?;
    Ok(())
}

pub fn stash_list(repo_path: &Path) -> Result<Vec<StashEntry>, NexError> {
    let Some(mut repo) = open_repo(repo_path)? else {
        return Ok(Vec::new());
    };
    let mut out = Vec::new();
    repo.stash_foreach(|index, message, oid| {
        out.push(StashEntry {
            index: index as u32,
            message: message.to_string(),
            id: oid.to_string(),
        });
        true
    })?;
    Ok(out)
}

/// Resolves a stable stash id (commit OID) to its *current* positional
/// index. Callers previously passed UI-time indexes, which silently hit the
/// wrong stash whenever the list shifted (any drop renumbers everything).
fn resolve_stash_index(repo: &mut Repository, id: &str) -> Result<usize, NexError> {
    let wanted =
        git2::Oid::from_str(id).map_err(|_| NexError::Git(format!("非法的 stash id: {id:?}")))?;
    let mut found: Option<usize> = None;
    repo.stash_foreach(|index, _message, oid| {
        if *oid == wanted {
            found = Some(index);
            false // stop iterating
        } else {
            true
        }
    })?;
    found.ok_or_else(|| NexError::Git("stash 条目已不存在（列表可能已变化，请刷新）".to_string()))
}

pub fn stash_apply(repo_path: &Path, id: &str) -> Result<(), NexError> {
    let mut repo = require_repo(repo_path)?;
    let index = resolve_stash_index(&mut repo, id)?;
    repo.stash_apply(index, None)?;
    Ok(())
}

pub fn stash_pop(repo_path: &Path, id: &str) -> Result<(), NexError> {
    let mut repo = require_repo(repo_path)?;
    let index = resolve_stash_index(&mut repo, id)?;
    repo.stash_pop(index, None)?;
    Ok(())
}

pub fn stash_drop(repo_path: &Path, id: &str) -> Result<(), NexError> {
    let mut repo = require_repo(repo_path)?;
    let index = resolve_stash_index(&mut repo, id)?;
    repo.stash_drop(index)?;
    Ok(())
}
