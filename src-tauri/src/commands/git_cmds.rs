use crate::error::NexError;
use crate::git::repository;
use crate::git::types::*;
use std::path::Path;

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
