//! The read-only `history` tool: BM25 search over archived (compacted-away)
//! transcript chunks stored as `<archive_dir>/*.jsonl`.

use super::{arg_str, arg_str_opt, arg_usize, truncate_output, Tool, ToolCtx};
use agent_client_protocol as acp;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::SystemTime;

/// Cap on total output characters.
const MAX_OUTPUT_CHARS: usize = 20_000;
/// BM25 parameters.
const K1: f64 = 1.5;
const B: f64 = 0.75;

pub struct History;

#[async_trait::async_trait(?Send)]
impl Tool for History {
    fn name(&self) -> &'static str {
        "history"
    }
    fn description(&self) -> &'static str {
        "Search the session's archived conversation history (earlier context that was \
         compacted out of the active window) with keywords. Optionally scope to a single \
         archive file via `archive_ref`. Returns matching excerpts."
    }
    fn schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "query": { "type": "string", "description": "Keywords to search for." },
                "max_results": { "type": "integer", "description": "Maximum excerpts to return. Default 8." },
                "archive_ref": { "type": "string", "description": "Optional archive file name (e.g. \"20260810-103045-abc.jsonl\") to scope the search to a single compaction slice. Prefer this over keyword-only search when a summary block names the ref." }
            },
            "required": ["query"],
            "additionalProperties": false
        })
    }
    fn kind(&self) -> acp::ToolKind {
        acp::ToolKind::Search
    }
    fn read_only(&self) -> bool {
        true
    }
    async fn execute(&self, args: serde_json::Value, ctx: &ToolCtx) -> Result<String, String> {
        let query = arg_str(&args, "query")?;
        let max = arg_usize(&args, "max_results", 8).min(30);
        let archive_ref = arg_str_opt(&args, "archive_ref");

        let docs = load_archive(&ctx.archive_dir, archive_ref.as_deref());
        if docs.is_empty() {
            return Ok(match archive_ref {
                Some(r) => format!("(no archive slice named `{r}` in this session)"),
                None => "(no archived history yet)".to_string(),
            });
        }
        let hits = bm25_search(&docs, &query, max);
        if hits.is_empty() {
            return Ok(format!("no archived excerpts match `{query}`"));
        }
        let mut out = String::new();
        for (rank, (score, doc)) in hits.iter().enumerate() {
            out.push_str(&format!(
                "--- [{rank}] score {score:.2} | role={} | source={} ---\n{}\n",
                doc.role,
                doc.source,
                excerpt(&doc.content, &tokenize(&query))
            ));
        }
        Ok(truncate_output(out, MAX_OUTPUT_CHARS))
    }
}

/// One archived message (parsed from a jsonl line).
#[derive(Clone)]
struct Doc {
    role: String,
    content: String,
    tokens: Vec<String>,
    /// Basename of the jsonl file the message came from. Echoed back in
    /// hits so the model (and the human) can correlate the excerpt with
    /// an `archive_ref` from a summary block.
    source: String,
}

struct CachedFile {
    mtime: Option<SystemTime>,
    len: u64,
    docs: Vec<Doc>,
}

fn archive_cache() -> &'static Mutex<HashMap<std::path::PathBuf, CachedFile>> {
    static CACHE: OnceLock<Mutex<HashMap<std::path::PathBuf, CachedFile>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn load_archive(dir: &std::path::Path, only_file: Option<&str>) -> Vec<Doc> {
    let mut docs = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return docs;
    };
    let mut paths: Vec<_> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|e| e == "jsonl"))
        .collect();
    paths.sort(); // chronological order by timestamped file names
    for path in paths {
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if let Some(want) = only_file {
            if name != want {
                continue;
            }
        }
        docs.extend(load_file_docs(&path, name));
    }
    docs
}

fn load_file_docs(path: &std::path::Path, name: &str) -> Vec<Doc> {
    let meta = std::fs::metadata(path).ok();
    let mtime = meta.as_ref().and_then(|m| m.modified().ok());
    let len = meta.as_ref().map(|m| m.len()).unwrap_or(0);
    if let Ok(cache) = archive_cache().lock() {
        if let Some(hit) = cache.get(path) {
            if hit.mtime == mtime && hit.len == len {
                return hit.docs.clone();
            }
        }
    }
    let docs = parse_archive_file(path, name);
    if let Ok(mut cache) = archive_cache().lock() {
        cache.insert(
            path.to_path_buf(),
            CachedFile {
                mtime,
                len,
                docs: docs.clone(),
            },
        );
    }
    docs
}

fn parse_archive_file(path: &std::path::Path, name: &str) -> Vec<Doc> {
    let Ok(text) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    let mut docs = Vec::new();
    for line in text.lines() {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        let role = v
            .get("role")
            .and_then(|r| r.as_str())
            .unwrap_or("?")
            .to_string();
        let Some(content) = indexable_text(&v) else {
            continue;
        };
        if content.trim().is_empty() {
            continue;
        }
        let tokens = tokenize(&content);
        docs.push(Doc {
            role,
            content,
            tokens,
            source: name.to_string(),
        });
    }
    docs
}

fn indexable_text(v: &serde_json::Value) -> Option<String> {
    let mut parts = Vec::new();
    if let Some(text) = content_text(v.get("content")) {
        parts.push(text);
    }
    if let Some(calls) = v.get("tool_calls").and_then(|c| c.as_array()) {
        for call in calls {
            if let Some(name) = call.pointer("/function/name").and_then(|n| n.as_str()) {
                parts.push(name.to_string());
            }
            if let Some(args) = call.pointer("/function/arguments").and_then(|a| a.as_str()) {
                parts.push(args.to_string());
            }
        }
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("\n"))
    }
}

fn content_text(content: Option<&serde_json::Value>) -> Option<String> {
    match content? {
        serde_json::Value::String(s) => Some(s.clone()),
        serde_json::Value::Array(parts) => {
            let texts: Vec<&str> = parts
                .iter()
                .filter_map(|p| p.get("text").and_then(|t| t.as_str()))
                .collect();
            if texts.is_empty() {
                None
            } else {
                Some(texts.join("\n"))
            }
        }
        _ => None,
    }
}

/// Tokenizer: ASCII / Latin word runs + individual CJK / Kana / Hangul chars.
fn tokenize(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut word = String::new();
    for ch in text.chars() {
        if is_word_char(ch) {
            word.extend(ch.to_lowercase());
        } else {
            if !word.is_empty() {
                out.push(std::mem::take(&mut word));
            }
            if is_cjk_kana_or_hangul(ch) {
                out.push(ch.to_string());
            }
        }
    }
    if !word.is_empty() {
        out.push(word);
    }
    out
}

fn is_word_char(ch: char) -> bool {
    ch == '_' || (ch.is_alphanumeric() && !is_cjk_kana_or_hangul(ch))
}

fn is_cjk_kana_or_hangul(ch: char) -> bool {
    matches!(
        ch,
        '\u{3400}'..='\u{4DBF}' // CJK Ext A
        | '\u{4E00}'..='\u{9FFF}' // CJK Unified
        | '\u{3040}'..='\u{309F}' // Hiragana
        | '\u{30A0}'..='\u{30FF}' // Katakana
        | '\u{AC00}'..='\u{D7AF}' // Hangul syllables
        | '\u{1100}'..='\u{11FF}' // Hangul Jamo
        | '\u{3130}'..='\u{318F}' // Hangul compatibility
        | '\u{FF66}'..='\u{FF9D}' // Halfwidth katakana
    )
}

/// Classic BM25 ranking over the archive.
fn bm25_search<'a>(docs: &'a [Doc], query: &str, top_k: usize) -> Vec<(f64, &'a Doc)> {
    let q_tokens = tokenize(query);
    if q_tokens.is_empty() || docs.is_empty() {
        return Vec::new();
    }
    let n = docs.len() as f64;
    let avg_len = docs.iter().map(|d| d.tokens.len() as f64).sum::<f64>() / n.max(1.0);

    // Document frequency per query term.
    let mut df = std::collections::HashMap::<&str, f64>::new();
    for qt in &q_tokens {
        let count = docs
            .iter()
            .filter(|d| d.tokens.iter().any(|t| t == qt))
            .count() as f64;
        df.insert(qt.as_str(), count);
    }

    let mut scored: Vec<(f64, &Doc)> = Vec::new();
    for doc in docs {
        let mut score = 0.0f64;
        let len = doc.tokens.len() as f64;
        for qt in &q_tokens {
            let tf = doc
                .tokens
                .iter()
                .filter(|t| t.as_str() == qt.as_str())
                .count() as f64;
            if tf == 0.0 {
                continue;
            }
            let doc_freq = df.get(qt.as_str()).copied().unwrap_or(0.0);
            let idf = ((n - doc_freq + 0.5) / (doc_freq + 0.5) + 1.0).ln();
            let norm = tf * (K1 + 1.0) / (tf + K1 * (1.0 - B + B * len / avg_len.max(1.0)));
            score += idf * norm;
        }
        if score > 0.0 {
            scored.push((score, doc));
        }
    }
    scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    scored.truncate(top_k);
    scored
}

/// Shows the window around the first query-term hit (fallback: head).
fn excerpt(content: &str, q_tokens: &[String]) -> String {
    let chars: Vec<char> = content.chars().collect();
    let lower = content.to_lowercase();
    let mut hit: Option<usize> = None;
    for qt in q_tokens {
        if let Some(pos) = lower.find(qt.as_str()) {
            // byte pos -> char pos
            hit = Some(content[..pos].chars().count());
            break;
        }
    }
    let start = hit.map(|h| h.saturating_sub(120)).unwrap_or(0);
    let take: String = chars.iter().skip(start).take(480).collect();
    let prefix = if start > 0 { "…" } else { "" };
    let suffix = if start + 480 < chars.len() { "…" } else { "" };
    format!("{prefix}{take}{suffix}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::native::provider::ChatMessage;

    #[tokio::test(flavor = "current_thread")]
    async fn history_searches_archive() {
        let tmp = tempfile::tempdir().unwrap();
        let archive = tmp.path().join("archive");
        std::fs::create_dir_all(&archive).unwrap();
        let msgs = vec![
            ChatMessage::assistant("we refactored the payment gateway module"),
            ChatMessage::tool_result("c1", "exit code: 0\nbuilt successfully"),
        ];
        let mut buf = String::new();
        for m in &msgs {
            buf.push_str(&serde_json::to_string(m).unwrap());
            buf.push('\n');
        }
        std::fs::write(archive.join("20240101-000000-000.jsonl"), buf).unwrap();

        let ctx = ToolCtx {
            cwd: tmp.path().to_path_buf(),
            bash_timeout: std::time::Duration::from_secs(10),
            path_env: std::env::var_os("PATH").unwrap_or_default(),
            archive_dir: archive,
            jobs: std::rc::Rc::new(std::cell::RefCell::new(
                super::super::jobs::JobTable::default(),
            )),
            harness: None,
            mutations: std::rc::Rc::new(std::cell::RefCell::new(Vec::new())),
            mode_id: None,
            memory: super::super::test_memory_handle(),
        };

        let out = History
            .execute(serde_json::json!({"query": "payment gateway"}), &ctx)
            .await
            .unwrap();
        assert!(out.contains("payment gateway"));
        assert!(out.contains("role=assistant"));
        // Source tag is echoed back so the model can route via archive_ref.
        assert!(out.contains("source=20240101-000000-000.jsonl"));

        let none = History
            .execute(serde_json::json!({"query": "kubernetes"}), &ctx)
            .await
            .unwrap();
        assert!(none.contains("no archived excerpts"));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn history_archive_ref_scopes_search() {
        let tmp = tempfile::tempdir().unwrap();
        let archive = tmp.path().join("archive");
        std::fs::create_dir_all(&archive).unwrap();
        for (name, msg) in [
            (
                "20240101-000000-001.jsonl",
                ChatMessage::assistant("alpha feature: payment refactor"),
            ),
            (
                "20240101-000000-002.jsonl",
                ChatMessage::assistant("beta feature: payment refactor"),
            ),
        ] {
            let path = archive.join(name);
            std::fs::write(
                &path,
                format!("{}\n", serde_json::to_string(&msg).unwrap()),
            )
            .unwrap();
        }
        let ctx = ToolCtx {
            cwd: tmp.path().to_path_buf(),
            bash_timeout: std::time::Duration::from_secs(10),
            path_env: std::env::var_os("PATH").unwrap_or_default(),
            archive_dir: archive,
            jobs: std::rc::Rc::new(std::cell::RefCell::new(
                super::super::jobs::JobTable::default(),
            )),
            harness: None,
            mutations: std::rc::Rc::new(std::cell::RefCell::new(Vec::new())),
            mode_id: None,
            memory: super::super::test_memory_handle(),
        };
        let scoped = History
            .execute(
                serde_json::json!({
                    "query": "refactor",
                    "archive_ref": "20240101-000000-001.jsonl"
                }),
                &ctx,
            )
            .await
            .unwrap();
        assert!(scoped.contains("alpha"));
        assert!(!scoped.contains("beta"));
    }

    #[test]
    fn tokenizer_handles_cjk_and_words() {
        let toks = tokenize("修复 login 登录 bug");
        assert!(toks.contains(&"login".to_string()));
        assert!(toks.contains(&"bug".to_string()));
        assert!(toks.contains(&"登".to_string()));
    }

    #[test]
    fn tokenizer_keeps_hangul_kana_and_accented_latin() {
        let toks = tokenize("café 한글 カタカナ ひらがな");
        assert!(toks.contains(&"café".to_string()));
        assert!(toks.iter().any(|t| t == "한"));
        assert!(toks.iter().any(|t| t == "カ"));
        assert!(toks.iter().any(|t| t == "ひ"));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn history_indexes_tool_call_arguments() {
        let tmp = tempfile::tempdir().unwrap();
        let archive = tmp.path().join("archive");
        std::fs::create_dir_all(&archive).unwrap();
        let msg = ChatMessage::assistant_tool_calls(
            vec![crate::agent::native::provider::ChatToolCall {
                id: "c1".into(),
                typ: "function".into(),
                function: crate::agent::native::provider::ChatToolCallFunction {
                    name: "write_file".into(),
                    arguments: r#"{"path":"src/payment.rs"}"#.into(),
                },
            }],
            None,
        );
        std::fs::write(
            archive.join("20240101-000000-tool.jsonl"),
            format!("{}\n", serde_json::to_string(&msg).unwrap()),
        )
        .unwrap();
        let ctx = ToolCtx {
            cwd: tmp.path().to_path_buf(),
            bash_timeout: std::time::Duration::from_secs(10),
            path_env: std::env::var_os("PATH").unwrap_or_default(),
            archive_dir: archive,
            jobs: std::rc::Rc::new(std::cell::RefCell::new(
                super::super::jobs::JobTable::default(),
            )),
            harness: None,
            mutations: std::rc::Rc::new(std::cell::RefCell::new(Vec::new())),
            mode_id: None,
            memory: super::super::test_memory_handle(),
        };
        let out = History
            .execute(serde_json::json!({"query": "payment"}), &ctx)
            .await
            .unwrap();
        assert!(out.contains("payment"), "got: {out}");
    }

    #[test]
    fn bm25_ranks_relevant_first() {
        let docs = vec![
            Doc {
                role: "assistant".into(),
                content: "rust compiler error".into(),
                tokens: tokenize("rust compiler error"),
                source: "bm25-test.jsonl".into(),
            },
            Doc {
                role: "assistant".into(),
                content: "rust rust rust toolchain rust".into(),
                tokens: tokenize("rust rust rust toolchain rust"),
                source: "bm25-test.jsonl".into(),
            },
        ];
        let hits = bm25_search(&docs, "rust compiler", 2);
        assert_eq!(hits.len(), 2);
        assert!(hits[0].1.content.contains("compiler"));
    }
}
