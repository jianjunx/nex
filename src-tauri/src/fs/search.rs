use ignore::WalkBuilder;
use serde::{Deserialize, Serialize};
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

/// Match-rule toggles shared by search and replace. All false = the
/// historical behavior: case-insensitive substring matching. Serialized
/// camelCase (`caseSensitive` / `wholeWord` / `regex`) per bridge contract.
#[derive(Debug, Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchOptions {
    #[serde(default)]
    pub case_sensitive: bool,
    #[serde(default)]
    pub whole_word: bool,
    #[serde(default)]
    pub regex: bool,
}

/// Total matches returned per query (name + content combined). Replace
/// previews and writes honor the SAME budget (spec: 替换同受约束).
const MAX_RESULTS: usize = 200;
/// Files larger than this are skipped for content search (name still matches).
const MAX_CONTENT_FILE_SIZE: u64 = 1024 * 1024;
/// Matched lines are truncated to this many characters.
const MAX_LINE_LEN: usize = 200;

/// Compile query + options into one `regex::Regex`: plain queries become
/// `regex::escape(query)`; whole-word wraps `\b(?:…)\b`; case-insensitivity
/// prepends `(?i)`. The three compose naturally in that order. An invalid
/// pattern is a user-visible validation error (Chinese, like fs/create.rs).
pub fn compile_pattern(query: &str, options: &SearchOptions) -> Result<regex::Regex, NexError> {
    let inner = if options.regex {
        query.to_string()
    } else {
        regex::escape(query)
    };
    let inner = if options.whole_word {
        format!("\\b(?:{})\\b", inner)
    } else {
        inner
    };
    let pattern = if options.case_sensitive {
        inner
    } else {
        format!("(?i){}", inner)
    };
    regex::Regex::new(&pattern)
        .map_err(|_| NexError::FileSystem(format!("无效的正则表达式: {}", query)))
}

/// Project-wide search over file names and content, honoring `SearchOptions`
/// (None = default = case-insensitive substring — the historical behavior).
/// Matching is LINE-based: multiline constructs (`\n`, `(?s)`) cannot span
/// lines — documented v1 limitation. Honors .gitignore/.git_exclude/hidden,
/// skips non-UTF-8 and >1MB files for content matching (names still match).
pub fn search(
    project_path: &Path,
    query: &str,
    options: Option<SearchOptions>,
) -> Result<Vec<SearchMatch>, NexError> {
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let opts = options.unwrap_or_default();
    let re = compile_pattern(query, &opts)?;
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

        if re.is_match(&name) {
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
            if re.is_match(line) {
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
