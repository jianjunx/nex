//! Filesystem watchers for external changes.
//!
//! Each watched project gets a debounced recursive watcher
//! (`notify-debouncer-full`, 500ms). On every batch of debounced events the
//! watcher emits `fs-changed` (with the changed paths) and
//! `git-status-changed` so the frontend can refresh the file tree and git
//! status. Debounced batches, not raw events, keep noisy edits (agent
//! writes, build output) from flooding the frontend.

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

/// Manages one debounced watcher per project path.
///
/// The `Debouncer` must stay in the map: dropping it stops the watcher
/// thread. v1 never unwatches — watchers live until app exit.
pub struct WatcherManager {
    watchers: Arc<Mutex<HashMap<String, ProjectDebouncer>>>,
}

impl WatcherManager {
    pub fn new() -> Self {
        Self { watchers: Arc::new(Mutex::new(HashMap::new())) }
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
                        let _ = app.emit(
                            FS_CHANGED_EVENT,
                            FsChangedPayload { project_path: emit_path.clone(), paths },
                        );
                        let _ = app.emit(
                            GIT_STATUS_CHANGED_EVENT,
                            GitStatusChangedPayload { project_path: emit_path.clone() },
                        );
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
}
