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
