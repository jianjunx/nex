//! Walk the workspace and upsert parsed files into the sqlite index.

use std::collections::HashSet;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use ignore::WalkBuilder;
use serde::Serialize;

use super::config::GraphConfig;
use super::parse::{self, Lang};
use super::paths;
use super::store::Store;

/// Skip AST work on huge files (they still wouldn't yield useful symbols).
const MAX_PARSE_BYTES: u64 = 1024 * 1024;

#[derive(Debug, Clone, Default, Serialize)]
pub struct BuildStats {
    pub scanned: usize,
    pub parsed: usize,
    pub skipped: usize,
    pub deleted: usize,
    pub errors: usize,
}

/// Full incremental build: walk the tree, skip unchanged mtime/size/hash.
pub fn build_project(cwd: &Path) -> Result<BuildStats, String> {
    build_inner(cwd, None)
}

/// Re-index only `paths` (absolute or workspace-relative). Missing files
/// are deleted from the store. Paths that do not resolve under the workspace
/// root are ignored entirely (neither indexed nor deleted) — watcher events
/// can address files in a form that does not share the canonicalized root
/// prefix, and the gitignore matcher panics on such paths.
pub fn update_paths(cwd: &Path, paths: &[PathBuf]) -> Result<BuildStats, String> {
    build_inner(cwd, Some(paths))
}

/// Strip the Windows verbatim (`\\?\`) prefix so a path compares equal to its
/// non-verbatim form. No-op on other platforms / already-plain paths.
/// `Path::canonicalize` returns verbatim paths on Windows while watcher
/// events and DB-stored project paths keep the plain form, so every
/// root-prefix comparison must go through this first.
fn strip_verbatim(p: &Path) -> &Path {
    p.strip_prefix(r"\\?\").unwrap_or(p)
}

/// Workspace-relative path of an event path, tolerating the forms watchers
/// actually deliver: verbatim `\\?\` prefixes on Windows (canonicalize adds
/// them, notify does not) and symlinked roots (macOS `/var` → `/private/var`
/// — `canonicalize` resolves the link, the watcher keeps the alias).
/// Returns `None` when the file is genuinely outside the workspace: those are
/// skipped, and must never reach the gitignore matcher (it panics on paths
/// outside its root, which used to kill the worker thread).
fn rel_under_root(cwd: &Path, abs: &Path) -> Option<PathBuf> {
    if let Ok(rel) = strip_verbatim(abs).strip_prefix(strip_verbatim(cwd)) {
        return Some(rel.to_path_buf());
    }
    // Symlinked root: canonicalize the event path and retry against the
    // canonical root. Already-deleted files fail to canonicalize — they are
    // simply not indexed this round (the next full build reaps them).
    let canon = abs.canonicalize().ok()?;
    canon.strip_prefix(cwd).ok().map(|r| r.to_path_buf())
}

/// Walk the workspace and upsert parsed files into the sqlite index.
///
/// Invariant: the gitignore matcher is built with the canonicalized `cwd` as
/// its root, and `matched_path_or_any_parents` panics on paths outside that
/// root — so every path that reaches [`should_skip`] must first be resolved
/// under `cwd` via [`rel_under_root`] and re-anchored with `cwd.join(rel)`.
fn build_inner(cwd: &Path, only: Option<&[PathBuf]>) -> Result<BuildStats, String> {
    let cwd = cwd
        .canonicalize()
        .map_err(|e| format!("cannot resolve workspace: {e}"))?;
    let cfg = GraphConfig::load(&cwd);
    let mut stats = BuildStats::default();
    let gitignore = load_gitignore(&cwd);
    // The gitignore matcher was built with `cwd` as its root; paths outside
    // it must never reach matched_path_or_any_parents (it panics).
    let gitignore_ref = gitignore.as_ref().map(|g| (g, cwd.as_path()));

    if let Some(paths) = only {
        let mut seen = HashSet::new();
        let mut to_index = Vec::new();
        for raw in paths {
            let abs = if raw.is_absolute() {
                raw.clone()
            } else {
                cwd.join(raw)
            };
            // Resolve the event path against the workspace root, tolerating
            // verbatim/plain prefix mismatches (canonicalize vs watcher form)
            // and symlinked roots. Genuinely-outside paths are skipped — and
            // so is anything that would panic the gitignore matcher, which
            // used to kill the worker thread for the rest of the session.
            let Some(rel_os) = rel_under_root(&cwd, &abs) else {
                continue;
            };
            // Re-anchor under the canonical root so every downstream consumer
            // (rel path, gitignore match, fs read) sees one consistent form.
            let abs = cwd.join(&rel_os);
            let rel = paths::rel_path(&cwd, &abs);
            if should_skip(&rel, &abs, &cfg, gitignore_ref) {
                continue;
            }
            if !seen.insert(rel.clone()) {
                continue;
            }
            to_index.push((abs, rel));
        }
        // Watcher can still deliver `.nex/cache` writes; opening sqlite /
        // rewriting meta.json here would retrigger the same batch forever.
        if to_index.is_empty() {
            return Ok(stats);
        }
        let store = Store::open(&cwd)?;
        for (abs, rel) in to_index {
            stats.scanned += 1;
            if abs.is_file() {
                match index_one(&store, &cwd, &abs, &rel, &cfg) {
                    Ok(IndexOutcome::Parsed) => stats.parsed += 1,
                    Ok(IndexOutcome::Skipped) => stats.skipped += 1,
                    Err(_) => stats.errors += 1,
                }
            } else {
                store.delete_file(&rel)?;
                stats.deleted += 1;
            }
        }
        write_meta(&store, &cwd, &stats)?;
        return Ok(stats);
    }

    let store = Store::open(&cwd)?;

    let mut live = HashSet::new();
    let walker = WalkBuilder::new(&cwd)
        .hidden(false)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .require_git(false)
        .filter_entry(|e| {
            let name = e.file_name();
            name != ".git"
                && name != "node_modules"
                && name != "target"
                && name != "dist"
                && name != ".nex"
        })
        .build();

    for entry in walker {
        let Ok(entry) = entry else { continue };
        let Some(ft) = entry.file_type() else {
            continue;
        };
        if !ft.is_file() {
            continue;
        }
        let abs = entry.path();
        let rel = paths::rel_path(&cwd, abs);
        if should_skip(&rel, abs, &cfg, gitignore_ref) {
            continue;
        }
        stats.scanned += 1;
        live.insert(rel.clone());
        match index_one(&store, &cwd, abs, &rel, &cfg) {
            Ok(IndexOutcome::Parsed) => stats.parsed += 1,
            Ok(IndexOutcome::Skipped) => stats.skipped += 1,
            Err(_) => stats.errors += 1,
        }
    }

    for known in store.known_files()? {
        if !live.contains(&known) {
            store.delete_file(&known)?;
            stats.deleted += 1;
        }
    }
    write_meta(&store, &cwd, &stats)?;
    Ok(stats)
}

enum IndexOutcome {
    Parsed,
    Skipped,
}

fn index_one(
    store: &Store,
    cwd: &Path,
    abs: &Path,
    rel: &str,
    cfg: &GraphConfig,
) -> Result<IndexOutcome, String> {
    let Some(lang) = Lang::from_path(abs) else {
        return Ok(IndexOutcome::Skipped);
    };
    if !cfg.language_enabled(lang.id()) {
        return Ok(IndexOutcome::Skipped);
    }
    let meta = std::fs::metadata(abs).map_err(|e| e.to_string())?;
    if meta.len() > MAX_PARSE_BYTES {
        return Ok(IndexOutcome::Skipped);
    }
    let mtime = mtime_ms(&meta);
    let size = meta.len();
    if let Some((om, os, _)) = store.file_stamp(rel) {
        if om == mtime && os == size {
            return Ok(IndexOutcome::Skipped);
        }
    }
    let bytes = std::fs::read(abs).map_err(|e| e.to_string())?;
    let hash = hash_bytes(&bytes);
    if let Some((om, os, oh)) = store.file_stamp(rel) {
        if om == mtime && os == size && oh == hash {
            return Ok(IndexOutcome::Skipped);
        }
    }
    let src = match std::str::from_utf8(&bytes) {
        Ok(s) => s,
        Err(_) => return Ok(IndexOutcome::Skipped),
    };
    let extracted = parse::extract(rel, src, lang)?;
    store.replace_file(rel, lang.id(), mtime, size, hash, &extracted)?;
    let _ = cwd;
    Ok(IndexOutcome::Parsed)
}

fn write_meta(store: &Store, cwd: &Path, stats: &BuildStats) -> Result<(), String> {
    let now = chrono::Utc::now().to_rfc3339();
    store.set_meta("last_build", &now)?;
    store.set_meta("files_scanned", &stats.scanned.to_string())?;
    store.set_meta("files_parsed", &stats.parsed.to_string())?;
    if let Some(head) = git_head(cwd) {
        store.set_meta("git_head", &head)?;
    }
    let files: i64 = store
        .conn()
        .query_row("SELECT COUNT(*) FROM files", [], |r| r.get(0))
        .unwrap_or(0);
    let nodes: i64 = store
        .conn()
        .query_row("SELECT COUNT(*) FROM nodes", [], |r| r.get(0))
        .unwrap_or(0);
    let sidecar = serde_json::json!({
        "schema_version": super::store::SCHEMA_VERSION,
        "last_build": now,
        "files": files,
        "nodes": nodes,
        "scanned": stats.scanned,
        "parsed": stats.parsed,
        "skipped": stats.skipped,
        "deleted": stats.deleted,
        "errors": stats.errors,
    });
    let _ = std::fs::write(
        paths::meta_path(cwd),
        serde_json::to_vec_pretty(&sidecar).unwrap_or_default(),
    );
    Ok(())
}

fn load_gitignore(cwd: &Path) -> Option<ignore::gitignore::Gitignore> {
    let mut b = ignore::gitignore::GitignoreBuilder::new(cwd);
    let gi = cwd.join(".gitignore");
    if gi.exists() {
        let _ = b.add(&gi);
    }
    b.build().ok()
}

fn should_skip(
    rel: &str,
    abs: &Path,
    cfg: &GraphConfig,
    gitignore: Option<(&ignore::gitignore::Gitignore, &Path)>,
) -> bool {
    if rel.starts_with(".nex/") {
        return true;
    }
    if rel
        .split('/')
        .any(|p| matches!(p, ".git" | "node_modules" | "target" | "dist" | ".nex"))
    {
        return true;
    }
    if cfg.is_excluded(rel) {
        return true;
    }
    // matched_path_or_any_parents PANICS on paths outside the matcher's root
    // (its strip leaves a rooted path). Callers normally pre-filter to the
    // workspace; this guard keeps a stray path a no-op instead of a dead
    // worker thread. `gitignore.1` is the root the matcher was built with.
    if let Some((g, root)) = gitignore {
        if abs.strip_prefix(root).is_ok() {
            return g.matched_path_or_any_parents(abs, false).is_ignore();
        }
    }
    false
}

fn git_head(cwd: &Path) -> Option<String> {
    let repo = git2::Repository::open(cwd).ok()?;
    let oid = repo.head().ok()?.target()?;
    Some(oid.to_string())
}

fn mtime_ms(meta: &std::fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn hash_bytes(bytes: &[u8]) -> u64 {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    bytes.hash(&mut h);
    h.finish()
}

/// `git diff --name-only <base>` plus untracked, workspace-relative `/` paths.
/// Non-git folders return an empty list (not an error) so impact queries stay quiet.
pub fn git_changed_files(cwd: &Path, base: &str) -> Result<Vec<String>, String> {
    if !crate::git::repository::has_git_metadata(cwd) {
        return Ok(Vec::new());
    }
    let Ok(repo) = git2::Repository::open(cwd).or_else(|_| git2::Repository::discover(cwd)) else {
        return Ok(Vec::new());
    };
    let obj = repo
        .revparse_single(base)
        .map_err(|e| format!("cannot resolve git ref `{base}`: {e}"))?;
    let tree = obj
        .peel_to_tree()
        .map_err(|e| format!("ref `{base}` is not a tree: {e}"))?;
    let mut opts = git2::DiffOptions::new();
    opts.include_untracked(true).recurse_untracked_dirs(true);
    let diff = repo
        .diff_tree_to_workdir_with_index(Some(&tree), Some(&mut opts))
        .map_err(|e| e.to_string())?;
    let mut files = Vec::new();
    for delta in diff.deltas() {
        if let Some(p) = delta.new_file().path().or_else(|| delta.old_file().path()) {
            files.push(p.to_string_lossy().replace('\\', "/"));
        }
    }
    files.sort();
    files.dedup();
    Ok(files)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::params;

    #[test]
    fn indexes_rust_and_skips_gitignore() {
        let tmp = tempfile::tempdir().unwrap();
        let cwd_buf = tmp.path().canonicalize().unwrap();
        let cwd = cwd_buf.as_path();
        std::fs::write(cwd.join(".gitignore"), "ignored.rs\n").unwrap();
        std::fs::create_dir_all(cwd.join("src")).unwrap();
        std::fs::write(
            cwd.join("src/lib.rs"),
            "pub fn alpha() {}\npub fn beta() { alpha(); }\n",
        )
        .unwrap();
        std::fs::write(cwd.join("ignored.rs"), "pub fn secret() {}\n").unwrap();

        let stats = build_project(cwd).unwrap();
        assert!(stats.parsed >= 1, "{stats:?}");
        let store = Store::open(cwd).unwrap();
        let count: i64 = store
            .conn()
            .query_row("SELECT COUNT(*) FROM nodes WHERE name = 'alpha'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(count, 1);
        let ignored: i64 = store
            .conn()
            .query_row(
                "SELECT COUNT(*) FROM files WHERE path = 'ignored.rs'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(ignored, 0);

        // Incremental: unchanged file is skipped.
        let stats2 = build_project(cwd).unwrap();
        assert_eq!(stats2.parsed, 0, "second build should skip unchanged files");

        std::fs::write(
            cwd.join("src/lib.rs"),
            "pub fn alpha() {}\npub fn gamma() {}\n",
        )
        .unwrap();
        let stats3 = update_paths(cwd, &[cwd.join("src/lib.rs")]).unwrap();
        assert_eq!(stats3.parsed, 1);
        // Re-open: WAL reader may need a new connection.
        let store = Store::open(cwd).unwrap();
        let gamma: i64 = store
            .conn()
            .query_row(
                "SELECT COUNT(*) FROM nodes WHERE name = ?1",
                params!["gamma"],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(gamma, 1);
        let beta: i64 = store
            .conn()
            .query_row("SELECT COUNT(*) FROM nodes WHERE name = 'beta'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(beta, 0);
    }

    #[test]
    fn update_paths_outside_workspace_does_not_panic() {
        // Watcher events can carry paths that do not share the canonicalized
        // root prefix (verbatim \\?\ prefixes, symlinked temp dirs). The
        // gitignore matcher panics on paths outside its root, which used to
        // kill the code-graph worker thread for the rest of the session.
        let tmp = tempfile::tempdir().unwrap();
        let cwd_buf = tmp.path().canonicalize().unwrap();
        let cwd = cwd_buf.as_path();
        std::fs::write(cwd.join(".gitignore"), "*.log\n").unwrap();
        std::fs::create_dir_all(cwd.join("src")).unwrap();
        std::fs::write(cwd.join("src/lib.rs"), "pub fn alpha() {}\n").unwrap();
        // A real file outside the workspace, addressed in non-canonical form.
        let outside = std::env::temp_dir().join("nex-graph-outside-probe.rs");
        std::fs::write(&outside, "pub fn stranger() {}\n").unwrap();

        let stats = update_paths(cwd, std::slice::from_ref(&outside));
        assert!(stats.is_ok(), "outside path must not panic: {stats:?}");
        let stats = stats.unwrap();
        assert_eq!(stats.scanned, 0, "outside path must not be indexed");

        let store = Store::open(cwd).unwrap();
        let stranger: i64 = store
            .conn()
            .query_row(
                "SELECT COUNT(*) FROM nodes WHERE name = 'stranger'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(stranger, 0);
        let _ = std::fs::remove_file(&outside);

        // The same file addressed in watcher form (plain prefix, root
        // canonicalized to verbatim on Windows) MUST still be indexed —
        // skipping it would silently stop all incremental indexing.
        let plain_cwd = PathBuf::from(cwd.to_string_lossy().trim_start_matches(r"\\?\"));
        let watcher_path = plain_cwd.join("src/lib.rs");
        assert_ne!(watcher_path, cwd.join("src/lib.rs"));
        let stats = update_paths(cwd, std::slice::from_ref(&watcher_path)).unwrap();
        assert_eq!(stats.parsed, 1, "watcher-form path must be indexed: {stats:?}");
    }

    #[test]
    fn cache_only_invalidate_does_not_rewrite_meta() {
        let tmp = tempfile::tempdir().unwrap();
        let cwd = tmp.path().canonicalize().unwrap();
        std::fs::create_dir_all(cwd.join("src")).unwrap();
        std::fs::write(cwd.join("src/lib.rs"), "pub fn alpha() {}\n").unwrap();
        build_project(&cwd).unwrap();
        let meta_path = cwd.join(".nex/cache/graph/meta.json");
        let before = std::fs::read(&meta_path).unwrap();

        let stats = update_paths(&cwd, &[cwd.join(".nex/cache/graph/index.sqlite")]).unwrap();
        assert_eq!(stats.scanned, 0);
        let after = std::fs::read(&meta_path).unwrap();
        assert_eq!(
            before, after,
            "cache-only invalidate must not rewrite meta.json"
        );
    }

    #[test]
    fn git_changed_files_is_empty_without_a_repo() {
        let tmp = tempfile::tempdir().unwrap();
        let files = git_changed_files(tmp.path(), "HEAD~1").unwrap();
        assert!(files.is_empty(), "{files:?}");
    }
}
