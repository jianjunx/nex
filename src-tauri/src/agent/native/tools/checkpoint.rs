//! Checkpoints & rewind: session snapshots stored as commits on a hidden
//! `nex-checkpoints` branch of the workspace repo; `rewind` restores checkpoint
//! files without moving the user's branch, HEAD, or index.

use super::{arg_str, Tool, ToolCtx};
use agent_client_protocol as acp;

/// Hidden branch holding checkpoint commits.
const CHECKPOINT_BRANCH: &str = "nex-checkpoints";

pub struct Checkpoint;

#[async_trait::async_trait(?Send)]
impl Tool for Checkpoint {
    fn name(&self) -> &'static str {
        "checkpoint"
    }
    fn description(&self) -> &'static str {
        "Snapshot the current workspace state (git commit on a hidden branch). \
         Returns a checkpoint id you can later `rewind` to. Take one before risky refactors."
    }
    fn schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "message": { "type": "string", "description": "Short note describing what this checkpoint captures." }
            },
            "additionalProperties": false
        })
    }
    fn kind(&self) -> acp::ToolKind {
        acp::ToolKind::Edit
    }
    async fn execute(&self, args: serde_json::Value, ctx: &ToolCtx) -> Result<String, String> {
        let message = args
            .get("message")
            .and_then(|v| v.as_str())
            .unwrap_or("checkpoint");
        create_checkpoint(&ctx.cwd, message)
    }
}

pub struct Rewind;

#[async_trait::async_trait(?Send)]
impl Tool for Rewind {
    fn name(&self) -> &'static str {
        "rewind"
    }
    fn description(&self) -> &'static str {
        "Restore the workspace files to a previously created checkpoint. \
         Destructive for uncommitted changes made after that checkpoint."
    }
    fn schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "checkpoint": { "type": "string", "description": "Checkpoint id returned by `checkpoint`." }
            },
            "required": ["checkpoint"],
            "additionalProperties": false
        })
    }
    fn kind(&self) -> acp::ToolKind {
        acp::ToolKind::Edit
    }
    async fn execute(&self, args: serde_json::Value, ctx: &ToolCtx) -> Result<String, String> {
        let id = arg_str(&args, "checkpoint")?;
        rewind_to(&ctx.cwd, &id)
    }
}

/// Open the git repo only when its workdir is the session cwd. `discover`
/// walks parents, so a session opened on a monorepo subdirectory would
/// otherwise snapshot/restore files outside the workspace sandbox.
fn open_workspace_repo(cwd: &std::path::Path) -> Result<git2::Repository, String> {
    let repo = git2::Repository::discover(cwd).map_err(|e| format!("not a git repository: {e}"))?;
    let workdir = repo
        .workdir()
        .ok_or_else(|| "bare repositories do not support checkpoint/rewind".to_string())?;
    if !same_dir(cwd, workdir) {
        return Err(
            "checkpoint/rewind is limited to the session workspace root; \
             the git repository is outside the session cwd"
                .to_string(),
        );
    }
    Ok(repo)
}

fn same_dir(a: &std::path::Path, b: &std::path::Path) -> bool {
    match (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
        (Ok(left), Ok(right)) => left == right,
        _ => a == b,
    }
}

fn create_checkpoint(cwd: &std::path::Path, message: &str) -> Result<String, String> {
    let repo = open_workspace_repo(cwd)?;
    let mut index = repo.index().map_err(|e| format!("index error: {e}"))?;
    index
        .add_all(["*"].iter(), git2::IndexAddOption::DEFAULT, None)
        .map_err(|e| format!("failed to stage files: {e}"))?;
    // Never snapshot Nex's own metadata dirs (agent archives, rules, …) —
    // checkpoints are a user-visible view of their workspace.
    for prefix in [".nex", ".nex-archive"] {
        let p = std::path::Path::new(prefix);
        index.remove_path(p).ok(); // exact file entry, if any
        index.remove_dir(p, 0).ok(); // recursive subtree removal
    }
    // `repo.index()` is an in-memory view until `write()` is called.  Keep the
    // add_all result private to this checkpoint: writing it would silently
    // stage every workspace file in the user's real index.
    let tree_id = index
        .write_tree()
        .map_err(|e| format!("failed to write tree: {e}"))?;
    let tree = repo
        .find_tree(tree_id)
        .map_err(|e| format!("tree error: {e}"))?;

    let sig = repo
        .signature()
        .or_else(|_| git2::Signature::now("Nex Agent", "nex-agent@localhost"))
        .map_err(|e| format!("signature error: {e}"))?;

    let parent_commit = repo
        .find_branch(CHECKPOINT_BRANCH, git2::BranchType::Local)
        .ok()
        .and_then(|b| b.get().target())
        .and_then(|oid| repo.find_commit(oid).ok());
    let parents: Vec<&git2::Commit> = parent_commit.iter().collect();

    let oid = repo
        .commit(
            Some(&format!("refs/heads/{CHECKPOINT_BRANCH}")),
            &sig,
            &sig,
            &format!("nex checkpoint: {message}"),
            &tree,
            &parents,
        )
        .map_err(|e| format!("failed to commit checkpoint: {e}"))?;
    Ok(format!("checkpoint created: {}", &oid.to_string()[..10]))
}

fn rewind_to(cwd: &std::path::Path, id: &str) -> Result<String, String> {
    let repo = open_workspace_repo(cwd)?;
    let branch = repo
        .find_branch(CHECKPOINT_BRANCH, git2::BranchType::Local)
        .map_err(|_| "no checkpoints exist yet".to_string())?;

    // Short ids need enough bits to be unambiguous; a model truncating to
    // one or two hex chars must be rejected instead of guessing.
    if id.len() < 8 {
        return Err(format!(
            "checkpoint id too short: `{id}` — use at least 8 hex characters"
        ));
    }

    // Walk the checkpoint branch history for matching (short) ids.
    let head_oid = branch.get().target().ok_or("empty checkpoint branch")?;
    let mut walk = repo.revwalk().map_err(|e| format!("revwalk error: {e}"))?;
    walk.push(head_oid)
        .map_err(|e| format!("revwalk error: {e}"))?;
    let mut matches: Vec<git2::Commit> = Vec::new();
    for oid in walk.flatten() {
        if let Ok(commit) = repo.find_commit(oid) {
            if commit.id().to_string().starts_with(id) {
                matches.push(commit);
                if matches.len() > 1 {
                    break;
                }
            }
        }
    }
    let commit = match matches.len() {
        0 => return Err(format!("checkpoint `{id}` not found")),
        1 => matches.pop().unwrap(),
        _ => {
            return Err(format!(
                "checkpoint id `{id}` is ambiguous; use a longer prefix"
            ))
        }
    };

    // A hard reset would move the user's current branch/HEAD and replace their
    // index.  Check out only files that exist in the checkpoint tree instead:
    // this restores deleted/changed checkpoint files while deliberately leaving
    // files created afterwards alone (they may be user-owned untracked files).
    let tree = commit
        .tree()
        .map_err(|e| format!("checkpoint tree error: {e}"))?;
    let paths = checkpoint_paths(&tree)?;
    let conflicts = untracked_path_conflicts(&repo, &paths)?;
    if !conflicts.is_empty() {
        let shown = conflicts
            .iter()
            .take(5)
            .cloned()
            .collect::<Vec<_>>()
            .join(", ");
        let suffix = if conflicts.len() > 5 { ", …" } else { "" };
        return Err(format!(
            "rewind refused: checkpoint would overwrite untracked path(s): {shown}{suffix}. Move, add, or remove them before retrying"
        ));
    }
    let mut checkout = git2::build::CheckoutBuilder::new();
    checkout.force().update_index(false);
    for path in paths {
        checkout.path(path);
    }
    repo.checkout_tree(commit.as_object(), Some(&mut checkout))
        .map_err(|e| format!("rewind failed: {e}"))?;
    Ok(format!(
        "checkpoint files restored to {} (branch, HEAD, index, and new untracked files preserved)",
        &commit.id().to_string()[..10]
    ))
}

/// Reject a checkout target that currently has no index entry. Such a path is
/// untracked (or ignored) from Git's perspective, so force-checking it out
/// would silently destroy user data. Tracked files remain rewindable: that is
/// the explicit purpose of the tool, while the index itself stays untouched.
fn untracked_path_conflicts(
    repo: &git2::Repository,
    checkpoint_paths: &[String],
) -> Result<Vec<String>, String> {
    let workdir = repo
        .workdir()
        .ok_or_else(|| "bare repositories do not support rewind".to_string())?;
    let index = repo.index().map_err(|e| format!("index error: {e}"))?;
    let mut conflicts = Vec::new();
    for path in checkpoint_paths {
        let candidate = workdir.join(path);
        match std::fs::symlink_metadata(&candidate) {
            Ok(_) if index.get_path(std::path::Path::new(path), 0).is_none() => {
                conflicts.push(path.clone());
            }
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => {
                return Err(format!(
                    "failed to inspect checkpoint target {}: {e}",
                    candidate.display()
                ));
            }
        }
    }
    Ok(conflicts)
}

/// File paths represented by a checkpoint tree. Passing this exact list to
/// `CheckoutBuilder` prevents checkout from deleting paths absent from the
/// snapshot, which is essential for preserving user-created untracked files.
fn checkpoint_paths(tree: &git2::Tree<'_>) -> Result<Vec<String>, String> {
    let mut paths = Vec::new();
    tree.walk(git2::TreeWalkMode::PreOrder, |root, entry| {
        if entry.kind() == Some(git2::ObjectType::Blob) {
            if let Some(name) = entry.name() {
                paths.push(format!("{root}{name}"));
            }
        }
        git2::TreeWalkResult::Ok
    })
    .map_err(|e| format!("checkpoint tree walk failed: {e}"))?;
    Ok(paths)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::native::tools::ToolCtx;
    use std::cell::RefCell;
    use std::rc::Rc;

    fn ctx(dir: &std::path::Path) -> ToolCtx {
        ToolCtx {
            cwd: dir.to_path_buf(),
            bash_timeout: std::time::Duration::from_secs(10),
            shell_sandbox: crate::agent::native::config::ShellSandboxMode::ApprovalOnly,
            path_env: std::env::var_os("PATH").unwrap_or_default(),
            archive_dir: dir.join(".nex-archive"),
            jobs: Rc::new(RefCell::new(super::super::jobs::JobTable::default())),
            harness: None,
            mutations: Rc::new(RefCell::new(Vec::new())),
            mode_id: None,
            memory: super::super::test_memory_handle(),
            graph: None,
            conn: None,
            session_id: None,
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn checkpoint_and_rewind_round_trip() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = git2::Repository::init(tmp.path()).unwrap();
        // An initial tracked file so rewind is allowed to restore a checkpoint
        // target without overwriting an untracked user file.
        {
            std::fs::write(tmp.path().join("a.txt"), "base").unwrap();
            let sig = git2::Signature::now("t", "t@t").unwrap();
            let tree = {
                let mut idx = repo.index().unwrap();
                idx.add_path(std::path::Path::new("a.txt")).unwrap();
                idx.write().unwrap();
                let id = idx.write_tree().unwrap();
                repo.find_tree(id).unwrap()
            };
            repo.commit(Some("HEAD"), &sig, &sig, "init", &tree, &[])
                .unwrap();
        }
        drop(repo);

        std::fs::write(tmp.path().join("a.txt"), "v1").unwrap();
        let c = ctx(tmp.path());
        let cp = Checkpoint
            .execute(serde_json::json!({"message": "before refactor"}), &c)
            .await
            .unwrap();
        let id = cp.split(": ").nth(1).unwrap().to_string();

        std::fs::write(tmp.path().join("a.txt"), "v2 broken").unwrap();
        let out = Rewind
            .execute(serde_json::json!({"checkpoint": id}), &c)
            .await
            .unwrap();
        assert!(out.contains("restored"));
        assert_eq!(
            std::fs::read_to_string(tmp.path().join("a.txt")).unwrap(),
            "v1"
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn rewind_refuses_to_overwrite_an_untracked_checkpoint_path() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = git2::Repository::init(tmp.path()).unwrap();
        std::fs::write(tmp.path().join("tracked.txt"), "base").unwrap();
        {
            let sig = git2::Signature::now("t", "t@t").unwrap();
            let mut index = repo.index().unwrap();
            index.add_path(std::path::Path::new("tracked.txt")).unwrap();
            index.write().unwrap();
            let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
            repo.commit(Some("HEAD"), &sig, &sig, "init", &tree, &[])
                .unwrap();
        }

        std::fs::write(tmp.path().join("tracked.txt"), "checkpoint").unwrap();
        let c = ctx(tmp.path());
        let checkpoint = Checkpoint
            .execute(serde_json::json!({"message": "safe snapshot"}), &c)
            .await
            .unwrap();
        let id = checkpoint.split(": ").nth(1).unwrap().to_string();

        // Simulate a user replacing the tracked target with their own
        // untracked file after the checkpoint was made.
        {
            let mut index = repo.index().unwrap();
            index
                .remove_path(std::path::Path::new("tracked.txt"))
                .unwrap();
            index.write().unwrap();
        }
        let index_before = std::fs::read(repo.path().join("index")).unwrap();
        std::fs::write(tmp.path().join("tracked.txt"), "do not overwrite").unwrap();

        let err = Rewind
            .execute(serde_json::json!({"checkpoint": id}), &c)
            .await
            .unwrap_err();
        assert!(err.contains("would overwrite untracked"), "got: {err}");
        assert_eq!(
            std::fs::read_to_string(tmp.path().join("tracked.txt")).unwrap(),
            "do not overwrite"
        );
        assert_eq!(
            std::fs::read(repo.path().join("index")).unwrap(),
            index_before
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn rewind_preserves_branch_head_index_and_untracked_files() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = git2::Repository::init(tmp.path()).unwrap();
        std::fs::write(tmp.path().join("tracked.txt"), "base").unwrap();
        {
            let sig = git2::Signature::now("t", "t@t").unwrap();
            let mut index = repo.index().unwrap();
            index.add_path(std::path::Path::new("tracked.txt")).unwrap();
            index.write().unwrap();
            let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
            repo.commit(Some("HEAD"), &sig, &sig, "init", &tree, &[])
                .unwrap();
        }

        // A real staged user change must survive both checkpoint creation and
        // rewind byte-for-byte in .git/index.
        std::fs::write(tmp.path().join("staged.txt"), "user staged").unwrap();
        {
            let mut index = repo.index().unwrap();
            index.add_path(std::path::Path::new("staged.txt")).unwrap();
            index.write().unwrap();
        }
        let head_before = repo.head().unwrap().target().unwrap();
        let branch_before = repo.head().unwrap().name().unwrap().to_string();
        let index_path = repo.path().join("index");
        let index_before = std::fs::read(&index_path).unwrap();

        std::fs::write(tmp.path().join("tracked.txt"), "checkpoint").unwrap();
        let c = ctx(tmp.path());
        let checkpoint = Checkpoint
            .execute(serde_json::json!({"message": "safe snapshot"}), &c)
            .await
            .unwrap();
        let id = checkpoint.split(": ").nth(1).unwrap().to_string();
        assert_eq!(std::fs::read(&index_path).unwrap(), index_before);

        std::fs::write(tmp.path().join("tracked.txt"), "broken").unwrap();
        std::fs::write(tmp.path().join("user-notes.txt"), "keep me").unwrap();
        Rewind
            .execute(serde_json::json!({"checkpoint": id}), &c)
            .await
            .unwrap();

        assert_eq!(
            std::fs::read_to_string(tmp.path().join("tracked.txt")).unwrap(),
            "checkpoint"
        );
        assert_eq!(repo.head().unwrap().target(), Some(head_before));
        assert_eq!(repo.head().unwrap().name(), Some(branch_before.as_str()));
        assert_eq!(std::fs::read(&index_path).unwrap(), index_before);
        assert_eq!(
            std::fs::read_to_string(tmp.path().join("user-notes.txt")).unwrap(),
            "keep me"
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn checkpoint_excludes_nex_dirs() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = git2::Repository::init(tmp.path()).unwrap();
        {
            let sig = git2::Signature::now("t", "t@t").unwrap();
            let tree = {
                let mut idx = repo.index().unwrap();
                let id = idx.write_tree().unwrap();
                repo.find_tree(id).unwrap()
            };
            repo.commit(Some("HEAD"), &sig, &sig, "init", &tree, &[])
                .unwrap();
        }
        drop(repo);

        std::fs::write(tmp.path().join("a.txt"), "v1").unwrap();
        std::fs::create_dir_all(tmp.path().join(".nex/rules")).unwrap();
        std::fs::write(tmp.path().join(".nex/rules/r.md"), "rule").unwrap();
        std::fs::create_dir_all(tmp.path().join(".nex-archive")).unwrap();
        std::fs::write(tmp.path().join(".nex-archive/x.jsonl"), "{}").unwrap();
        let c = ctx(tmp.path());
        let cp = Checkpoint
            .execute(serde_json::json!({"message": "cp"}), &c)
            .await
            .unwrap();
        // id unused here — we read the branch tree directly.
        let _id = cp.split(": ").nth(1).unwrap().to_string();

        // The checkpoint tree must not contain .nex / .nex-archive entries.
        let repo = git2::Repository::discover(tmp.path()).unwrap();
        let branch = repo
            .find_branch(CHECKPOINT_BRANCH, git2::BranchType::Local)
            .unwrap();
        let head = branch.get().target().unwrap();
        let commit = repo.find_commit(head).unwrap();
        let tree = commit.tree().unwrap();
        let mut names: Vec<String> = tree
            .iter()
            .map(|e| e.name().unwrap_or("").to_string())
            .collect();
        names.sort();
        assert_eq!(names, vec!["a.txt"], "checkpoint tree: {names:?}");
        assert!(!names.iter().any(|n| n.starts_with(".nex")));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn rewind_rejects_short_id() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = git2::Repository::init(tmp.path()).unwrap();
        {
            let sig = git2::Signature::now("t", "t@t").unwrap();
            let tree = {
                let mut idx = repo.index().unwrap();
                let id = idx.write_tree().unwrap();
                repo.find_tree(id).unwrap()
            };
            repo.commit(Some("HEAD"), &sig, &sig, "init", &tree, &[])
                .unwrap();
        }
        drop(repo);
        std::fs::write(tmp.path().join("a.txt"), "v1").unwrap();
        let c = ctx(tmp.path());
        Checkpoint
            .execute(serde_json::json!({"message": "cp"}), &c)
            .await
            .unwrap();
        let err = Rewind
            .execute(serde_json::json!({"checkpoint": "a1"}), &c)
            .await
            .unwrap_err();
        assert!(err.contains("too short"), "got: {err}");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn checkpoint_rejects_parent_repo_outside_cwd() {
        let tmp = tempfile::tempdir().unwrap();
        git2::Repository::init(tmp.path()).unwrap();
        let nested = tmp.path().join("pkg");
        std::fs::create_dir_all(&nested).unwrap();
        let c = ctx(&nested);
        let err = Checkpoint
            .execute(serde_json::json!({"message": "escape"}), &c)
            .await
            .unwrap_err();
        assert!(
            err.contains("workspace root") || err.contains("outside"),
            "got: {err}"
        );
        let rewind_err = Rewind
            .execute(serde_json::json!({"checkpoint": "abcdefgh"}), &c)
            .await
            .unwrap_err();
        assert!(
            rewind_err.contains("workspace root") || rewind_err.contains("outside"),
            "got: {rewind_err}"
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn checkpoint_outside_repo_errors() {
        let tmp = tempfile::tempdir().unwrap();
        let c = ctx(tmp.path());
        let err = Checkpoint
            .execute(serde_json::json!({}), &c)
            .await
            .unwrap_err();
        assert!(err.contains("not a git repository"));
    }
}
