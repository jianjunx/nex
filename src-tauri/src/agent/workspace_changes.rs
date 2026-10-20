//! Read-only per-turn baselines; never stage files or write Git objects.
use serde::Serialize;
use std::borrow::Cow;
use std::collections::{BTreeMap, BTreeSet};
use std::io::Read;
use std::path::{Path, PathBuf};

const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES: usize = 32 * 1024 * 1024;
// Bound disk/CPU work across all conversations, including cancelled callers.
static PREVIEW_WORKERS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);

pub struct Snapshot {
    files: BTreeMap<PathBuf, Option<SnapshotText>>,
    _spill: Option<tempfile::TempDir>,
}

enum SnapshotText {
    Memory(String),
    Disk(PathBuf),
}

impl SnapshotText {
    fn read(&self) -> Result<Cow<'_, str>, String> {
        match self {
            Self::Memory(text) => Ok(Cow::Borrowed(text)),
            Self::Disk(path) => std::fs::read_to_string(path)
                .map(Cow::Owned)
                .map_err(|e| e.to_string()),
        }
    }
}

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
            // New projects still need .gitignore before `git init`.
            .require_git(false)
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
        let mut spill = None;
        for path in paths {
            let meta = match std::fs::symlink_metadata(&path) {
                Ok(meta) => meta,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                Err(e) => return Err(e.to_string()),
            };
            // shortcut: skip binary/symlink/>2 MiB previews; stream larger files if needed.
            let content = if meta.is_file() && meta.len() <= MAX_FILE_BYTES {
                let mut bytes = Vec::new();
                std::fs::File::open(&path)
                    .map_err(|e| e.to_string())?
                    .take(MAX_FILE_BYTES + 1)
                    .read_to_end(&mut bytes)
                    .map_err(|e| e.to_string())?;
                if bytes.len() as u64 > MAX_FILE_BYTES || bytes.contains(&0) {
                    None
                } else {
                    match String::from_utf8(bytes) {
                        Ok(text) if total + text.len() <= MAX_TOTAL_BYTES => {
                            total += text.len();
                            Some(SnapshotText::Memory(text))
                        }
                        Ok(text) => {
                            // Spill only overflow text; TempDir removes these private copies on drop.
                            if spill.is_none() {
                                spill = Some(tempfile::tempdir().map_err(|e| e.to_string())?);
                            }
                            let file = spill.as_ref().unwrap().path().join(files.len().to_string());
                            std::fs::write(&file, text).map_err(|e| e.to_string())?;
                            Some(SnapshotText::Disk(file))
                        }
                        Err(_) => None,
                    }
                }
            } else {
                None
            };
            files.insert(path, content);
        }
        Ok(Self {
            files,
            _spill: spill,
        })
    }

    fn changes(self, after: Self) -> Result<Vec<FileChange>, String> {
        let paths: BTreeSet<_> = self.files.keys().chain(after.files.keys()).collect();
        paths
            .into_iter()
            .filter_map(|path| {
                let old = self.files.get(path);
                let new = after.files.get(path);
                if matches!(old, Some(None)) || matches!(new, Some(None)) {
                    return None;
                }
                let old = match old
                    .and_then(Option::as_ref)
                    .map(SnapshotText::read)
                    .transpose()
                {
                    Ok(text) => text.unwrap_or_default(),
                    Err(error) => return Some(Err(error)),
                };
                let new = match new
                    .and_then(Option::as_ref)
                    .map(SnapshotText::read)
                    .transpose()
                {
                    Ok(text) => text.unwrap_or_default(),
                    Err(error) => return Some(Err(error)),
                };
                if old == new && self.files.contains_key(path) == after.files.contains_key(path) {
                    return None;
                }
                Some(Ok(FileChange {
                    path: path.to_string_lossy().into_owned(),
                    old_text: old.into(),
                    new_text: new.into(),
                }))
            })
            .collect()
    }
}

pub async fn capture(root: PathBuf, baseline: Option<&Snapshot>) -> Option<Snapshot> {
    let permit = PREVIEW_WORKERS.acquire().await.ok()?;
    // Re-read baseline paths even when this turn changes the ignore rules.
    let paths = baseline
        .map(|s| s.files.keys().cloned().collect())
        .unwrap_or_default();
    match tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        Snapshot::capture_with_paths(&root, paths)
    })
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

pub async fn changes(before: Snapshot, after: Snapshot) -> Option<Vec<FileChange>> {
    let permit = PREVIEW_WORKERS.acquire().await.ok()?;
    match tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        before.changes(after)
    })
    .await
    {
        Ok(Ok(changes)) => Some(changes),
        result => {
            log::warn!("turn file preview comparison unavailable: {result:?}");
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn capture_and_comparison_wait_for_a_shared_worker_slot() {
        let dir = tempfile::tempdir().unwrap();
        let permits = PREVIEW_WORKERS.acquire_many(2).await.unwrap();
        let root = dir.path().to_path_buf();
        let mut pending = tokio::spawn(async move { capture(root, None).await });
        assert!(tokio::time::timeout(std::time::Duration::from_millis(50), &mut pending)
            .await
            .is_err());
        drop(permits);
        let before = pending.await.unwrap().unwrap();
        std::fs::write(dir.path().join("a.txt"), "created").unwrap();
        let after = Snapshot::capture(dir.path()).unwrap();
        let permits = PREVIEW_WORKERS.acquire_many(2).await.unwrap();
        let mut pending = tokio::spawn(changes(before, after));
        assert!(tokio::time::timeout(std::time::Duration::from_millis(50), &mut pending)
            .await
            .is_err());
        drop(permits);
        assert_eq!(pending.await.unwrap().unwrap().len(), 1);
    }

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
        let changes = before.changes(Snapshot::capture(root).unwrap()).unwrap();
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
        let changes = before.changes(Snapshot::capture(root).unwrap()).unwrap();
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
        let paths = before.files.keys().cloned().collect();
        let changes = before
            .changes(Snapshot::capture_with_paths(root, paths).unwrap())
            .unwrap();
        assert_eq!(changes.len(), 1);
        assert!(changes[0].path.ends_with(".gitignore"));
    }

    #[test]
    fn works_without_git_and_reports_empty_file_creation() {
        let dir = tempfile::tempdir().unwrap();
        let before = Snapshot::capture(dir.path()).unwrap();
        std::fs::write(dir.path().join("empty"), "").unwrap();
        assert_eq!(
            before
                .changes(Snapshot::capture(dir.path()).unwrap())
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn respects_gitignore_without_a_git_repository() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::write(root.join(".gitignore"), "node_modules/\n.venv/\ndist/\n").unwrap();
        let before = Snapshot::capture(root).unwrap();
        for name in ["node_modules", ".venv", "dist"] {
            std::fs::create_dir(root.join(name)).unwrap();
            std::fs::write(root.join(name).join("generated.txt"), "dependency").unwrap();
        }
        std::fs::write(root.join("app.ts"), "source").unwrap();
        let changes = before.changes(Snapshot::capture(root).unwrap()).unwrap();
        assert_eq!(changes.len(), 1);
        assert!(changes[0].path.ends_with("app.ts"));
    }

    #[test]
    fn binary_assets_do_not_consume_the_text_budget() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let binary = vec![0; 1024 * 1024];
        for n in 0..33 {
            std::fs::write(root.join(format!("asset-{n:02}.bin")), &binary).unwrap();
        }
        std::fs::write(root.join("source.txt"), "before").unwrap();
        let before = Snapshot::capture(root).unwrap();
        assert!(before._spill.is_none());
        std::fs::write(root.join("source.txt"), "after").unwrap();
        let changes = before.changes(Snapshot::capture(root).unwrap()).unwrap();
        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0].old_text, "before");
        assert_eq!(changes[0].new_text, "after");
    }

    #[test]
    fn spills_overflow_text_and_preserves_edits_creations_and_deletions() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let text = "x".repeat(MAX_FILE_BYTES as usize);
        for n in 0..MAX_TOTAL_BYTES / text.len() {
            std::fs::write(root.join(format!("a-{n:02}.txt")), &text).unwrap();
        }
        std::fs::write(root.join("y-deleted.txt"), "deleted").unwrap();
        std::fs::write(root.join("z-edited.txt"), "before").unwrap();
        let before = Snapshot::capture(root).unwrap();
        let before_spill = before._spill.as_ref().unwrap().path().to_path_buf();
        assert!(matches!(
            before.files[&root.join("z-edited.txt")],
            Some(SnapshotText::Disk(_))
        ));
        std::fs::remove_file(root.join("y-deleted.txt")).unwrap();
        std::fs::write(root.join("z-edited.txt"), "after").unwrap();
        std::fs::write(root.join("z-new.txt"), "created").unwrap();
        let after = Snapshot::capture(root).unwrap();
        let after_spill = after._spill.as_ref().unwrap().path().to_path_buf();
        let changes = before.changes(after).unwrap();
        assert_eq!(changes.len(), 3);
        assert_eq!(
            (changes[0].old_text.as_str(), changes[0].new_text.as_str()),
            ("deleted", "")
        );
        assert_eq!(
            (changes[1].old_text.as_str(), changes[1].new_text.as_str()),
            ("before", "after")
        );
        assert_eq!(
            (changes[2].old_text.as_str(), changes[2].new_text.as_str()),
            ("", "created")
        );
        assert!(!before_spill.exists());
        assert!(!after_spill.exists());
    }
}
