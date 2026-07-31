use crate::error::NexError;
use crate::fs::tree::{FsNode, read_tree, expand_dir};
use crate::fs::read::{FileContent, read_file};
use crate::fs::write::write_file;
use crate::fs::create::{create_file, create_dir};
use crate::fs::search::{SearchMatch, SearchOptions, ReplacePreview, ReplaceResult, search, search_replace, apply_replace};
use crate::state::AppState;
use std::path::Path;
use tauri::{AppHandle, State};

#[tauri::command]
pub fn fs_read_tree(project_path: String) -> Result<Vec<FsNode>, NexError> {
    read_tree(Path::new(&project_path), 1)
}

#[tauri::command]
pub fn fs_expand_dir(dir_path: String) -> Result<Vec<FsNode>, NexError> {
    expand_dir(Path::new(&dir_path))
}

#[tauri::command]
pub fn fs_read_file(file_path: String) -> Result<FileContent, NexError> {
    read_file(Path::new(&file_path))
}

#[tauri::command]
pub fn fs_write_file(file_path: String, content: String) -> Result<(), NexError> {
    write_file(Path::new(&file_path), &content)
}

/// Starts the debounced watcher for a project (no-op if already watching),
/// which emits `fs-changed` / `git-status-changed` events on external
/// changes.
#[tauri::command]
pub fn fs_watch_start(app: AppHandle, state: State<AppState>, project_path: String) -> Result<(), NexError> {
    state.watcher_manager.watch(app, &project_path)
}

/// Global project search with match rules (case / whole-word / regex).
/// `options = None` keeps the historical case-insensitive substring behavior.
#[tauri::command]
pub fn fs_search(project_path: String, query: String, options: Option<SearchOptions>) -> Result<Vec<SearchMatch>, NexError> {
    search(Path::new(&project_path), &query, options)
}

/// Project-wide replace PREVIEW: per-file replacement counts, writes nothing.
/// Honors the same MAX_RESULTS/.gitignore/size constraints as search.
#[tauri::command]
pub fn fs_search_replace(project_path: String, query: String, replacement: String, options: Option<SearchOptions>) -> Result<ReplacePreview, NexError> {
    search_replace(Path::new(&project_path), &query, &replacement, options)
}

/// Project-wide replace: writes to disk atomically (fs/write.rs).
/// `paths` limits the scope to explicit files (single-file replace);
/// `limit_per_file` caps replacements per file (single-match = Some(1)).
/// After the write, the existing fs-changed watcher syncs open editors
/// (clean → silent reload, dirty → stale banner) — intentionally not
/// suppressed.
#[tauri::command]
pub fn fs_apply_replace(project_path: String, query: String, replacement: String, options: Option<SearchOptions>, paths: Option<Vec<String>>, limit_per_file: Option<usize>) -> Result<ReplaceResult, NexError> {
    apply_replace(Path::new(&project_path), &query, &replacement, options, paths, limit_per_file)
}

#[tauri::command]
pub fn fs_create_file(parent_dir: String, name: String) -> Result<(), NexError> {
    create_file(Path::new(&parent_dir), &name)
}

#[tauri::command]
pub fn fs_create_dir(parent_dir: String, name: String) -> Result<(), NexError> {
    create_dir(Path::new(&parent_dir), &name)
}
