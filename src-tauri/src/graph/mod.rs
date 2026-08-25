//! Host-side code graph: tree-sitter index stored under `.nex/cache/graph`.
//!
//! [`GraphService`] is process-wide (one worker thread, one sqlite per
//! project). Nex Agent talks to it through the `code_graph` builtin tool;
//! the file watcher feeds incremental updates.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

pub mod config;
pub mod index;
pub mod parse;
pub mod paths;
pub mod query;
pub mod store;

enum Job {
    Ensure(PathBuf),
    Invalidate { cwd: PathBuf, paths: Vec<PathBuf> },
}

#[derive(Debug, Clone, Default)]
struct StatusInner {
    indexing: bool,
    ready: bool,
    done: usize,
    total: usize,
}

struct ProjectStatus {
    inner: Mutex<StatusInner>,
    cv: Condvar,
}

/// Process-wide indexer. Cheap to clone (`Arc`).
#[derive(Clone)]
pub struct GraphService {
    tx: std::sync::mpsc::Sender<Job>,
    statuses: Arc<Mutex<HashMap<PathBuf, Arc<ProjectStatus>>>>,
}

impl GraphService {
    pub fn new() -> Self {
        let (tx, rx) = std::sync::mpsc::channel::<Job>();
        let statuses: Arc<Mutex<HashMap<PathBuf, Arc<ProjectStatus>>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let statuses_w = Arc::clone(&statuses);
        std::thread::Builder::new()
            .name("nex-code-graph".into())
            .spawn(move || worker(rx, statuses_w))
            .expect("code graph worker thread");
        Self { tx, statuses }
    }

    /// Cloneable handle for tools / native sessions.
    pub fn handle(&self) -> GraphHandle {
        GraphHandle {
            service: Some(self.clone()),
        }
    }

    /// Fire-and-forget full (incremental) index of `cwd`.
    pub fn ensure(&self, cwd: &Path) {
        if self.peek(cwd).ready {
            return;
        }
        let _ = self.tx.send(Job::Ensure(cwd.to_path_buf()));
    }

    /// Non-blocking snapshot of the project's index status.
    pub fn peek(&self, cwd: &Path) -> IndexSnapshot {
        let key = canonical_or(cwd);
        let status = {
            let mut map = self.statuses.lock().unwrap();
            map.entry(key)
                .or_insert_with(|| {
                    Arc::new(ProjectStatus {
                        inner: Mutex::new(StatusInner::default()),
                        cv: Condvar::new(),
                    })
                })
                .clone()
        };
        let guard = status.inner.lock().unwrap();
        IndexSnapshot::from_inner(&guard)
    }

    /// Incremental update for a batch of changed paths.
    pub fn invalidate(&self, cwd: &Path, paths: &[String]) {
        if paths.is_empty() {
            return;
        }
        let paths: Vec<PathBuf> = paths.iter().map(PathBuf::from).collect();
        let _ = self.tx.send(Job::Invalidate {
            cwd: cwd.to_path_buf(),
            paths,
        });
    }

    /// Listener suitable for [`crate::watcher::WatcherManager::subscribe`].
    pub fn fs_listener(&self) -> crate::watcher::FsChangedListener {
        let this = self.clone();
        Arc::new(move |project, paths| {
            this.invalidate(Path::new(project), paths);
        })
    }

    /// Block until the project has completed at least one successful index,
    /// or `timeout` elapses. Wakes on status changes but keeps waiting while
    /// `ready` is still false (the worker notifies once when it *starts*).
    pub fn wait_ready(&self, cwd: &Path, timeout: Duration) -> IndexSnapshot {
        let key = canonical_or(cwd);
        let status = {
            let mut map = self.statuses.lock().unwrap();
            map.entry(key)
                .or_insert_with(|| {
                    Arc::new(ProjectStatus {
                        inner: Mutex::new(StatusInner::default()),
                        cv: Condvar::new(),
                    })
                })
                .clone()
        };
        let mut guard = status.inner.lock().unwrap();
        if guard.ready {
            return IndexSnapshot::from_inner(&guard);
        }
        let deadline = std::time::Instant::now() + timeout;
        loop {
            let remaining = deadline.saturating_duration_since(std::time::Instant::now());
            if remaining.is_zero() {
                return IndexSnapshot::from_inner(&guard);
            }
            let (g, timed) = status.cv.wait_timeout(guard, remaining).unwrap();
            guard = g;
            if guard.ready || timed.timed_out() {
                return IndexSnapshot::from_inner(&guard);
            }
        }
    }
}

impl Default for GraphService {
    fn default() -> Self {
        Self::new()
    }
}

fn worker(
    rx: std::sync::mpsc::Receiver<Job>,
    statuses: Arc<Mutex<HashMap<PathBuf, Arc<ProjectStatus>>>>,
) {
    while let Ok(job) = rx.recv() {
        match job {
            Job::Ensure(cwd) => {
                run_job(&statuses, &cwd, || index::build_project(&cwd));
            }
            Job::Invalidate { cwd, paths } => {
                run_job(&statuses, &cwd, || index::update_paths(&cwd, &paths));
            }
        }
    }
}

fn run_job<F>(statuses: &Mutex<HashMap<PathBuf, Arc<ProjectStatus>>>, cwd: &Path, f: F)
where
    F: FnOnce() -> Result<index::BuildStats, String>,
{
    let key = canonical_or(cwd);
    let status = {
        let mut map = statuses.lock().unwrap();
        map.entry(key)
            .or_insert_with(|| {
                Arc::new(ProjectStatus {
                    inner: Mutex::new(StatusInner::default()),
                    cv: Condvar::new(),
                })
            })
            .clone()
    };
    {
        let mut g = status.inner.lock().unwrap();
        g.indexing = true;
        status.cv.notify_all();
    }
    let result = f();
    let mut g = status.inner.lock().unwrap();
    g.indexing = false;
    match result {
        Ok(stats) => {
            g.ready = true;
            g.done = stats.parsed + stats.skipped;
            g.total = stats.scanned;
        }
        Err(e) => {
            log::warn!("code graph index failed for {}: {e}", cwd.display());
        }
    }
    status.cv.notify_all();
}

fn canonical_or(cwd: &Path) -> PathBuf {
    cwd.canonicalize().unwrap_or_else(|_| cwd.to_path_buf())
}

/// Point-in-time indexer status, returned by [`GraphService::wait_ready`].
#[derive(Debug, Clone)]
pub struct IndexSnapshot {
    pub ready: bool,
    pub indexing: bool,
    pub done: usize,
    pub total: usize,
}

impl IndexSnapshot {
    fn from_inner(s: &StatusInner) -> Self {
        Self {
            ready: s.ready,
            indexing: s.indexing,
            done: s.done,
            total: s.total,
        }
    }

    pub fn banner(&self) -> Option<String> {
        if self.ready && !self.indexing {
            return None;
        }
        Some(format!(
            "indexing: {}/{} files{}\n",
            self.done,
            self.total.max(self.done),
            if self.ready { "" } else { " (partial)" }
        ))
    }
}

/// Handle held by native-agent sessions. `None` service means "query the
/// on-disk index if present" (tests).
#[derive(Clone, Default)]
pub struct GraphHandle {
    service: Option<GraphService>,
}

impl GraphHandle {
    pub fn query(&self, cwd: &Path, args: &serde_json::Value) -> Result<String, String> {
        let req = query::QueryReq::from_args(args)?;
        let mut prefix = String::new();
        if let Some(svc) = &self.service {
            svc.ensure(cwd);
            let snap = svc.wait_ready(cwd, Duration::from_secs(8));
            if let Some(b) = snap.banner() {
                prefix.push_str(&b);
            }
        } else if !paths::db_path(cwd).exists() {
            return Err("code graph is not available in this session".into());
        }
        match query::execute(cwd, &req) {
            Ok(body) => Ok(format!("{prefix}{body}")),
            Err(e) if prefix.is_empty() => Err(e),
            Err(e) => Ok(format!("{prefix}{e}")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn end_to_end_search_and_callers() {
        let tmp = tempfile::tempdir().unwrap();
        let cwd = tmp.path();
        std::fs::create_dir_all(cwd.join("src")).unwrap();
        std::fs::write(
            cwd.join("src/lib.rs"),
            "pub fn target() {}\npub fn caller() { target(); }\n",
        )
        .unwrap();
        index::build_project(cwd).unwrap();
        let handle = GraphHandle::default();
        let search = handle
            .query(
                cwd,
                &serde_json::json!({"action": "search", "query": "target"}),
            )
            .unwrap();
        assert!(search.contains("target"), "{search}");
        let callers = handle
            .query(
                cwd,
                &serde_json::json!({
                    "action": "query",
                    "pattern": "callers_of",
                    "target": "target"
                }),
            )
            .unwrap();
        assert!(callers.contains("caller"), "{callers}");
        let overview = handle
            .query(cwd, &serde_json::json!({"action": "overview"}))
            .unwrap();
        assert!(overview.contains("files="), "{overview}");
    }

    #[test]
    fn wait_ready_does_not_return_on_indexing_started() {
        let tmp = tempfile::tempdir().unwrap();
        let cwd = tmp.path();
        std::fs::create_dir_all(cwd.join("src")).unwrap();
        std::fs::write(
            cwd.join("src/lib.rs"),
            "pub fn target() {}\npub fn caller() { target(); }\n",
        )
        .unwrap();
        let svc = GraphService::new();
        svc.ensure(cwd);
        let snap = svc.wait_ready(cwd, Duration::from_secs(30));
        assert!(
            snap.ready,
            "first wait must see a finished index, got {snap:?}"
        );
        let search = svc
            .handle()
            .query(
                cwd,
                &serde_json::json!({"action": "search", "query": "target"}),
            )
            .unwrap();
        assert!(search.contains("target"), "{search}");
        // A later query must not enqueue another full walk.
        assert!(svc.peek(cwd).ready);
        svc.ensure(cwd);
        assert!(
            !svc.peek(cwd).indexing,
            "ensure on a ready project must be a no-op"
        );
    }
}
