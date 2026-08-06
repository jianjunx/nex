//! The read-only `history` tool: BM25 search over archived (compacted-away)
//! transcript chunks stored as `<archive_dir>/*.jsonl`.

use super::{arg_str, arg_usize, truncate_output, Tool, ToolCtx};
use agent_client_protocol as acp;

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
         compacted out of the active window) with keywords. Returns matching excerpts."
    }
    fn schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "query": { "type": "string", "description": "Keywords to search for." },
                "max_results": { "type": "integer", "description": "Maximum excerpts to return. Default 8." }
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

        let docs = load_archive(&ctx.archive_dir);
        if docs.is_empty() {
            return Ok("(no archived history yet)".to_string());
        }
        let hits = bm25_search(&docs, &query, max);
        if hits.is_empty() {
            return Ok(format!("no archived excerpts match `{query}`"));
        }
        let mut out = String::new();
        for (rank, (score, doc)) in hits.iter().enumerate() {
            out.push_str(&format!(
                "--- [{rank}] score {score:.2} | role={} ---\n{}\n",
                doc.role,
                excerpt(&doc.content, &tokenize(&query))
            ));
        }
        Ok(truncate_output(out, MAX_OUTPUT_CHARS))
    }
}

/// One archived message (parsed from a jsonl line).
struct Doc {
    role: String,
    content: String,
    tokens: Vec<String>,
}

fn load_archive(dir: &std::path::Path) -> Vec<Doc> {
    let mut docs = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else { return docs };
    let mut paths: Vec<_> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|e| e == "jsonl"))
        .collect();
    paths.sort(); // chronological order by timestamped file names
    for path in paths {
        let Ok(text) = std::fs::read_to_string(&path) else { continue };
        for line in text.lines() {
            let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else { continue };
            let role = v.get("role").and_then(|r| r.as_str()).unwrap_or("?").to_string();
            let Some(content) = v.get("content").and_then(|c| c.as_str()) else { continue };
            if content.trim().is_empty() {
                continue;
            }
            let tokens = tokenize(content);
            docs.push(Doc { role, content: content.to_string(), tokens });
        }
    }
    docs
}

/// Tokenizer: ASCII word runs + individual CJK characters.
fn tokenize(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut word = String::new();
    for ch in text.chars() {
        if ch.is_ascii_alphanumeric() || ch == '_' {
            word.push(ch.to_ascii_lowercase());
        } else {
            if !word.is_empty() {
                out.push(std::mem::take(&mut word));
            }
            if ('\u{4E00}'..'\u{9FFF}').contains(&ch) {
                out.push(ch.to_string());
            }
        }
    }
    if !word.is_empty() {
        out.push(word);
    }
    out
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
        let count = docs.iter().filter(|d| d.tokens.iter().any(|t| t == qt)).count() as f64;
        df.insert(qt.as_str(), count);
    }

    let mut scored: Vec<(f64, &Doc)> = Vec::new();
    for doc in docs {
        let mut score = 0.0f64;
        let len = doc.tokens.len() as f64;
        for qt in &q_tokens {
            let tf = doc.tokens.iter().filter(|t| t.as_str() == qt.as_str()).count() as f64;
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
            archive_dir: archive,
            jobs: std::rc::Rc::new(std::cell::RefCell::new(
                super::super::jobs::JobTable::default(),
            )),
            harness: None,
            mutations: std::rc::Rc::new(std::cell::RefCell::new(Vec::new())),
        };

        let out = History
            .execute(serde_json::json!({"query": "payment gateway"}), &ctx)
            .await
            .unwrap();
        assert!(out.contains("payment gateway"));
        assert!(out.contains("role=assistant"));

        let none = History.execute(serde_json::json!({"query": "kubernetes"}), &ctx).await.unwrap();
        assert!(none.contains("no archived excerpts"));
    }

    #[test]
    fn tokenizer_handles_cjk_and_words() {
        let toks = tokenize("修复 login 登录 bug");
        assert!(toks.contains(&"login".to_string()));
        assert!(toks.contains(&"bug".to_string()));
        assert!(toks.contains(&"登".to_string()));
    }

    #[test]
    fn bm25_ranks_relevant_first() {
        let docs = vec![
            Doc {
                role: "assistant".into(),
                content: "rust compiler error".into(),
                tokens: tokenize("rust compiler error"),
            },
            Doc {
                role: "assistant".into(),
                content: "rust rust rust toolchain rust".into(),
                tokens: tokenize("rust rust rust toolchain rust"),
            },
        ];
        let hits = bm25_search(&docs, "rust compiler", 2);
        assert_eq!(hits.len(), 2);
        assert!(hits[0].1.content.contains("compiler"));
    }
}
