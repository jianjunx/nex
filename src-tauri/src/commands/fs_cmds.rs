//! Filesystem Tauri commands.
//!
//! Sync commands run on the main thread, so anything that walks the project
//! tree (read/search/replace) goes on the blocking pool as an `async fn` +
//! `tauri::async_runtime::spawn_blocking` — see `fs_watch_start` for the
//! pattern. Single-file / single-entry operations stay sync (cheap, and the
//! UI is idle while they run).

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
/// Blocking-pool (see module docs): a full-tree walk + read + line-regex
/// takes seconds on large projects and must not block the main thread.
#[tauri::command]
pub async fn fs_search(
    project_path: String,
    query: String,
    options: Option<SearchOptions>,
) -> Result<Vec<SearchMatch>, NexError> {
    tauri::async_runtime::spawn_blocking(move || search(Path::new(&project_path), &query, options))
        .await
        .map_err(|e| NexError::FileSystem(format!("fs_search join: {e}")))?
}

/// Project-wide replace PREVIEW: per-file replacement counts, writes nothing.
/// Honors the same MAX_RESULTS/.gitignore/size constraints as search.
/// Blocking-pool (see module docs).
#[tauri::command]
pub async fn fs_search_replace(
    project_path: String,
    query: String,
    replacement: String,
    options: Option<SearchOptions>,
) -> Result<ReplacePreview, NexError> {
    tauri::async_runtime::spawn_blocking(move || {
        search_replace(Path::new(&project_path), &query, &replacement, options)
    })
    .await
    .map_err(|e| NexError::FileSystem(format!("fs_search_replace join: {e}")))?
}

/// Project-wide replace: writes to disk atomically (fs/write.rs).
/// `paths` limits which files get rewritten (the whole tree is still walked
/// to find them — see replace_candidates); `limit_per_file` caps
/// replacements per file (single-match = Some(1)).
/// After the write, the existing fs-changed watcher syncs open editors
/// (clean → silent reload, dirty → stale banner) — intentionally not
/// suppressed. Blocking-pool (see module docs).
#[tauri::command]
pub async fn fs_apply_replace(
    project_path: String,
    query: String,
    replacement: String,
    options: Option<SearchOptions>,
    paths: Option<Vec<String>>,
    limit_per_file: Option<usize>,
) -> Result<ReplaceResult, NexError> {
    tauri::async_runtime::spawn_blocking(move || {
        apply_replace(
            Path::new(&project_path),
            &query,
            &replacement,
            options,
            paths,
            limit_per_file,
        )
    })
    .await
    .map_err(|e| NexError::FileSystem(format!("fs_apply_replace join: {e}")))?
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
pub async fn fs_import_files(
    sources: Vec<String>,
    target_dir: String,
) -> Result<Vec<String>, NexError> {
    tauri::async_runtime::spawn_blocking(move || {
        let target = Path::new(&target_dir);
        let mut results = Vec::with_capacity(sources.len());
        for src in &sources {
            let dest = import_file(Path::new(src), target)?;
            results.push(dest.to_string_lossy().into_owned());
        }
        Ok(results)
    })
    .await
    .map_err(|e| NexError::FileSystem(format!("fs_import_files join: {e}")))?
}

/// Open directories, or reveal files, in the system file manager.
#[tauri::command]
pub async fn fs_reveal_entry(path: String) -> Result<(), NexError> {
    let path = std::path::PathBuf::from(path);
    let path = if path.is_absolute() {
        path
    } else {
        std::env::current_dir()?.join(path)
    };
    let is_dir = std::fs::metadata(&path)?.is_dir();
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = std::process::Command::new("open");
        if !is_dir {
            command.arg("-R");
        }
        command.arg(&path);
        command
    };
    #[cfg(target_os = "windows")]
    let mut command = {
        let mut command = std::process::Command::new("explorer.exe");
        if is_dir {
            command.arg(&path);
        } else {
            command.arg(format!("/select,{}", path.display()));
        }
        command
    };
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut command = {
        let mut command = std::process::Command::new("xdg-open");
        command.arg(if is_dir {
            path.as_path()
        } else {
            path.parent().unwrap_or(&path)
        });
        command
    };
    command
        .spawn()
        .map_err(|e| NexError::FileSystem(format!("打开文件管理器失败: {e}")))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::fs;
    use tempfile::tempdir;

    #[tokio::test]
    async fn native_drop_imports_files_and_nested_folders_without_overwriting() {
        let external = tempdir().unwrap();
        let project = tempdir().unwrap();
        let target = project.path().join("selected-directory");
        fs::create_dir(&target).unwrap();
        fs::write(target.join("readme.txt"), "existing").unwrap();
        fs::write(external.path().join("readme.txt"), "imported").unwrap();
        fs::create_dir_all(external.path().join("assets/nested")).unwrap();
        fs::write(external.path().join("assets/nested/file.txt"), "nested").unwrap();
        let imported = super::fs_import_files(
            vec![
                external
                    .path()
                    .join("readme.txt")
                    .to_string_lossy()
                    .into_owned(),
                external
                    .path()
                    .join("assets")
                    .to_string_lossy()
                    .into_owned(),
            ],
            target.to_string_lossy().into_owned(),
        )
        .await
        .unwrap();
        assert_eq!(imported.len(), 2);
        assert_eq!(
            fs::read_to_string(target.join("readme.txt")).unwrap(),
            "existing"
        );
        assert_eq!(
            fs::read_to_string(target.join("readme (1).txt")).unwrap(),
            "imported"
        );
        assert_eq!(
            fs::read_to_string(target.join("assets/nested/file.txt")).unwrap(),
            "nested"
        );
        assert!(external.path().join("readme.txt").exists());
        assert!(external.path().join("assets/nested/file.txt").exists());
    }
}
