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
        //（无连字符）+ ErrorCode::NotFastForward；码判优先，文案兜底，其余拒绝
        // 原因（hook/权限/保护分支）统一中文包装透传
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
