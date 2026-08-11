//! Tiered context compression (prefix-cache friendly).
//!
//! Three thresholds relative to the configured `context_window`:
//! - `tool_result_snip_ratio` (0.6): truncate oversized tool results in place.
//! - `compact_ratio` (0.8): rewrite the old prefix, keeping system prompt,
//!   tool_calls↔tool-result pairing, error results (KeepErrors) and the recent
//!   tail untouched.
//! - `compact_force_ratio` (0.9): aggressive variant (smaller snippets, also
//!   folds old assistant prose).
//!
//! Rewritten originals are archived to `archive/<ts>.jsonl` so the read-only
//! `history` tool can BM25-search them later. `context_window = 0` disables
//! compression entirely.

use std::path::{Path, PathBuf};

use super::provider::{ChatMessage, Content};

pub const TOOL_RESULT_SNIP_RATIO: f64 = 0.6;
pub const COMPACT_RATIO: f64 = 0.8;
pub const COMPACT_FORCE_RATIO: f64 = 0.9;

/// Chars kept (head + tail combined) per snipped tool result.
const SNIP_KEEP_CHARS: usize = 1600;
/// Even smaller under force compression.
const FORCE_SNIP_KEEP_CHARS: usize = 600;
/// The most recent messages are never rewritten.
const KEEP_TAIL_MESSAGES: usize = 8;
/// Marker prefix for tool errors (KeepErrors: never compact these).
const ERROR_PREFIX: &str = "ERROR:";

/// Rough token estimate: serialized bytes / 4.
pub fn estimate_tokens(messages: &[ChatMessage]) -> u64 {
    let bytes: usize = messages
        .iter()
        .map(|m| serde_json::to_vec(m).map(|v| v.len()).unwrap_or(0))
        .sum();
    (bytes as u64) / 4
}

/// Which compression tier the transcript currently needs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CompactLevel {
    None,
    Snip,
    Compact,
    Force,
}

pub fn decide(used_tokens: u64, window: u64) -> CompactLevel {
    if window == 0 {
        return CompactLevel::None;
    }
    let ratio = used_tokens as f64 / window as f64;
    if ratio >= COMPACT_FORCE_RATIO {
        CompactLevel::Force
    } else if ratio >= COMPACT_RATIO {
        CompactLevel::Compact
    } else if ratio >= TOOL_RESULT_SNIP_RATIO {
        CompactLevel::Snip
    } else {
        CompactLevel::None
    }
}

/// Tier 1: truncate oversized tool results in place. Returns how many
/// messages were modified.
pub fn snip_tool_results(messages: &mut [ChatMessage], force: bool) -> usize {
    let keep = if force {
        FORCE_SNIP_KEEP_CHARS
    } else {
        SNIP_KEEP_CHARS
    };
    let mut changed = 0usize;
    for msg in messages.iter_mut() {
        if msg.role != "tool" {
            continue;
        }
        let Some(Content::Text(content)) = msg.content.as_mut() else {
            continue;
        };
        if content.starts_with(ERROR_PREFIX) || content.starts_with("[snipped") {
            continue; // KeepErrors + idempotence
        }
        if snip_string(content, keep) {
            changed += 1;
        }
    }
    changed
}

/// Head+tail truncation with a marker in between. Returns true if changed.
fn snip_string(s: &mut String, keep_chars: usize) -> bool {
    let total = s.chars().count();
    if total <= keep_chars {
        return false;
    }
    let half = keep_chars / 2;
    let head: String = s.chars().take(half).collect();
    let tail: String = s.chars().skip(total - half).collect();
    *s =
        format!("[snipped: keeping {half} head + {half} tail chars of {total}]\n{head}\n…\n{tail}");
    true
}

/// Tier 2/3: rewrite the old prefix. Returns the pre-rewrite copies of every
/// modified message (for archiving). Pairing invariant: a `tool` message is
/// only touched together with its owning assistant `tool_calls` turn — both
/// stay in place, only their payloads shrink, so ids keep matching.
pub fn compact(messages: &mut [ChatMessage], force: bool) -> Vec<ChatMessage> {
    let mut archived: Vec<ChatMessage> = Vec::new();
    if messages.len() <= KEEP_TAIL_MESSAGES + 1 {
        return archived; // nothing outside the protected tail
    }
    let boundary = messages.len() - KEEP_TAIL_MESSAGES;

    // First fold old assistant prose (force tier), then snip tool results
    // inside the rewritable region.
    for (idx, msg) in messages.iter_mut().enumerate() {
        if idx == 0 || idx >= boundary {
            continue; // system prompt + recent tail are untouchable
        }
        if force && msg.role == "assistant" && msg.tool_calls.is_none() {
            let should_fold = msg
                .content
                .as_ref()
                .and_then(Content::as_text)
                .map(|c| !c.starts_with("[compacted"))
                .unwrap_or(false);
            if should_fold {
                archived.push(msg.clone());
                let chars = msg.content.as_ref().map(Content::text_len).unwrap_or(0);
                msg.content = Some(Content::Text(format!(
                    "[compacted: {chars} chars of earlier assistant prose]"
                )));
            }
        }
    }

    // Snip tool results in the rewritable region only.
    let keep = if force {
        FORCE_SNIP_KEEP_CHARS
    } else {
        SNIP_KEEP_CHARS
    };
    for (idx, msg) in messages.iter_mut().enumerate() {
        if idx == 0 || idx >= boundary || msg.role != "tool" {
            continue;
        }
        let needs_snip = msg
            .content
            .as_ref()
            .and_then(Content::as_text)
            .map(|c| {
                !c.starts_with(ERROR_PREFIX)
                    && !c.starts_with("[snipped")
                    && c.chars().count() > keep
            })
            .unwrap_or(false);
        if !needs_snip {
            continue; // KeepErrors + idempotence
        }
        let before = msg
            .content
            .as_ref()
            .and_then(Content::as_text)
            .unwrap_or_default()
            .to_string();
        if let Some(Content::Text(content)) = msg.content.as_mut() {
            snip_string(content, keep);
        }
        let mut original = msg.clone();
        original.content = Some(Content::Text(before));
        archived.push(original);
    }
    archived
}

/// Writes archived (pre-rewrite) messages to `archive_dir/<timestamp>.jsonl`.
/// Returns the file written, if anything was archived.
pub fn archive(archive_dir: &Path, removed: &[ChatMessage]) -> Option<PathBuf> {
    if removed.is_empty() {
        return None;
    }
    if std::fs::create_dir_all(archive_dir).is_err() {
        return None;
    }
    let ts = chrono::Local::now().format("%Y%m%d-%H%M%S-%3f");
    // Unique nonce: two compactions within the same millisecond must not
    // overwrite each other's archive (which would corrupt history search).
    let nonce = uuid::Uuid::new_v4().simple().to_string();
    let path = archive_dir.join(format!("{ts}-{nonce}.jsonl"));
    let mut buf = String::new();
    for msg in removed {
        if let Ok(line) = serde_json::to_string(msg) {
            buf.push_str(&line);
            buf.push('\n');
        }
    }
    match std::fs::write(&path, buf) {
        Ok(()) => Some(path),
        Err(e) => {
            log::warn!("failed to archive compacted messages: {e}");
            None
        }
    }
}

/// Stable marker prefix for summary splices so the model (and `history`)
/// can tell at a glance that a transcript message is a folded-summary
/// anchor pointing at the archive, not a literal user/assistant turn.
pub const SUMMARY_MARKER: &str = "[nex:summary]";

/// Splices a single summary message into the rewritable prefix, after
/// archiving the original prefix contents to a fresh archive file. The
/// pairing invariant (assistant `tool_calls` ↔ `tool` results) is
/// preserved because the rewritable region only covers turns that are
/// already in scope for [`compact`].
pub struct SummarySplice {
    /// File written of the archived original prefix. `None` when nothing was
    /// folded (e.g. empty rewritable region).
    pub archive_file: Option<PathBuf>,
    /// Reference the model (and `history`) should use to recover the full
    /// original contents. Mirrors `archive_file` filename when present.
    pub archive_ref: Option<String>,
}

/// Replace the rewritable prefix (everything before the protected tail)
/// with a single summary message that names the archive. Returns
/// [`SummarySplice`] describing the file written.
///
/// `summary_text` is used verbatim. Callers compose the actual content
/// (template-driven in [`crate::agent::native::summary`]) so this helper
/// stays focused on the splice mechanics.
pub fn replace_prefix_with_summary(
    messages: &mut Vec<ChatMessage>,
    summary_text: String,
    archive_dir: &Path,
) -> SummarySplice {
    if messages.len() <= KEEP_TAIL_MESSAGES + 1 {
        return SummarySplice {
            archive_file: None,
            archive_ref: None,
        };
    }
    let boundary = messages.len() - KEEP_TAIL_MESSAGES;
    // Snapshot the original prefix (everything between system prompt and
    // tail) before splicing the summary in. The tool↔assistant pairing is
    // already inside this prefix and is preserved as a unit.
    let prefix: Vec<ChatMessage> = messages[1..boundary].to_vec();
    let archive_file = archive(archive_dir, &prefix);
    let archive_ref = archive_file
        .as_ref()
        .and_then(|p| p.file_name().and_then(|s| s.to_str()).map(String::from));
    let mut summary_msg = ChatMessage::assistant(summary_text);
    if let Some(ref r) = archive_ref {
        // Pin the role to assistant (never system) so the summary can't
        // be mistaken for instructions; inject the archive ref into the
        // content for downstream `history` queries.
        summary_msg.content = Some(Content::Text(format!(
            "{}\n[archive_ref: {}]",
            summary_msg
                .content
                .as_ref()
                .and_then(Content::as_text)
                .unwrap_or(""),
            r
        )));
    }
    // Splice: keep system prompt (idx 0) + summary + protected tail.
    let new_len = 1 + 1 + KEEP_TAIL_MESSAGES;
    let tail_start = boundary;
    let mut new_msgs: Vec<ChatMessage> = Vec::with_capacity(new_len);
    new_msgs.push(messages[0].clone());
    new_msgs.push(summary_msg);
    new_msgs.extend(messages[tail_start..].iter().cloned());
    *messages = new_msgs;
    SummarySplice {
        archive_file,
        archive_ref,
    }
}

/// Applies the appropriate tier for the current transcript size. Returns the
/// archive file written, if any. `window = 0` is a no-op.
pub fn maybe_compress(
    messages: &mut [ChatMessage],
    window: u64,
    archive_dir: &Path,
) -> Option<PathBuf> {
    let level = decide(estimate_tokens(messages), window);
    match level {
        CompactLevel::None => None,
        CompactLevel::Snip => {
            snip_tool_results(messages, false);
            None
        }
        CompactLevel::Compact | CompactLevel::Force => {
            let removed = compact(messages, matches!(level, CompactLevel::Force));
            let path = archive(archive_dir, &removed);
            // Snipping may still be needed after folding.
            snip_tool_results(messages, matches!(level, CompactLevel::Force));
            path
        }
    }
}

/// Which tier a single [`step`] should apply. Lets the budget loop walk
/// `Snip -> Compact -> Force` deliberately, instead of inferring from the
/// current size each pass (which would jump straight to `Force` on a
/// partially-shrunk transcript and lose the snip-only chance to fit).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StepTier {
    Snip,
    Compact,
    Force,
}

impl StepTier {
    /// Convert to the legacy [`CompactLevel`] used by the snip/compact
    /// helpers below. `Force` produces a force-pass.
    fn as_level(self) -> CompactLevel {
        match self {
            StepTier::Snip => CompactLevel::Snip,
            StepTier::Compact => CompactLevel::Compact,
            StepTier::Force => CompactLevel::Force,
        }
    }
}

/// Result of a single [`step`] pass. Used by the budget loop and metrics.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct StepOutcome {
    pub snipped: usize,
    pub folded: usize,
    pub archive_file: Option<std::path::PathBuf>,
}

/// One budget-driven compaction pass. Returns the number of messages that
/// were modified (snipped) or folded (archived) in this pass, plus the
/// archive file written, if any.
///
/// This is the building block used by the budget loop. Unlike
/// [`maybe_compress`], the caller decides whether another pass is needed by
/// re-estimating `messages` and comparing against `prompt_budget`.
///
/// `tier` overrides the level inferred from transcript size so the caller
/// can walk `Snip -> Compact -> Force` deliberately.
///
/// Idempotent: a no-op when `prompt_budget` is already satisfied.
pub fn step(
    messages: &mut Vec<ChatMessage>,
    prompt_budget: u64,
    tier: StepTier,
    archive_dir: &Path,
) -> StepOutcome {
    if prompt_budget == 0 {
        return StepOutcome::default();
    }
    if estimate_tokens(messages) <= prompt_budget {
        return StepOutcome::default();
    }
    let force = tier == StepTier::Force;
    match tier.as_level() {
        CompactLevel::None | CompactLevel::Snip => {
            let snipped = snip_tool_results(messages, false);
            StepOutcome {
                snipped,
                folded: 0,
                archive_file: None,
            }
        }
        CompactLevel::Compact | CompactLevel::Force => {
            let removed = compact(messages, force);
            let folded = removed.len();
            let archive_file = archive(archive_dir, &removed);
            let snipped = snip_tool_results(messages, force);
            StepOutcome {
                snipped,
                folded,
                archive_file,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::native::provider::{ChatToolCall, ChatToolCallFunction};

    fn tool_msg(id: &str, content: &str) -> ChatMessage {
        ChatMessage::tool_result(id, content)
    }

    fn assistant_calls(ids: &[&str]) -> ChatMessage {
        ChatMessage::assistant_tool_calls(
            ids.iter()
                .map(|id| ChatToolCall {
                    id: id.to_string(),
                    typ: "function".into(),
                    function: ChatToolCallFunction {
                        name: "read_file".into(),
                        arguments: "{}".into(),
                    },
                })
                .collect(),
            None,
        )
    }

    #[test]
    fn token_estimate_is_bytes_over_four() {
        let msgs = vec![ChatMessage::user("abcd")];
        assert!(estimate_tokens(&msgs) > 0);
        assert_eq!(decide(0, 0), CompactLevel::None); // window=0 disables
        assert_eq!(decide(59, 100), CompactLevel::None);
        assert_eq!(decide(65, 100), CompactLevel::Snip);
        assert_eq!(decide(85, 100), CompactLevel::Compact);
        assert_eq!(decide(95, 100), CompactLevel::Force);
    }

    #[test]
    fn snip_keeps_errors_and_is_idempotent() {
        let big = "x".repeat(5000);
        let mut msgs = vec![
            tool_msg("1", &big),
            tool_msg("2", &format!("{ERROR_PREFIX} boom {}", "y".repeat(5000))),
        ];
        assert_eq!(snip_tool_results(&mut msgs, false), 1);
        assert!(msgs[0]
            .content
            .as_ref()
            .and_then(Content::as_text)
            .unwrap()
            .starts_with("[snipped"));
        assert!(msgs[1]
            .content
            .as_ref()
            .and_then(Content::as_text)
            .unwrap()
            .starts_with(ERROR_PREFIX));
        // Second pass changes nothing.
        assert_eq!(snip_tool_results(&mut msgs, false), 0);
    }

    #[test]
    fn compact_preserves_tail_and_system_and_errors() {
        let big = "z".repeat(5000);
        let mut msgs: Vec<ChatMessage> = vec![ChatMessage::system("sys")];
        // Old rewritable prefix: paired assistant calls + results (one error).
        msgs.push(assistant_calls(&["a", "b"]));
        msgs.push(tool_msg("a", &big));
        msgs.push(tool_msg("b", &format!("{ERROR_PREFIX} old failure")));
        msgs.push(ChatMessage::assistant("old prose ".repeat(300)));
        // Pad the prefix so it clearly exceeds the protected tail window.
        for i in 0..4 {
            msgs.push(assistant_calls(&[&format!("p{i}")]));
            msgs.push(tool_msg(&format!("p{i}"), &big));
        }
        // Recent tail (<= KEEP_TAIL_MESSAGES): must survive untouched.
        msgs.push(assistant_calls(&["c"]));
        msgs.push(tool_msg("c", &big.clone()));
        msgs.push(ChatMessage::assistant("recent answer"));

        let archived = compact(&mut msgs, true);
        assert!(!archived.is_empty());

        // System intact.
        assert_eq!(
            msgs[0].content.as_ref().and_then(Content::as_text),
            Some("sys")
        );
        // Old prose folded.
        assert!(msgs[4]
            .content
            .as_ref()
            .and_then(Content::as_text)
            .unwrap()
            .starts_with("[compacted"));
        // Error result kept verbatim (KeepErrors).
        assert!(msgs[3]
            .content
            .as_ref()
            .and_then(Content::as_text)
            .unwrap()
            .starts_with(ERROR_PREFIX));
        // Tail untouched: the big recent result is still big.
        let n = msgs.len();
        assert_eq!(
            msgs[n - 2]
                .content
                .as_ref()
                .and_then(Content::as_text)
                .unwrap()
                .len(),
            big.len()
        );
        assert_eq!(
            msgs[n - 1].content.as_ref().and_then(Content::as_text),
            Some("recent answer")
        );
    }

    /// The pairing invariant: after any compression pass, every `tool`
    /// message's `tool_call_id` still resolves to a preceding assistant
    /// `tool_calls` entry.
    #[test]
    fn compact_keeps_toolcall_pairing() {
        let big = "q".repeat(9000);
        let mut msgs: Vec<ChatMessage> = vec![ChatMessage::system("sys")];
        for i in 0..12 {
            msgs.push(assistant_calls(&[&format!("id{i}")]));
            msgs.push(tool_msg(&format!("id{i}"), &big));
            msgs.push(ChatMessage::assistant(format!("step {i} done")));
        }
        compact(&mut msgs, true);
        snip_tool_results(&mut msgs, true);

        let mut seen_ids: Vec<String> = Vec::new();
        for msg in &msgs {
            if let Some(calls) = &msg.tool_calls {
                for c in calls {
                    seen_ids.push(c.id.clone());
                }
            }
            if msg.role == "tool" {
                let id = msg.tool_call_id.as_deref().unwrap();
                assert!(seen_ids.iter().any(|s| s == id), "orphan tool result {id}");
            }
        }
    }

    #[test]
    fn archive_writes_jsonl() {
        let tmp = tempfile::tempdir().unwrap();
        let removed = vec![ChatMessage::assistant("gone"), tool_msg("x", "also gone")];
        let path = archive(tmp.path(), &removed).expect("archive file");
        assert!(path.extension().unwrap() == "jsonl");
        let lines = std::fs::read_to_string(&path).unwrap();
        assert_eq!(lines.lines().count(), 2);
        assert!(archive(tmp.path(), &[]).is_none());
    }

    #[test]
    fn replace_prefix_with_summary_archives_and_preserves_pairing() {
        let tmp = tempfile::tempdir().unwrap();
        // System prompt (idx 0), assistant with two tool calls, two tool
        // results, an old assistant prose, plus a recent tail that must
        // survive untouched.
        let mut msgs: Vec<ChatMessage> = vec![ChatMessage::system("sys")];
        msgs.push(assistant_calls(&["a", "b"]));
        msgs.push(tool_msg("a", "alpha"));
        msgs.push(tool_msg("b", "beta"));
        msgs.push(ChatMessage::assistant("old prose ".repeat(80)));
        // Pad so the rewritable region is clearly > KEEP_TAIL_MESSAGES.
        for i in 0..6 {
            msgs.push(assistant_calls(&[&format!("p{i}")]));
            msgs.push(tool_msg(&format!("p{i}"), "payload"));
        }
        // Recent tail (≤ KEEP_TAIL_MESSAGES): must survive untouched.
        msgs.push(ChatMessage::assistant("current tail answer"));

        let original_len = msgs.len();
        // Use the stable summary template so the marker is present in
        // the spliced block (the marker is added by `summary::render_*`,
        // not by `replace_prefix_with_summary` itself).
        let body = crate::agent::native::summary::render_session_summary(
            &["ship v1".into()],
            &["api key in env".into()],
            &[("src/main.rs".into(), "boot path".into())],
            &[("src/main.rs".into(), "wired config".into())],
            &["verify cache".into()],
            None,
        );
        let splice = replace_prefix_with_summary(&mut msgs, body, tmp.path());
        assert!(splice.archive_file.is_some());
        assert!(splice.archive_ref.is_some());
        // Layout: system + summary + tail. Protected tail length unchanged.
        assert_eq!(msgs.len(), 1 + 1 + KEEP_TAIL_MESSAGES);
        // System prompt untouched.
        assert_eq!(
            msgs[0].content.as_ref().and_then(Content::as_text),
            Some("sys")
        );
        // Summary message carries the archive_ref line.
        let summary_text = msgs[1]
            .content
            .as_ref()
            .and_then(Content::as_text)
            .unwrap();
        assert!(summary_text.starts_with(SUMMARY_MARKER));
        assert!(summary_text.contains("archive_ref"));
        assert!(summary_text.contains(splice.archive_ref.as_deref().unwrap()));
        // Recent tail untouched.
        assert_eq!(
            msgs.last().unwrap().content.as_ref().and_then(Content::as_text),
            Some("current tail answer")
        );
        // Length sanity: removed everything except system+summary+tail.
        assert!(original_len > msgs.len());
    }

    #[test]
    fn maybe_compress_window_zero_is_noop() {
        let big = "w".repeat(20_000);
        let mut msgs = vec![ChatMessage::system("s"), tool_msg("1", &big)];
        let tmp = tempfile::tempdir().unwrap();
        assert!(maybe_compress(&mut msgs, 0, tmp.path()).is_none());
        assert_eq!(
            msgs[1]
                .content
                .as_ref()
                .and_then(Content::as_text)
                .unwrap()
                .len(),
            big.len()
        );
    }

    #[test]
    fn step_zero_budget_is_noop() {
        let big = "w".repeat(20_000);
        let mut msgs = vec![ChatMessage::system("s"), tool_msg("1", &big)];
        let tmp = tempfile::tempdir().unwrap();
        let outcome = step(&mut msgs, 0, StepTier::Snip, tmp.path());
        assert_eq!(outcome.snipped, 0);
        assert_eq!(outcome.folded, 0);
        assert!(outcome.archive_file.is_none());
        assert_eq!(
            msgs[1]
                .content
                .as_ref()
                .and_then(Content::as_text)
                .unwrap()
                .len(),
            big.len()
        );
    }

    #[test]
    fn step_under_budget_is_noop() {
        let mut msgs = vec![ChatMessage::system("s"), ChatMessage::user("hi")];
        let tmp = tempfile::tempdir().unwrap();
        let outcome = step(&mut msgs, 4096, StepTier::Snip, tmp.path());
        assert_eq!(outcome, StepOutcome::default());
    }

    #[test]
    fn step_within_budget_returns_to_archive() {
        let big = "y".repeat(10_000);
        let mut msgs = vec![ChatMessage::system("s"), tool_msg("a", &big)];
        let tmp = tempfile::tempdir().unwrap();
        let outcome = step(&mut msgs, 100, StepTier::Force, tmp.path());
        assert!(outcome.snipped > 0 || outcome.folded > 0);
        if outcome.folded > 0 {
            assert!(outcome.archive_file.is_some());
        }
    }
}
