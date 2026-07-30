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
