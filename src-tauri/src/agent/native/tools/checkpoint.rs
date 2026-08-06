//! Checkpoints & rewind: session snapshots stored as commits on a hidden
//! `nex-checkpoints` branch of the workspace repo; `rewind` restores the
//! worktree to a previous checkpoint.

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

fn create_checkpoint(cwd: &std::path::Path, message: &str) -> Result<String, String> {
    let repo = git2::Repository::discover(cwd)
        .map_err(|e| format!("not a git repository: {e}"))?;
    let mut index = repo.index().map_err(|e| format!("index error: {e}"))?;
    index
        .add_all(["*"].iter(), git2::IndexAddOption::DEFAULT, None)
        .map_err(|e| format!("failed to stage files: {e}"))?;
    index.write().map_err(|e| format!("failed to write index: {e}"))?;
    let tree_id = index.write_tree().map_err(|e| format!("failed to write tree: {e}"))?;
    let tree = repo.find_tree(tree_id).map_err(|e| format!("tree error: {e}"))?;

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
    let repo = git2::Repository::discover(cwd)
        .map_err(|e| format!("not a git repository: {e}"))?;
    let branch = repo
        .find_branch(CHECKPOINT_BRANCH, git2::BranchType::Local)
        .map_err(|_| "no checkpoints exist yet".to_string())?;

    // Walk the checkpoint branch history for a matching (short) id.
    let head_oid = branch.get().target().ok_or("empty checkpoint branch")?;
    let mut walk = repo.revwalk().map_err(|e| format!("revwalk error: {e}"))?;
    walk.push(head_oid).map_err(|e| format!("revwalk error: {e}"))?;
    let mut found: Option<git2::Commit> = None;
    for oid in walk.flatten() {
        if let Ok(commit) = repo.find_commit(oid) {
            if commit.id().to_string().starts_with(id) {
                found = Some(commit);
                break;
            }
        }
    }
    let commit = found.ok_or_else(|| format!("checkpoint `{id}` not found"))?;

    repo.reset(commit.as_object(), git2::ResetType::Hard, None)
        .map_err(|e| format!("rewind failed: {e}"))?;
    Ok(format!("workspace rewound to checkpoint {}", &commit.id().to_string()[..10]))
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
            archive_dir: dir.join(".nex-archive"),
            jobs: Rc::new(RefCell::new(super::super::jobs::JobTable::default())),
            harness: None,
            mutations: Rc::new(RefCell::new(Vec::new())),
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn checkpoint_and_rewind_round_trip() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = git2::Repository::init(tmp.path()).unwrap();
        // An initial commit so HEAD exists.
        {
            let sig = git2::Signature::now("t", "t@t").unwrap();
            let tree = {
                let mut idx = repo.index().unwrap();
                let id = idx.write_tree().unwrap();
                repo.find_tree(id).unwrap()
            };
            repo.commit(Some("HEAD"), &sig, &sig, "init", &tree, &[]).unwrap();
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
        assert!(out.contains("rewound"));
        assert_eq!(std::fs::read_to_string(tmp.path().join("a.txt")).unwrap(), "v1");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn checkpoint_outside_repo_errors() {
        let tmp = tempfile::tempdir().unwrap();
        let c = ctx(tmp.path());
        let err = Checkpoint.execute(serde_json::json!({}), &c).await.unwrap_err();
        assert!(err.contains("not a git repository"));
    }
}
