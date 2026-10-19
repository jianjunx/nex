//! Read-only per-turn baselines; never stage files or write Git objects.
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};
use std::io::Read;
use std::path::{Path, PathBuf};

const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES: usize = 32 * 1024 * 1024;

pub struct Snapshot(BTreeMap<PathBuf, Option<String>>);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    pub path: String,
    pub old_text: String,
    pub new_text: String,
}

impl Snapshot {
    #[cfg(test)]
    fn capture(root: &Path) -> Result<Self, String> {
        Self::capture_with_paths(root, BTreeSet::new())
    }

    fn capture_with_paths(root: &Path, mut paths: BTreeSet<PathBuf>) -> Result<Self, String> {
        let canonical_root = std::fs::canonicalize(root).map_err(|e| e.to_string())?;
        // Include tracked files even if a later .gitignore excludes them.
        if let Ok(repo) = git2::Repository::discover(root) {
            if let Some(workdir) = repo.workdir() {
                let workdir = std::fs::canonicalize(workdir).map_err(|e| e.to_string())?;
                for entry in repo.index().map_err(|e| e.to_string())?.iter() {
                    if let Ok(name) = std::str::from_utf8(&entry.path) {
                        let path = workdir.join(name);
                        if let Ok(relative) = path.strip_prefix(&canonical_root) {
                            paths.insert(root.join(relative));
                        }
                    }
                }
            }
        }
        for entry in ignore::WalkBuilder::new(root)
            .hidden(false)
            .follow_links(false)
            .filter_entry(|entry| entry.file_name() != ".git")
            .build()
        {
            let entry = entry.map_err(|e| e.to_string())?;
            if entry.file_type().is_some_and(|t| t.is_file()) {
                paths.insert(entry.into_path());
                if paths.len() > 100_000 {
                    return Err("workspace baseline exceeds 100000 files".into());
                }
            }
        }
        let mut files = BTreeMap::new();
        let mut total = 0;
        for path in paths {
            let meta = match std::fs::symlink_metadata(&path) {
                Ok(meta) => meta,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                Err(e) => return Err(e.to_string()),
            };
            // shortcut: skip binary/symlink/>2 MiB previews; add disk snapshots if larger files need review.
            let content = if meta.is_file() && meta.len() <= MAX_FILE_BYTES {
                let mut bytes = Vec::new();
                std::fs::File::open(&path)
                    .map_err(|e| e.to_string())?
                    .take(MAX_FILE_BYTES + 1)
                    .read_to_end(&mut bytes)
                    .map_err(|e| e.to_string())?;
                total += bytes.len();
                if total > MAX_TOTAL_BYTES {
                    return Err("workspace baseline exceeds 32 MiB".into());
                }
                if bytes.len() as u64 > MAX_FILE_BYTES || bytes.contains(&0) {
                    None
                } else {
                    String::from_utf8(bytes).ok()
                }
            } else {
                None
            };
            files.insert(path, content);
        }
        Ok(Self(files))
    }

    pub fn changes(self, after: Self) -> Vec<FileChange> {
        let paths: BTreeSet<_> = self.0.keys().chain(after.0.keys()).collect();
        paths
            .into_iter()
            .filter_map(|path| {
                let old = self.0.get(path);
                let new = after.0.get(path);
                if matches!(old, Some(None)) || matches!(new, Some(None)) {
                    return None;
                }
                let old = old.and_then(|s| s.as_deref()).unwrap_or("");
                let new = new.and_then(|s| s.as_deref()).unwrap_or("");
                if old == new && self.0.contains_key(path) == after.0.contains_key(path) {
                    return None;
                }
                Some(FileChange {
                    path: path.to_string_lossy().into_owned(),
                    old_text: old.into(),
                    new_text: new.into(),
                })
            })
            .collect()
    }
}

pub async fn capture(root: PathBuf, baseline: Option<&Snapshot>) -> Option<Snapshot> {
    // Re-read baseline paths even when this turn changes the ignore rules.
    let paths = baseline
        .map(|s| s.0.keys().cloned().collect())
        .unwrap_or_default();
    match tauri::async_runtime::spawn_blocking(move || Snapshot::capture_with_paths(&root, paths))
        .await
    {
        Ok(Ok(snapshot)) => Some(snapshot),
        result => {
            log::warn!(
                "turn file preview baseline unavailable: {}",
                match result {
                    Ok(Err(e)) => e,
                    Err(e) => e.to_string(),
                    _ => unreachable!(),
                }
            );
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn captures_shell_edits_new_files_deletions_and_renames_without_prior_dirt() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let repo = git2::Repository::init(root).unwrap();
        std::fs::write(root.join("a.txt"), "already dirty").unwrap();
        std::fs::write(root.join("deleted.txt"), "delete me").unwrap();
        std::fs::write(root.join("rename.txt"), "same").unwrap();
        let before = Snapshot::capture(root).unwrap();
        std::fs::write(root.join("a.txt"), "after").unwrap();
        std::fs::write(root.join("new.txt"), "new").unwrap();
        std::fs::remove_file(root.join("deleted.txt")).unwrap();
        std::fs::rename(root.join("rename.txt"), root.join("renamed.txt")).unwrap();
        let changes = before.changes(Snapshot::capture(root).unwrap());
        assert_eq!(changes.len(), 5);
        assert_eq!(changes[0].old_text, "already dirty");
        assert_eq!(changes[0].new_text, "after");
        assert_eq!(repo.index().unwrap().len(), 0);
    }

    #[test]
    fn ignores_unchanged_and_binary_files_but_includes_ignored_tracked_files() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let repo = git2::Repository::init(root).unwrap();
        std::fs::write(root.join("tracked.txt"), "before").unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(Path::new("tracked.txt")).unwrap();
        index.write().unwrap();
        std::fs::write(root.join(".gitignore"), "*.txt\n").unwrap();
        std::fs::write(root.join("ignored.txt"), "ignored").unwrap();
        std::fs::write(root.join("binary"), [0, 1]).unwrap();
        let before = Snapshot::capture(root).unwrap();
        std::fs::write(root.join("tracked.txt"), "after").unwrap();
        std::fs::write(root.join("ignored.txt"), "changed").unwrap();
        std::fs::write(root.join("binary"), [0, 2]).unwrap();
        let changes = before.changes(Snapshot::capture(root).unwrap());
        assert_eq!(changes.len(), 1);
        assert!(changes[0].path.ends_with("tracked.txt"));
    }

    #[test]
    fn changing_ignore_rules_does_not_report_existing_files_as_deleted() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        git2::Repository::init(root).unwrap();
        std::fs::write(root.join("a.txt"), "same").unwrap();
        let before = Snapshot::capture(root).unwrap();
        std::fs::write(root.join(".gitignore"), "*.txt\n").unwrap();
        let paths = before.0.keys().cloned().collect();
        let changes = before.changes(Snapshot::capture_with_paths(root, paths).unwrap());
        assert_eq!(changes.len(), 1);
        assert!(changes[0].path.ends_with(".gitignore"));
    }

    #[test]
    fn works_without_git_and_reports_empty_file_creation() {
        let dir = tempfile::tempdir().unwrap();
        let before = Snapshot::capture(dir.path()).unwrap();
        std::fs::write(dir.path().join("empty"), "").unwrap();
        assert_eq!(
            before.changes(Snapshot::capture(dir.path()).unwrap()).len(),
            1
        );
    }
}
