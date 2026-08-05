use ignore::WalkBuilder;
use serde::Serialize;
use std::path::Path;
use crate::error::NexError;

#[derive(Debug, Clone, Serialize)]
pub struct FsNode {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: Option<u64>,
}

/// Directory names always skipped in the file tree regardless of gitignore
/// (vcs metadata / dependency caches — noise, huge, and walking them stalls).
const SKIP_DIR_NAMES: &[&str] = &["node_modules", ".git"];

pub fn read_tree(root: &Path, depth: usize) -> Result<Vec<FsNode>, NexError> {
    let mut nodes = Vec::new();
    // NOTE: git_ignore/git_exclude are OFF on purpose — honoring .gitignore
    // hid legitimate directories (e.g. ignored `storage/`) from the tree.
    // The tree is a file manager view, not a git view.
    let walker = WalkBuilder::new(root)
        .max_depth(Some(depth))
        .hidden(false)
        .git_ignore(false)
        .git_exclude(false)
        .require_git(false)
        .filter_entry(|entry| {
            if !entry.file_type().is_some_and(|ft| ft.is_dir()) {
                return true;
            }
            let name = entry.file_name().to_string_lossy();
            !SKIP_DIR_NAMES.contains(&name.as_ref())
        })
        .build();

    for entry in walker.flatten() {
        let path = entry.path();
        if path == root { continue; }
        let metadata = entry.metadata().map_err(|e| NexError::FileSystem(e.to_string()))?;
        nodes.push(FsNode {
            name: path.file_name().unwrap_or_default().to_string_lossy().to_string(),
            path: path.to_string_lossy().to_string(),
            is_dir: metadata.is_dir(),
            size: if metadata.is_file() { Some(metadata.len()) } else { None },
        });
    }

    // Sort: directories first, then alphabetical
    nodes.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });

    Ok(nodes)
}

pub fn expand_dir(dir_path: &Path) -> Result<Vec<FsNode>, NexError> {
    read_tree(dir_path, 1)
        .map(|nodes| nodes.into_iter().filter(|n| n.path != dir_path.to_string_lossy()).collect())
}
