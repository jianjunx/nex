//! On-disk layout for the per-project code graph cache.
//!
//! ```text
//! <cwd>/.nex/cache/.gitignore     # "*" so sqlite never gets committed
//! <cwd>/.nex/cache/graph/index.sqlite
//! <cwd>/.nex/cache/graph/meta.json
//! ```

use std::path::{Path, PathBuf};

/// `<cwd>/.nex/cache`
pub fn cache_dir(cwd: &Path) -> PathBuf {
    cwd.join(".nex").join("cache")
}

/// `<cwd>/.nex/cache/graph`
pub fn graph_dir(cwd: &Path) -> PathBuf {
    cache_dir(cwd).join("graph")
}

/// SQLite index path.
pub fn db_path(cwd: &Path) -> PathBuf {
    graph_dir(cwd).join("index.sqlite")
}

/// Sidecar metadata (schema version, freshness) for humans and the indexer.
pub fn meta_path(cwd: &Path) -> PathBuf {
    graph_dir(cwd).join("meta.json")
}

/// Optional committed config.
pub fn config_path(cwd: &Path) -> PathBuf {
    cwd.join(".nex").join("graph.toml")
}

/// Creates `.nex/cache/graph/` and a `cache/.gitignore` of `*` if missing.
pub fn ensure_layout(cwd: &Path) -> Result<(), String> {
    let graph = graph_dir(cwd);
    std::fs::create_dir_all(&graph)
        .map_err(|e| format!("cannot create {}: {e}", graph.display()))?;
    let gi = cache_dir(cwd).join(".gitignore");
    if !gi.exists() {
        let _ = std::fs::write(&gi, "*\n");
    }
    Ok(())
}

/// Workspace-relative path using `/` separators (stable across Windows).
pub fn rel_path(cwd: &Path, file: &Path) -> String {
    file.strip_prefix(cwd)
        .unwrap_or(file)
        .components()
        .map(|c| c.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/")
}
