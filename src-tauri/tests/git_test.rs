use git2::Repository;
use nex_lib::git::credentials::{host_of, session_key, GitCredentialBroker};
use nex_lib::git::network;
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
    Repository::open(dir)
        .unwrap()
        .head()
        .unwrap()
        .shorthand()
        .unwrap()
        .to_string()
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
    assert!(head.tip_time.is_some());
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

    let id = repository::stash_list(dir.path()).unwrap()[0].id.clone();
    repository::stash_pop(dir.path(), &id).unwrap();

    assert_eq!(
        fs::read_to_string(dir.path().join("a.txt")).unwrap(),
        "dirty"
    );
    assert!(repository::stash_list(dir.path()).unwrap().is_empty());
}

#[test]
fn stash_apply_restores_but_keeps_entry() {
    let dir = tempdir().unwrap();
    init_repo(dir.path());
    commit_file(dir.path(), "a.txt", "v1", "init");
    fs::write(dir.path().join("a.txt"), "dirty").unwrap();
    repository::stash_save(dir.path(), "wip").unwrap();

    let id = repository::stash_list(dir.path()).unwrap()[0].id.clone();
    repository::stash_apply(dir.path(), &id).unwrap();

    assert_eq!(
        fs::read_to_string(dir.path().join("a.txt")).unwrap(),
        "dirty"
    );
    assert_eq!(repository::stash_list(dir.path()).unwrap().len(), 1);
}

#[test]
fn stash_drop_removes_entry_without_restoring() {
    let dir = tempdir().unwrap();
    init_repo(dir.path());
    commit_file(dir.path(), "a.txt", "v1", "init");
    fs::write(dir.path().join("a.txt"), "dirty").unwrap();
    repository::stash_save(dir.path(), "wip").unwrap();

    let id = repository::stash_list(dir.path()).unwrap()[0].id.clone();
    repository::stash_drop(dir.path(), &id).unwrap();

    assert!(repository::stash_list(dir.path()).unwrap().is_empty());
    assert_eq!(fs::read_to_string(dir.path().join("a.txt")).unwrap(), "v1");
}

#[test]
fn stash_ops_follow_id_when_list_shifts() {
    // Regression: operations locate entries by stable id, not by the UI-time
    // positional index (which renumbers whenever any stash is dropped).
    let dir = tempdir().unwrap();
    init_repo(dir.path());
    commit_file(dir.path(), "a.txt", "v1", "init");

    // Two stashes: older holds "first", newer holds "second".
    fs::write(dir.path().join("a.txt"), "first").unwrap();
    repository::stash_save(dir.path(), "first").unwrap();
    fs::write(dir.path().join("a.txt"), "second").unwrap();
    repository::stash_save(dir.path(), "second").unwrap();

    let list = repository::stash_list(dir.path()).unwrap();
    assert_eq!(list.len(), 2);
    let newer = list
        .iter()
        .find(|e| e.message.contains("second"))
        .unwrap()
        .id
        .clone();
    let older = list
        .iter()
        .find(|e| e.message.contains("first"))
        .unwrap()
        .id
        .clone();

    // Drop the newer entry → the older one shifts from index 1 to 0, but
    // popping it by id must still restore "first".
    repository::stash_drop(dir.path(), &newer).unwrap();
    repository::stash_pop(dir.path(), &older).unwrap();

    assert_eq!(
        fs::read_to_string(dir.path().join("a.txt")).unwrap(),
        "first"
    );
    assert!(repository::stash_list(dir.path()).unwrap().is_empty());

    // A stale id (already dropped) must fail cleanly, not hit another entry.
    let err = repository::stash_apply(dir.path(), &older).unwrap_err();
    assert!(err.to_string().contains("已不存在"));
}

#[test]
fn stash_save_on_unborn_head_errors() {
    let dir = tempdir().unwrap();
    init_repo(dir.path());
    let err = repository::stash_save(dir.path(), "wip").unwrap_err();
    assert!(err.to_string().contains("unborn HEAD"));
}

#[test]
fn host_of_parses_common_remote_shapes() {
    assert_eq!(host_of("https://github.com/owner/repo.git"), "github.com");
    assert_eq!(host_of("https://user@codeberg.org:443/o/r"), "codeberg.org");
    assert_eq!(
        host_of("ssh://git@gitlab.com:22/group/proj.git"),
        "gitlab.com"
    );
    assert_eq!(host_of("git@github.com:owner/repo.git"), "github.com");
}

#[test]
fn session_key_scopes_cache_by_kind_and_host() {
    assert_eq!(
        session_key("https://github.com/a/b", "https"),
        "https:github.com"
    );
    assert_ne!(
        session_key("https://github.com/a/b", "https"),
        session_key("https://github.com/a/b", "ssh-passphrase"),
    );
}

#[tokio::test]
async fn respond_delivers_answer_to_pending_receiver() {
    let broker = GitCredentialBroker::new();
    let (id, rx) = broker.register_pending("https://github.com/a/b", "https");
    broker
        .respond(&id, Some("u".into()), Some("p".into()), false)
        .unwrap();
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
    broker
        .respond(&id, Some("u".into()), Some("p".into()), true)
        .unwrap();
    let _ = rx.await;
    assert!(broker
        .lookup_session("https://github.com/other/repo", "https")
        .is_some());
    assert!(broker
        .lookup_session("https://gitlab.com/a/b", "https")
        .is_none());
    assert!(broker
        .lookup_session("https://github.com/a/b", "ssh-passphrase")
        .is_none());
}

#[test]
fn respond_unknown_request_id_errors() {
    let broker = GitCredentialBroker::new();
    let err = broker
        .respond("nope", Some("u".into()), Some("p".into()), false)
        .unwrap_err();
    assert!(err.to_string().contains("no pending credential request"));
}

/// file:// URL for the local transport (works on Windows and Unix alike).
fn file_url(p: &Path) -> String {
    let s = p.to_str().unwrap().replace('\\', "/");
    if s.starts_with('/') {
        format!("file://{s}")
    } else {
        format!("file:///{s}")
    }
}

/// Clones inherit objects but not identity config; set it on any repo we
/// intend to commit in.
fn set_ident(repo: &Repository) {
    let mut cfg = repo.config().unwrap();
    cfg.set_str("user.name", "Nex Test").unwrap();
    cfg.set_str("user.email", "test@nex.dev").unwrap();
}

#[test]
fn checkout_remote_creates_local_tracking_branch() {
    // Seed → bare remote → clone; create a remote-only branch, then check it
    // out in the clone: should create local `feature` tracking `origin/feature`
    // (not detached HEAD).
    let seed = tempdir().unwrap();
    init_repo(seed.path());
    commit_file(seed.path(), "a.txt", "v1", "init");
    let main = head_name(seed.path());
    repository::create_branch(seed.path(), "feature").unwrap();
    repository::checkout_branch(seed.path(), "feature").unwrap();
    commit_file(seed.path(), "a.txt", "on-feature", "feature tip");
    repository::checkout_branch(seed.path(), &main).unwrap();

    let bare = tempdir().unwrap();
    Repository::init_bare(bare.path()).unwrap();
    {
        let repo = Repository::open(seed.path()).unwrap();
        repo.remote("origin", &file_url(bare.path())).unwrap();
    }
    network::push_remote(seed.path(), "origin", &main).unwrap();
    network::push_remote(seed.path(), "origin", "feature").unwrap();

    let work = tempdir().unwrap();
    let work_path = work.path().join("clone");
    network::clone_repo(&file_url(bare.path()), &work_path).unwrap();
    // Clone may only have default branch locally; fetch remotes then check out
    // the remote-tracking name.
    network::fetch_remote(&work_path, "origin").unwrap();
    repository::checkout_branch(&work_path, "origin/feature").unwrap();
    assert_eq!(head_name(&work_path), "feature");
    let repo = Repository::open(&work_path).unwrap();
    assert!(!repo.head_detached().unwrap());
    let local = repo
        .find_branch("feature", git2::BranchType::Local)
        .unwrap();
    let upstream = local.upstream().unwrap();
    assert_eq!(upstream.name().unwrap().unwrap(), "origin/feature");
}

#[test]
fn merge_branch_fast_forwards_current() {
    let dir = tempdir().unwrap();
    init_repo(dir.path());
    commit_file(dir.path(), "a.txt", "v1", "init");
    let main = head_name(dir.path());
    repository::create_branch(dir.path(), "feature").unwrap();
    repository::checkout_branch(dir.path(), "feature").unwrap();
    commit_file(dir.path(), "a.txt", "v2", "on feature");
    repository::checkout_branch(dir.path(), &main).unwrap();
    network::merge_branch(dir.path(), "feature").unwrap();
    assert_eq!(fs::read_to_string(dir.path().join("a.txt")).unwrap(), "v2");
}

#[test]
fn clone_fetch_pull_and_push_round_trip() {
    // Seed repo with one commit and a bare "remote". 网络操作委派系统 git
    // 子进程（与生产一致），file:// 远端无需凭据。
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
    network::push_remote(seed.path(), "origin", &branch).unwrap();

    // Clone the bare remote.
    let work = tempdir().unwrap();
    let work_path = work.path().join("clone");
    network::clone_repo(&file_url(bare.path()), &work_path).unwrap();
    assert_eq!(fs::read_to_string(work_path.join("a.txt")).unwrap(), "v1");
    {
        let repo = Repository::open(&work_path).unwrap();
        set_ident(&repo);
    }

    // Advance the seed; the clone fetches + pulls (fast-forward path).
    commit_file(seed.path(), "a.txt", "v2", "second");
    network::push_remote(seed.path(), "origin", &branch).unwrap();
    network::fetch_remote(&work_path, "origin").unwrap();
    network::pull_remote(&work_path, "origin").unwrap();
    assert_eq!(fs::read_to_string(work_path.join("a.txt")).unwrap(), "v2");

    // Diverge the clone, let the seed push again, then expect a readable
    // non-fast-forward rejection.
    commit_file(&work_path, "a.txt", "v3-diverge", "third");
    commit_file(seed.path(), "a.txt", "v4", "fourth");
    network::push_remote(seed.path(), "origin", &branch).unwrap();
    let err = network::push_remote(&work_path, "origin", &branch).unwrap_err();
    assert!(err.to_string().contains("推送被拒绝"));
}

#[test]
fn clone_creates_working_copy() {
    let seed = tempdir().unwrap();
    init_repo(seed.path());
    commit_file(seed.path(), "README.md", "# hi", "init");

    let dest_parent = tempdir().unwrap();
    let dest = dest_parent.path().join("fresh-clone");
    network::clone_repo(&file_url(seed.path()), &dest).unwrap();

    assert!(dest.join(".git").exists());
    assert_eq!(fs::read_to_string(dest.join("README.md")).unwrap(), "# hi");
}

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
    assert!(
        patch.contains("a.txt"),
        "patch should name the file: {patch}"
    );
    assert!(
        patch.contains("+v1"),
        "patch should contain the added line: {patch}"
    );
}
