use ignore::WalkBuilder;
use serde::Serialize;
use std::path::Path;
use crate::error::NexError;

/// One search hit. `line` is `None` for file-name matches and `Some(n)`
/// (1-based) for content matches; `text` is the matched line (trimmed,
/// truncated) or the file name respectively.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchMatch {
    pub path: String,
    pub name: String,
    pub line: Option<u32>,
    pub text: String,
}

/// Total matches returned per query (name + content combined).
const MAX_RESULTS: usize = 200;
/// Files larger than this are skipped for content search (name still matches).
const MAX_CONTENT_FILE_SIZE: u64 = 1024 * 1024;
/// Matched lines are truncated to this many characters.
const MAX_LINE_LEN: usize = 200;

/// Case-insensitive substring search over a project tree: file-name matches
/// first, then text-content matches. Honors .gitignore/.git_exclude (same as
/// the file tree) and skips hidden entries (`.git`, `.idea`, …) and
/// non-UTF-8/large files.
pub fn search(project_path: &Path, query: &str) -> Result<Vec<SearchMatch>, NexError> {
    let query_lc = query.to_lowercase();
    if query_lc.is_empty() {
        return Ok(Vec::new());
    }
    let mut results = Vec::new();
    let walker = WalkBuilder::new(project_path)
        .hidden(true) // skip dotfiles/dirs (notably .git)
        .git_ignore(true)
        .git_exclude(true)
        .build();

    for entry in walker.flatten() {
        if results.len() >= MAX_RESULTS {
            break;
        }
        let path = entry.path();
        if path == project_path {
            continue;
        }
        let Ok(metadata) = entry.metadata() else { continue };
        if !metadata.is_file() {
            continue;
        }
        let name = path.file_name().unwrap_or_default().to_string_lossy().to_string();
        let path_str = path.to_string_lossy().to_string();

        if name.to_lowercase().contains(&query_lc) {
            results.push(SearchMatch { path: path_str, name, line: None, text: String::new() });
            continue;
        }

        if metadata.len() > MAX_CONTENT_FILE_SIZE {
            continue;
        }
        // Non-UTF-8 (binary) files fail to read as text and are skipped.
        let Ok(content) = std::fs::read_to_string(path) else { continue };
        for (idx, line) in content.lines().enumerate() {
            if results.len() >= MAX_RESULTS {
                break;
            }
            if line.to_lowercase().contains(&query_lc) {
                results.push(SearchMatch {
                    path: path_str.clone(),
                    name: name.clone(),
                    line: Some(idx as u32 + 1),
                    text: line.trim().chars().take(MAX_LINE_LEN).collect(),
                });
            }
        }
    }

    Ok(results)
}
