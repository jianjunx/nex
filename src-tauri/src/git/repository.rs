use git2::{DiffFormat, Repository, StatusOptions};
use std::path::Path;
use crate::error::NexError;
use super::types::*;

pub fn get_status(repo_path: &Path) -> Result<GitStatus, NexError> {
    let repo = Repository::open(repo_path)?;
    let head = repo.head().ok();
    let branch = head.as_ref()
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
            let status = if s.is_index_new() { "added" } else if s.is_index_deleted() { "deleted" } else { "modified" };
            files.push(GitFileChange { path: path.clone(), status: status.to_string(), staged: true });
        }
        if s.is_wt_modified() || s.is_wt_deleted() || s.is_wt_new() {
            let status = if s.is_wt_new() { "untracked" } else if s.is_wt_deleted() { "deleted" } else { "modified" };
            files.push(GitFileChange { path, status: status.to_string(), staged: false });
        }
    }

    Ok(GitStatus { branch, ahead, behind, files })
}

pub fn get_diff(repo_path: &Path, file: &str, staged: bool) -> Result<String, NexError> {
    let repo = Repository::open(repo_path)?;
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

    let mut buf = Vec::new();
    diff.print(DiffFormat::Patch, |_, _, line| {
        // DiffLine::content() excludes the origin marker; restore the standard
        // patch prefix so consumers see real patch text (+/-/context).
        let origin = line.origin();
        if origin == '+' || origin == '-' || origin == ' ' {
            buf.push(origin as u8);
        }
        buf.extend_from_slice(line.content());
        true
    })?;

    Ok(String::from_utf8_lossy(&buf).to_string())
}

pub fn get_log(repo_path: &Path, limit: usize) -> Result<Vec<CommitInfo>, NexError> {
    let repo = Repository::open(repo_path)?;
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
    let repo = Repository::open(repo_path)?;
    let workdir = repo.workdir()
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
    let repo = Repository::open(repo_path)?;
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
    let repo = Repository::open(repo_path)?;
    let mut index = repo.index()?;
    let tree_id = index.write_tree()?;
    let tree = repo.find_tree(tree_id)?;
    let sig = repo.signature()?;
    // Unborn HEAD (fresh repo): the first commit has no parents.
    let parents = match repo.head().and_then(|h| h.peel_to_commit()) {
        Ok(head) => vec![head],
        Err(_) => Vec::new(),
    };
    let parent_refs: Vec<&git2::Commit> = parents.iter().collect();
    let oid = repo.commit(Some("HEAD"), &sig, &sig, message, &tree, &parent_refs)?;
    Ok(oid.to_string())
}

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
