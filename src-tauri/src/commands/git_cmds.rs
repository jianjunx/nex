use crate::error::NexError;
use crate::git::credentials::GitCredentialBroker;
use crate::git::network;
use crate::git::repository;
use crate::git::types::*;
use std::path::{Path, PathBuf};
use tauri::State;

#[tauri::command]
pub async fn git_status(project_path: String) -> Result<Option<GitStatus>, NexError> {
    tauri::async_runtime::spawn_blocking(move || repository::get_status(Path::new(&project_path)))
        .await
        .map_err(|e| NexError::Git(format!("git_status join: {e}")))?
}

#[tauri::command]
pub async fn git_diff(
    project_path: String,
    file: String,
    staged: bool,
) -> Result<String, NexError> {
    tauri::async_runtime::spawn_blocking(move || {
        repository::get_diff(Path::new(&project_path), &file, staged)
    })
    .await
    .map_err(|e| NexError::Git(format!("git_diff join: {e}")))?
}

#[tauri::command]
pub async fn git_diff_contents(
    project_path: String,
    file: String,
    staged: bool,
) -> Result<DiffContents, NexError> {
    tauri::async_runtime::spawn_blocking(move || {
        repository::get_diff_contents(Path::new(&project_path), &file, staged)
    })
    .await
    .map_err(|e| NexError::Git(format!("git_diff_contents join: {e}")))?
}

#[tauri::command]
pub async fn git_commit_patch(project_path: String, hash: String) -> Result<String, NexError> {
    tauri::async_runtime::spawn_blocking(move || {
        repository::get_commit_patch(Path::new(&project_path), &hash)
    })
    .await
    .map_err(|e| NexError::Git(format!("git_commit_patch join: {e}")))?
}

#[tauri::command]
pub async fn git_log(project_path: String, limit: usize) -> Result<Vec<CommitInfo>, NexError> {
    tauri::async_runtime::spawn_blocking(move || {
        repository::get_log(Path::new(&project_path), limit)
    })
    .await
    .map_err(|e| NexError::Git(format!("git_log join: {e}")))?
}

#[tauri::command]
pub async fn git_stage(project_path: String, files: Vec<String>) -> Result<(), NexError> {
    tauri::async_runtime::spawn_blocking(move || {
        repository::stage_files(Path::new(&project_path), &files)
    })
    .await
    .map_err(|e| NexError::Git(format!("git_stage join: {e}")))?
}

#[tauri::command]
pub async fn git_unstage(project_path: String, files: Vec<String>) -> Result<(), NexError> {
    tauri::async_runtime::spawn_blocking(move || {
        repository::unstage_files(Path::new(&project_path), &files)
    })
    .await
    .map_err(|e| NexError::Git(format!("git_unstage join: {e}")))?
}

#[tauri::command]
pub async fn git_commit(project_path: String, message: String) -> Result<String, NexError> {
    tauri::async_runtime::spawn_blocking(move || {
        repository::commit(Path::new(&project_path), &message)
    })
    .await
    .map_err(|e| NexError::Git(format!("git_commit join: {e}")))?
}

#[tauri::command]
pub async fn git_list_branches(project_path: String) -> Result<Vec<BranchInfo>, NexError> {
    tauri::async_runtime::spawn_blocking(move || {
        repository::list_branches(Path::new(&project_path))
    })
    .await
    .map_err(|e| NexError::Git(format!("git_list_branches join: {e}")))?
}

#[tauri::command]
pub async fn git_checkout(project_path: String, name: String) -> Result<(), NexError> {
    // 远程分支签出会先 fetch，可能较慢；放 spawn_blocking + 超时，避免堵死 UI 线程。
    let path = PathBuf::from(project_path);
    match tokio::time::timeout(
        GIT_NETWORK_CMD_TIMEOUT,
        tokio::task::spawn_blocking(move || repository::checkout_branch(&path, &name)),
    )
    .await
    {
        Ok(Ok(r)) => r,
        Ok(Err(e)) => Err(NexError::Internal(format!("task join failed: {e}"))),
        Err(_) => Err(NexError::Git("git checkout 超时".into())),
    }
}

#[tauri::command]
pub async fn git_create_branch(project_path: String, name: String) -> Result<(), NexError> {
    tauri::async_runtime::spawn_blocking(move || {
        repository::create_branch(Path::new(&project_path), &name)
    })
    .await
    .map_err(|e| NexError::Git(format!("git_create_branch join: {e}")))?
}

#[tauri::command]
pub async fn git_delete_branch(project_path: String, name: String) -> Result<(), NexError> {
    tauri::async_runtime::spawn_blocking(move || {
        repository::delete_branch(Path::new(&project_path), &name)
    })
    .await
    .map_err(|e| NexError::Git(format!("git_delete_branch join: {e}")))?
}

#[tauri::command]
pub async fn git_discard(project_path: String, files: Vec<String>) -> Result<(), NexError> {
    tauri::async_runtime::spawn_blocking(move || {
        repository::discard_changes(Path::new(&project_path), &files)
    })
    .await
    .map_err(|e| NexError::Git(format!("git_discard join: {e}")))?
}

#[tauri::command]
pub async fn git_revert_staged(project_path: String, files: Vec<String>) -> Result<(), NexError> {
    tauri::async_runtime::spawn_blocking(move || {
        repository::revert_staged(Path::new(&project_path), &files)
    })
    .await
    .map_err(|e| NexError::Git(format!("git_revert_staged join: {e}")))?
}

#[tauri::command]
pub async fn git_stash_save(project_path: String, message: String) -> Result<(), NexError> {
    tauri::async_runtime::spawn_blocking(move || {
        repository::stash_save(Path::new(&project_path), &message)
    })
    .await
    .map_err(|e| NexError::Git(format!("git_stash_save join: {e}")))?
}

#[tauri::command]
pub async fn git_stash_list(project_path: String) -> Result<Vec<StashEntry>, NexError> {
    tauri::async_runtime::spawn_blocking(move || repository::stash_list(Path::new(&project_path)))
        .await
        .map_err(|e| NexError::Git(format!("git_stash_list join: {e}")))?
}

#[tauri::command]
pub async fn git_stash_apply(project_path: String, id: String) -> Result<(), NexError> {
    tauri::async_runtime::spawn_blocking(move || {
        repository::stash_apply(Path::new(&project_path), &id)
    })
    .await
    .map_err(|e| NexError::Git(format!("git_stash_apply join: {e}")))?
}

#[tauri::command]
pub async fn git_stash_pop(project_path: String, id: String) -> Result<(), NexError> {
    tauri::async_runtime::spawn_blocking(move || {
        repository::stash_pop(Path::new(&project_path), &id)
    })
    .await
    .map_err(|e| NexError::Git(format!("git_stash_pop join: {e}")))?
}

#[tauri::command]
pub async fn git_stash_drop(project_path: String, id: String) -> Result<(), NexError> {
    tauri::async_runtime::spawn_blocking(move || {
        repository::stash_drop(Path::new(&project_path), &id)
    })
    .await
    .map_err(|e| NexError::Git(format!("git_stash_drop join: {e}")))?
}

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

// 网络操作委派系统 git 子进程（与 VSCode 一致）：SSH 走 OpenSSH、HTTPS 走
// git 原生 credential helper；不再需要凭据 broker 参入（见 network.rs 顶部说明）。
// 超时在 network.rs 内杀子进程；此处再套一层避免 spawn_blocking 永久挂起。
const GIT_NETWORK_CMD_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(310);

#[tauri::command]
pub async fn git_fetch(project_path: String, remote: String) -> Result<(), NexError> {
    let path = PathBuf::from(project_path);
    match tokio::time::timeout(
        GIT_NETWORK_CMD_TIMEOUT,
        tokio::task::spawn_blocking(move || network::fetch_remote(&path, &remote)),
    )
    .await
    {
        Ok(Ok(r)) => r,
        Ok(Err(e)) => Err(NexError::Internal(format!("task join failed: {e}"))),
        Err(_) => Err(NexError::Git("git fetch 超时".into())),
    }
}

#[tauri::command]
pub async fn git_pull(project_path: String, remote: String) -> Result<(), NexError> {
    let path = PathBuf::from(project_path);
    match tokio::time::timeout(
        GIT_NETWORK_CMD_TIMEOUT,
        tokio::task::spawn_blocking(move || network::pull_remote(&path, &remote)),
    )
    .await
    {
        Ok(Ok(r)) => r,
        Ok(Err(e)) => Err(NexError::Internal(format!("task join failed: {e}"))),
        Err(_) => Err(NexError::Git("git pull 超时".into())),
    }
}

#[tauri::command]
pub async fn git_push(
    project_path: String,
    remote: String,
    branch: String,
) -> Result<(), NexError> {
    let path = PathBuf::from(project_path);
    match tokio::time::timeout(
        GIT_NETWORK_CMD_TIMEOUT,
        tokio::task::spawn_blocking(move || network::push_remote(&path, &remote, &branch)),
    )
    .await
    {
        Ok(Ok(r)) => r,
        Ok(Err(e)) => Err(NexError::Internal(format!("task join failed: {e}"))),
        Err(_) => Err(NexError::Git("git push 超时".into())),
    }
}

#[tauri::command]
pub async fn git_clone(url: String, dest: String) -> Result<(), NexError> {
    let dest = PathBuf::from(dest);
    match tokio::time::timeout(
        GIT_NETWORK_CMD_TIMEOUT,
        tokio::task::spawn_blocking(move || network::clone_repo(&url, &dest)),
    )
    .await
    {
        Ok(Ok(r)) => r,
        Ok(Err(e)) => Err(NexError::Internal(format!("task join failed: {e}"))),
        Err(_) => Err(NexError::Git("git clone 超时".into())),
    }
}

#[tauri::command]
pub async fn git_merge(project_path: String, branch: String) -> Result<(), NexError> {
    let path = PathBuf::from(project_path);
    match tokio::time::timeout(
        GIT_NETWORK_CMD_TIMEOUT,
        tokio::task::spawn_blocking(move || network::merge_branch(&path, &branch)),
    )
    .await
    {
        Ok(Ok(r)) => r,
        Ok(Err(e)) => Err(NexError::Internal(format!("task join failed: {e}"))),
        Err(_) => Err(NexError::Git("git merge 超时".into())),
    }
}
