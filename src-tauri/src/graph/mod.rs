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
        let mut map = statuses.lock().unwrap_or_else(|e| e.into_inner());
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
        let mut g = status.inner.lock().unwrap_or_else(|e| e.into_inner());
        g.indexing = true;
        status.cv.notify_all();
    }
    // A panic inside the job (a crate assert like ignore's gitignore matcher,
    // a sqlite unwrap) must not kill the worker thread: the channel would
    // keep accepting jobs nobody consumes and indexing would silently stop
    // for the rest of the session. Contain it here and record a failure —
    // the job's own locks are never held across f(), but recover from a
    // poisoned one anyway so a future job can't re-kill the thread here.
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(f))
        .map_err(|e| {
            let msg = e
                .downcast_ref::<String>()
                .cloned()
                .or_else(|| e.downcast_ref::<&str>().map(|s| s.to_string()))
                .unwrap_or_else(|| "unknown panic".to_string());
            format!("index job panicked: {msg}")
        })
        .and_then(|r| r);
    let mut g = status.inner.lock().unwrap_or_else(|e| e.into_inner());
    g.indexing = false;
    match result {
        Ok(stats) => {
            g.ready = true;
            g.done = stats.parsed + stats.skipped;
            g.total = stats.scanned;
        }
        Err(e) => {
            // `ready` keeps its last-good value: an already-indexed project
            // stays queryable (with stale data) rather than going dark. The
            // failure surfaces in the log only.
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
    fn run_job_survives_a_panicking_job() {
        let statuses: Mutex<HashMap<PathBuf, Arc<ProjectStatus>>> = Mutex::new(HashMap::new());
        let cwd = std::env::temp_dir().join("nex-graph-panic-probe");
        run_job(&statuses, &cwd, || panic!("boom"));
        // The panic must be contained: the job reports failure and leaves no
        // stuck "indexing" state. (Before catch_unwind, this killed the
        // worker thread and every later job was silently dropped.)
        let key = canonical_or(&cwd);
        let status = statuses.lock().unwrap().get(&key).cloned().unwrap();
        let g = status.inner.lock().unwrap();
        assert!(!g.indexing, "a panicked job must not leave indexing=true");
        assert!(!g.ready, "a first-job panic must not mark the project ready");
        drop(g);

        // A panic AFTER a successful index keeps the last-good `ready` flag:
        // the project stays queryable with stale data instead of going dark.
        let ok = index::BuildStats { parsed: 3, skipped: 1, ..Default::default() };
        run_job(&statuses, &cwd, || Ok(ok));
        run_job(&statuses, &cwd, || panic!("boom again"));
        let g = status.inner.lock().unwrap();
        assert!(g.ready, "a later panic must keep the last-good ready flag");
        assert!(!g.indexing, "a panicked job must not leave indexing=true");
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
