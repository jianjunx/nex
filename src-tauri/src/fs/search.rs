use crate::error::NexError;
use crate::fs::write::write_file;
use ignore::WalkBuilder;
use serde::{Deserialize, Serialize};
use std::path::Path;

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

fn normalize_fuzzy_text(text: &str) -> String {
    text.replace('\\', "/").to_lowercase()
}

fn fuzzy_score(query: &str, target: &str) -> Option<i64> {
    let q = normalize_fuzzy_text(query);
    let t = normalize_fuzzy_text(target);
    if q.is_empty() {
        return Some(0);
    }
    if t == q {
        return Some(10_000);
    }
    if t.starts_with(&q) {
        return Some(5_000 - (t.len() as i64 - q.len() as i64));
    }
    if let Some(index) = t.find(&q) {
        return Some(1_000 - index as i64);
    }

    let chars: Vec<(usize, char)> = t.char_indices().collect();
    let mut ti = 0usize;
    let mut score = 0i64;
    let mut prev_index: Option<usize> = None;
    for ch in q.chars() {
        let mut found = None;
        while ti < chars.len() {
            let (idx, current) = chars[ti];
            ti += 1;
            if current == ch {
                found = Some(idx);
                break;
            }
        }
        let idx = found?;
        score += 10;
        if let Some(prev) = prev_index {
            if idx == prev + 1 {
                score += 5;
            }
        }
        if idx == 0 || matches!(t[..idx].chars().last(), Some('-' | '_' | '/' | '.')) {
            score += 8;
        }
        prev_index = Some(idx);
    }
    score -= t.chars().count() as i64;
    Some(score)
}

fn fuzzy_name_score(query: &str, name: &str, relative_path: &str) -> Option<i64> {
    let name_score = fuzzy_score(query, name).map(|score| score + 1_000_000);
    let path_score = fuzzy_score(query, relative_path);
    match (name_score, path_score) {
        (Some(a), Some(b)) => Some(a.max(b)),
        (Some(a), None) => Some(a),
        (None, Some(b)) => Some(b),
        (None, None) => None,
    }
}

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
        // Name-only listing for pickers (e.g. composer `@` mention).
        // The project Search UI never sends an empty query.
        let mut results = Vec::new();
        let walker = WalkBuilder::new(project_path)
            .hidden(true)
            .git_ignore(true)
            .git_exclude(true)
            .build();
        for entry in walker.flatten() {
            if results.len() >= 48 {
                break;
            }
            let path = entry.path();
            if path == project_path {
                continue;
            }
            let Ok(metadata) = entry.metadata() else {
                continue;
            };
            if !metadata.is_file() {
                continue;
            }
            let name = path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string();
            results.push(SearchMatch {
                path: path.to_string_lossy().to_string(),
                name,
                line: None,
                text: String::new(),
            });
        }
        return Ok(results);
    }
    let opts = options.unwrap_or_default();
    let re = compile_pattern(query, &opts)?;
    let fuzzy_name_search = !opts.case_sensitive && !opts.whole_word && !opts.regex;
    let mut results = Vec::new();
    let mut file_name_hits: Vec<(i64, SearchMatch)> = Vec::new();
    let mut content_hits = Vec::new();
    let walker = WalkBuilder::new(project_path)
        .hidden(true) // skip dotfiles/dirs (notably .git)
        .git_ignore(true)
        .git_exclude(true)
        .build();

    for entry in walker.flatten() {
        if !fuzzy_name_search && results.len() >= MAX_RESULTS {
            break;
        }
        let path = entry.path();
        if path == project_path {
            continue;
        }
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        if !metadata.is_file() {
            continue;
        }
        let name = path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        let path_str = path.to_string_lossy().to_string();
        let relative_path = path
            .strip_prefix(project_path)
            .unwrap_or(path)
            .to_string_lossy()
            .replace('\\', "/");

        if fuzzy_name_search {
            if let Some(score) = fuzzy_name_score(query, &name, &relative_path) {
                file_name_hits.push((
                    score,
                    SearchMatch {
                        path: path_str.clone(),
                        name: name.clone(),
                        line: None,
                        text: String::new(),
                    },
                ));
            }
        } else if re.is_match(&name) {
            results.push(SearchMatch {
                path: path_str,
                name,
                line: None,
                text: String::new(),
            });
            continue;
        }

        if metadata.len() > MAX_CONTENT_FILE_SIZE {
            continue;
        }
        // Non-UTF-8 (binary) files fail to read as text and are skipped.
        let Ok(content) = std::fs::read_to_string(path) else {
            continue;
        };
        for (idx, line) in content.lines().enumerate() {
            if (!fuzzy_name_search && results.len() >= MAX_RESULTS)
                || (fuzzy_name_search && content_hits.len() >= MAX_RESULTS)
            {
                break;
            }
            if re.is_match(line) {
                let hit = SearchMatch {
                    path: path_str.clone(),
                    name: name.clone(),
                    line: Some(idx as u32 + 1),
                    text: line.trim().chars().take(MAX_LINE_LEN).collect(),
                };
                if fuzzy_name_search {
                    content_hits.push(hit);
                } else {
                    results.push(hit);
                }
            }
        }
    }

    if fuzzy_name_search {
        file_name_hits.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.path.cmp(&b.1.path)));
        results.extend(
            file_name_hits
                .into_iter()
                .take(MAX_RESULTS)
                .map(|(_, hit)| hit),
        );
        let remaining = MAX_RESULTS.saturating_sub(results.len());
        results.extend(content_hits.into_iter().take(remaining));
    }

    Ok(results)
}

/// One file's replacement tally in a preview.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceFilePreview {
    pub path: String,
    pub count: usize,
}

/// Project-wide replace PREVIEW — computed without touching disk.
/// `truncated` = the MAX_RESULTS budget ran out; unvisited files beyond the
/// cap may contain further matches. apply_replace spends the same budget,
/// so what the preview promises is what the write delivers.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplacePreview {
    pub files: Vec<ReplaceFilePreview>,
    pub total: usize,
    pub truncated: bool,
}

/// Outcome of a written replace.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceResult {
    pub files_changed: usize,
    pub replacements: usize,
}

/// Candidate files for replace: regular files within the size cap, honoring
/// the same hidden/.gitignore filters as `search`. (Name-only matches are
/// never replaceable — replace targets file CONTENT.)
fn replace_candidates(project_path: &Path) -> Vec<std::path::PathBuf> {
    let mut out = Vec::new();
    let walker = WalkBuilder::new(project_path)
        .hidden(true)
        .git_ignore(true)
        .git_exclude(true)
        .build();
    for entry in walker.flatten() {
        let path = entry.path();
        if path == project_path {
            continue;
        }
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        if !metadata.is_file() || metadata.len() > MAX_CONTENT_FILE_SIZE {
            continue;
        }
        out.push(path.to_path_buf());
    }
    out
}

/// Preview per-file replacement counts WITHOUT writing.
pub fn search_replace(
    project_path: &Path,
    query: &str,
    replacement: &str,
    options: Option<SearchOptions>,
) -> Result<ReplacePreview, NexError> {
    let _ = replacement; // preview only counts; the text matters at apply time
    if query.is_empty() {
        return Ok(ReplacePreview {
            files: Vec::new(),
            total: 0,
            truncated: false,
        });
    }
    let opts = options.unwrap_or_default();
    let re = compile_pattern(query, &opts)?;
    let mut files = Vec::new();
    let mut total = 0usize;
    let mut truncated = false;

    for path in replace_candidates(project_path) {
        let budget = MAX_RESULTS - total; // > 0 while the loop runs
        let Ok(content) = std::fs::read_to_string(&path) else {
            continue;
        };
        let full = re.find_iter(&content).count();
        let add = full.min(budget);
        if full > add {
            truncated = true;
        }
        if add > 0 {
            files.push(ReplaceFilePreview {
                path: path.to_string_lossy().to_string(),
                count: add,
            });
            total += add;
        }
        if total >= MAX_RESULTS {
            truncated = true;
            break;
        }
    }

    Ok(ReplacePreview {
        files,
        total,
        truncated,
    })
}

/// Write the replace to disk via the atomic writer in fs/write.rs.
/// - `paths = Some(list)` restricts the operation to those files (the UI's
///   per-file replace passes a one-element list);
/// - `limit_per_file = Some(n)` caps replacements per file — `Some(1)` is the
///   "first match in this file" single-replace semantics;
/// - the shared MAX_RESULTS budget keeps capped previews and writes in sync;
/// - `replacement` is passed through `Captures::expand`, so `$1`/`${name}`
///   capture-group backreferences work (regex crate semantics).
/// - write failures are collected, not fatal: every candidate is attempted,
///   and if any writes failed the function returns `NexError::FileSystem`
///   whose message reports files changed vs failed (no rollback — files
///   already written stay written).
pub fn apply_replace(
    project_path: &Path,
    query: &str,
    replacement: &str,
    options: Option<SearchOptions>,
    paths: Option<Vec<String>>,
    limit_per_file: Option<usize>,
) -> Result<ReplaceResult, NexError> {
    if query.is_empty() {
        return Ok(ReplaceResult {
            files_changed: 0,
            replacements: 0,
        });
    }
    let opts = options.unwrap_or_default();
    let re = compile_pattern(query, &opts)?;
    let per_file = limit_per_file.unwrap_or(usize::MAX);
    let mut budget = MAX_RESULTS;
    let mut files_changed = 0usize;
    let mut replacements = 0usize;
    let mut failures: Vec<String> = Vec::new();

    for path in replace_candidates(project_path) {
        if budget == 0 {
            break;
        }
        let path_str = path.to_string_lossy().to_string();
        if let Some(only) = &paths {
            if !only.iter().any(|p| p == &path_str) {
                continue;
            }
        }
        let Ok(content) = std::fs::read_to_string(&path) else {
            continue;
        };
        let cap = per_file.min(budget);
        let mut remaining = cap;
        let mut count = 0usize;
        let replaced = re.replace_all(&content, |caps: &regex::Captures| {
            if remaining == 0 {
                // Beyond the cap: keep the original match text verbatim.
                return caps
                    .get(0)
                    .map_or(String::new(), |m| m.as_str().to_string());
            }
            remaining -= 1;
            count += 1;
            let mut dst = String::new();
            caps.expand(replacement, &mut dst);
            dst
        });
        if count > 0 {
            match write_file(&path, &replaced) {
                Ok(()) => {
                    files_changed += 1;
                    replacements += count;
                    budget -= count;
                }
                Err(e) => {
                    // 不中断、不回滚：收集失败，继续写其余文件，末尾汇总报错
                    failures.push(format!("{}: {e}", path.display()));
                }
            }
        }
    }

    if !failures.is_empty() {
        return Err(NexError::FileSystem(format!(
            "替换部分完成：已修改 {} 个文件，{} 个文件写入失败（首个原因：{}）",
            files_changed,
            failures.len(),
            failures[0]
        )));
    }

    Ok(ReplaceResult {
        files_changed,
        replacements,
    })
}
