use crate::error::NexError;
use crate::fs::create::{create_dir, create_file};
use crate::fs::operations::{copy_entry, delete_entry, import_file, move_entry, rename_entry};
use crate::fs::read::{read_file, FileContent};
use crate::fs::search::{
    apply_replace, search, search_replace, ReplacePreview, ReplaceResult, SearchMatch,
    SearchOptions,
};
use crate::fs::tree::{expand_dir, read_tree, FsNode};
use crate::fs::write::write_file;
use crate::state::AppState;
use std::path::Path;
use tauri::{AppHandle, State};

#[tauri::command]
pub async fn fs_read_tree(project_path: String) -> Result<Vec<FsNode>, NexError> {
    tauri::async_runtime::spawn_blocking(move || read_tree(Path::new(&project_path), 1))
        .await
        .map_err(|e| NexError::FileSystem(format!("fs_read_tree join: {e}")))?
}

#[tauri::command]
pub fn fs_expand_dir(dir_path: String) -> Result<Vec<FsNode>, NexError> {
    expand_dir(Path::new(&dir_path))
}

#[tauri::command]
pub async fn fs_read_file(file_path: String) -> Result<FileContent, NexError> {
    tauri::async_runtime::spawn_blocking(move || read_file(Path::new(&file_path)))
        .await
        .map_err(|e| NexError::FileSystem(format!("fs_read_file join: {e}")))?
}

#[tauri::command]
pub fn fs_write_file(file_path: String, content: String) -> Result<(), NexError> {
    write_file(Path::new(&file_path), &content)
}

/// Starts the debounced watcher for a project (no-op if already watching),
/// which emits `fs-changed` / `git-status-changed` events on external
/// changes. Runs on a blocking pool so recursive watch registration does not
/// freeze the IPC thread. Unwatches every other project (active-only LRU).
#[tauri::command]
pub async fn fs_watch_start(
    app: AppHandle,
    state: State<'_, AppState>,
    project_path: String,
) -> Result<(), NexError> {
    let mgr = state.watcher_manager.clone();
    let graph = state.graph.clone();
    tauri::async_runtime::spawn_blocking(move || {
        mgr.unwatch_except(&project_path);
        mgr.watch(app, &project_path)?;
        graph.ensure(Path::new(&project_path));
        Ok(())
    })
    .await
    .map_err(|e| NexError::FileSystem(format!("fs_watch_start join: {e}")))?
}

/// Stop watching a project path (no-op if not watched).
#[tauri::command]
pub fn fs_watch_stop(state: State<'_, AppState>, project_path: String) -> Result<(), NexError> {
    state.watcher_manager.unwatch(&project_path);
    Ok(())
}

/// Global project search with match rules (case / whole-word / regex).
/// `options = None` keeps the historical case-insensitive substring behavior.
#[tauri::command]
pub fn fs_search(
    project_path: String,
    query: String,
    options: Option<SearchOptions>,
) -> Result<Vec<SearchMatch>, NexError> {
    search(Path::new(&project_path), &query, options)
}

/// Project-wide replace PREVIEW: per-file replacement counts, writes nothing.
/// Honors the same MAX_RESULTS/.gitignore/size constraints as search.
#[tauri::command]
pub fn fs_search_replace(
    project_path: String,
    query: String,
    replacement: String,
    options: Option<SearchOptions>,
) -> Result<ReplacePreview, NexError> {
    search_replace(Path::new(&project_path), &query, &replacement, options)
}

/// Project-wide replace: writes to disk atomically (fs/write.rs).
/// `paths` limits the scope to explicit files (single-file replace);
/// `limit_per_file` caps replacements per file (single-match = Some(1)).
/// After the write, the existing fs-changed watcher syncs open editors
/// (clean → silent reload, dirty → stale banner) — intentionally not
/// suppressed.
#[tauri::command]
pub fn fs_apply_replace(
    project_path: String,
    query: String,
    replacement: String,
    options: Option<SearchOptions>,
    paths: Option<Vec<String>>,
    limit_per_file: Option<usize>,
) -> Result<ReplaceResult, NexError> {
    apply_replace(
        Path::new(&project_path),
        &query,
        &replacement,
        options,
        paths,
        limit_per_file,
    )
}

#[tauri::command]
pub fn fs_create_file(parent_dir: String, name: String) -> Result<(), NexError> {
    create_file(Path::new(&parent_dir), &name)
}

#[tauri::command]
pub fn fs_create_dir(parent_dir: String, name: String) -> Result<(), NexError> {
    create_dir(Path::new(&parent_dir), &name)
}

#[tauri::command]
pub fn fs_delete_entry(path: String) -> Result<(), NexError> {
    delete_entry(Path::new(&path))
}

#[tauri::command]
pub fn fs_rename_entry(path: String, new_name: String) -> Result<(), NexError> {
    rename_entry(Path::new(&path), &new_name)
}

#[tauri::command]
pub fn fs_copy_entry(source: String, target_dir: String) -> Result<String, NexError> {
    copy_entry(Path::new(&source), Path::new(&target_dir))
        .map(|dest| dest.to_string_lossy().to_string())
}

#[tauri::command]
pub fn fs_move_entry(source: String, target_dir: String) -> Result<(), NexError> {
    move_entry(Path::new(&source), Path::new(&target_dir))
}

/// Import external files/directories (e.g. from OS drag-and-drop) into a
/// target directory.  Handles name conflicts by appending a numeric suffix.
/// Returns the list of destination paths.
#[tauri::command]
pub fn fs_import_files(sources: Vec<String>, target_dir: String) -> Result<Vec<String>, NexError> {
    let target = Path::new(&target_dir);
    let mut results = Vec::with_capacity(sources.len());
    for src in &sources {
        let dest = import_file(Path::new(src), target)?;
        results.push(dest.to_string_lossy().into_owned());
    }
    Ok(results)
}
