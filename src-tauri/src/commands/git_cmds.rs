use crate::error::NexError;
use crate::git::credentials::GitCredentialBroker;
use crate::git::network;
use crate::git::repository;
use crate::git::types::*;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, State};

#[tauri::command]
pub fn git_status(project_path: String) -> Result<GitStatus, NexError> {
    repository::get_status(Path::new(&project_path))
}

#[tauri::command]
pub fn git_diff(project_path: String, file: String, staged: bool) -> Result<String, NexError> {
    repository::get_diff(Path::new(&project_path), &file, staged)
}

#[tauri::command]
pub fn git_log(project_path: String, limit: usize) -> Result<Vec<CommitInfo>, NexError> {
    repository::get_log(Path::new(&project_path), limit)
}

#[tauri::command]
pub fn git_stage(project_path: String, files: Vec<String>) -> Result<(), NexError> {
    repository::stage_files(Path::new(&project_path), &files)
}

#[tauri::command]
pub fn git_unstage(project_path: String, files: Vec<String>) -> Result<(), NexError> {
    repository::unstage_files(Path::new(&project_path), &files)
}

#[tauri::command]
pub fn git_commit(project_path: String, message: String) -> Result<String, NexError> {
    repository::commit(Path::new(&project_path), &message)
}

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

#[tauri::command]
pub fn git_discard(project_path: String, files: Vec<String>) -> Result<(), NexError> {
    repository::discard_changes(Path::new(&project_path), &files)
}

#[tauri::command]
pub fn git_revert_staged(project_path: String, files: Vec<String>) -> Result<(), NexError> {
    repository::revert_staged(Path::new(&project_path), &files)
}

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
