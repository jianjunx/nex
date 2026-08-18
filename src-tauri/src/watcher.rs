//! Filesystem watchers for external changes.
//!
//! Each watched project gets a debounced recursive watcher
//! (`notify-debouncer-full`, 500ms). On every batch of debounced events the
//! watcher emits `fs-changed` (with the changed paths) and
//! `git-status-changed` so the frontend can refresh the file tree and git
//! status. Debounced batches, not raw events, keep noisy edits (agent
//! writes, build output) from flooding the frontend.
//!
//! Batches that only touch Nex-generated cache/archive (`.nex/cache`,
//! `.nex-archive`) are dropped: those writes are not workspace edits, and
//! forwarding them would refresh git status in a loop when the code graph
//! indexer writes sqlite/meta.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_full::{new_debouncer, DebounceEventResult, Debouncer, RecommendedCache};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::error::NexError;

/// Name of the event emitted when watched files change; must match
/// `EVENTS.FS_CHANGED` in `src/bridge/events.ts`.
const FS_CHANGED_EVENT: &str = "fs-changed";

/// Name of the event emitted when a watched project may have a changed git
/// status; must match `EVENTS.GIT_STATUS_CHANGED` in `src/bridge/events.ts`.
const GIT_STATUS_CHANGED_EVENT: &str = "git-status-changed";

/// Payload of the `fs-changed` event. Field names must stay camelCase to
/// match `FsChangedPayload` in `src/bridge/events.ts`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsChangedPayload {
    pub project_path: String,
    pub paths: Vec<String>,
}

/// Payload of the `git-status-changed` event. Field names must stay
/// camelCase to match `GitStatusChangedPayload` in `src/bridge/events.ts`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatusChangedPayload {
    pub project_path: String,
}

type ProjectDebouncer = Debouncer<RecommendedWatcher, RecommendedCache>;

/// Host-side listener invoked with (project_path, changed_paths) after each
/// debounced batch. Used by the code graph indexer; UI still gets events.
pub type FsChangedListener = Arc<dyn Fn(&str, &[String]) + Send + Sync>;

/// Manages one debounced watcher per project path.
///
/// Dropping a `Debouncer` from the map stops its watcher thread.
pub struct WatcherManager {
    watchers: Arc<Mutex<HashMap<String, ProjectDebouncer>>>,
    listeners: Arc<Mutex<Vec<FsChangedListener>>>,
}

impl Clone for WatcherManager {
    fn clone(&self) -> Self {
        Self {
            watchers: Arc::clone(&self.watchers),
            listeners: Arc::clone(&self.listeners),
        }
    }
}

impl WatcherManager {
    pub fn new() -> Self {
        Self {
            watchers: Arc::new(Mutex::new(HashMap::new())),
            listeners: Arc::new(Mutex::new(Vec::new())),
        }
    }

    pub fn subscribe(&self, listener: FsChangedListener) {
        self.listeners.lock().unwrap().push(listener);
    }

    /// Starts watching `project_path` recursively; no-op if already watched.
    /// The callback runs on the debouncer's background thread and emits both
    /// events per batch (emit errors are ignored — no listeners is normal).
    pub fn watch(&self, app: AppHandle, project_path: &str) -> Result<(), NexError> {
        let mut watchers = self.watchers.lock().unwrap();
        if watchers.contains_key(project_path) {
            return Ok(());
        }

        let emit_path = project_path.to_string();
        let listeners = Arc::clone(&self.listeners);
        let mut debouncer = new_debouncer(
            Duration::from_millis(500),
            None,
            move |result: DebounceEventResult| {
                match result {
                    Ok(events) => {
                        let paths: Vec<String> = events
                            .iter()
                            .flat_map(|e| e.event.paths.iter())
                            .map(|p| p.to_string_lossy().into_owned())
                            .collect();
                        let paths = user_facing_paths(&paths);
                        if paths.is_empty() {
                            return;
                        }
                        let _ = app.emit(
                            FS_CHANGED_EVENT,
                            FsChangedPayload { project_path: emit_path.clone(), paths: paths.clone() },
                        );
                        let _ = app.emit(
                            GIT_STATUS_CHANGED_EVENT,
                            GitStatusChangedPayload { project_path: emit_path.clone() },
                        );
                        for listener in listeners.lock().unwrap().iter() {
                            listener(&emit_path, &paths);
                        }
                    }
                    Err(errors) => {
                        for error in errors {
                            log::error!("fs watcher error: {error}");
                        }
                    }
                }
            },
        )
        .map_err(|e| NexError::FileSystem(format!("failed to create fs watcher: {e}")))?;

        debouncer
            .watch(Path::new(project_path), RecursiveMode::Recursive)
            .map_err(|e| NexError::FileSystem(format!("failed to watch `{project_path}`: {e}")))?;

        watchers.insert(project_path.to_string(), debouncer);
        Ok(())
    }

    /// Stop watching a project path (no-op if not watched).
    pub fn unwatch(&self, project_path: &str) {
        let mut watchers = self.watchers.lock().unwrap();
        watchers.remove(project_path);
    }

    /// Keep only `keep_path` watched; drop every other watcher (LRU=1 active).
    pub fn unwatch_except(&self, keep_path: &str) {
        let mut watchers = self.watchers.lock().unwrap();
        watchers.retain(|path, _| path == keep_path);
    }
}

/// Paths the UI / git panel / graph indexer should see.
///
/// Drops Nex-generated cache and archive writes so they cannot retrigger
/// git refresh or a graph `write_meta` loop.
fn user_facing_paths(paths: &[String]) -> Vec<String> {
    paths
        .iter()
        .filter(|p| !is_nex_internal_path(p))
        .cloned()
        .collect()
}

/// True for Nex-generated cache/archive paths (absolute or relative, `/` or `\`).
fn is_nex_internal_path(path: &str) -> bool {
    let n = path.replace('\\', "/");
    n.contains("/.nex/cache/")
        || n.ends_with("/.nex/cache")
        || n.starts_with(".nex/cache/")
        || n == ".nex/cache"
        || n.contains("/.nex-archive/")
        || n.ends_with("/.nex-archive")
        || n.starts_with(".nex-archive/")
        || n == ".nex-archive"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nex_cache_and_archive_are_internal() {
        assert!(is_nex_internal_path("/proj/.nex/cache/graph/index.sqlite"));
        assert!(is_nex_internal_path("/proj/.nex/cache/graph/index.sqlite-wal"));
        assert!(is_nex_internal_path("/proj/.nex/cache"));
        assert!(is_nex_internal_path(r"C:\proj\.nex\cache\graph\meta.json"));
        assert!(is_nex_internal_path("/proj/.nex-archive/foo"));
        assert!(is_nex_internal_path(".nex/cache/graph/meta.json"));
        assert!(!is_nex_internal_path("/proj/.nex/rules/foo.md"));
        assert!(!is_nex_internal_path("/proj/.nex/mcp.json"));
        assert!(!is_nex_internal_path("/proj/src/lib.rs"));
    }

    #[test]
    fn user_paths_drops_internal_only_batches() {
        let mixed = user_facing_paths(&[
            "/p/.nex/cache/graph/index.sqlite".into(),
            "/p/src/a.rs".into(),
        ]);
        assert_eq!(mixed, vec!["/p/src/a.rs"]);
        assert!(user_facing_paths(&["/p/.nex/cache/x".into()]).is_empty());
    }
}
