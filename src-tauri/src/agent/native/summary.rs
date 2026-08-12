//! Stable summary templates used by `compact::replace_prefix_with_summary`.
//!
//! The format is intentionally rigid so that:
//!  - prefix cache stays stable across turns (only the time-stamp inside
//!    the archive ref shifts);
//!  - `history` can grep for `[archive_ref: <file>]` and route the user
//!    straight to the right archive file.
//!
//! Templates stay in Chinese to match the rest of the agent's surface
//! (system prompt, tool descriptions, errors).

use crate::agent::native::compact::SUMMARY_MARKER;
use crate::agent::native::provider::{ChatMessage, Content};

/// Render the standard session summary block. Keep the field order stable.
pub fn render_session_summary(
    goal: &[String],
    facts: &[String],
    files_inspected: &[(String, String)],
    changes_made: &[(String, String)],
    open_questions: &[String],
    archive_ref: Option<&str>,
) -> String {
    let mut s = String::new();
    s.push_str(&format!("{SUMMARY_MARKER} session summary\n"));
    if !goal.is_empty() {
        s.push_str("Goal:\n");
        for g in goal {
            s.push_str(&format!("- {g}\n"));
        }
    }
    if !facts.is_empty() {
        s.push_str("Facts established:\n");
        for f in facts {
            s.push_str(&format!("- {f}\n"));
        }
    }
    if !files_inspected.is_empty() {
        s.push_str("Files inspected:\n");
        for (path, why) in files_inspected {
            s.push_str(&format!("- {path}: {why}\n"));
        }
    }
    if !changes_made.is_empty() {
        s.push_str("Changes made:\n");
        for (path, change) in changes_made {
            s.push_str(&format!("- {path} -> {change}\n"));
        }
    }
    if !open_questions.is_empty() {
        s.push_str("Open questions:\n");
        for q in open_questions {
            s.push_str(&format!("- {q}\n"));
        }
    }
    if let Some(r) = archive_ref {
        s.push_str(&format!("Archived details: archive ref {r}; use `history` to search it.\n"));
    }
    s
}

/// Extremely conservative fallback summary for the *current* transcript.
/// Used only when the budget loop exhausted Snip -> Compact -> Force and
/// the prompt still does not fit. This is intentionally dumb but stable:
/// it extracts just enough state to keep the session moving without trying
/// to do semantic summarisation inside Rust.
pub fn render_fallback_summary(messages: &[ChatMessage]) -> String {
    let mut goal: Vec<String> = Vec::new();
    let mut facts: Vec<String> = Vec::new();
    let mut open: Vec<String> = Vec::new();

    // Most recent user text becomes the provisional goal.
    for msg in messages.iter().rev() {
        if msg.role != "user" {
            continue;
        }
        let Some(text) = msg.content.as_ref().and_then(Content::as_text) else {
            continue;
        };
        let line = text.lines().find(|l| !l.trim().is_empty()).unwrap_or(text).trim();
        if !line.is_empty() {
            goal.push(line.chars().take(160).collect());
            break;
        }
    }

    // Detect whether tool errors or workspace writes happened at all in the
    // prefix. We don't attempt a per-file delta here; that belongs to the
    // higher-fidelity WorkingMemory path.
    let mut saw_tool_error = false;
    let mut saw_tool_call = false;
    for msg in messages {
        if msg.role == "tool" {
            saw_tool_call = true;
            let text = msg.content.as_ref().and_then(Content::as_text).unwrap_or("");
            if text.starts_with("ERROR:") || text.contains("exit code:") {
                saw_tool_error = true;
            }
        }
    }
    if saw_tool_call {
        facts.push("Earlier tool results were archived to keep the prompt within budget".into());
    }
    if saw_tool_error {
        open.push("At least one earlier tool result was an error; inspect archive/history before assuming success".into());
    }

    render_session_summary(&goal, &facts, &[], &[], &open, None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn render_is_stable_across_calls() {
        let a = render_session_summary(
            &["ship v1".into()],
            &["api key in env".into()],
            &[("src/main.rs".into(), "boot path".into())],
            &[("src/main.rs".into(), "wired config".into())],
            &["verify cache".into()],
            Some("20260810-103045-abc.jsonl"),
        );
        let b = render_session_summary(
            &["ship v1".into()],
            &["api key in env".into()],
            &[("src/main.rs".into(), "boot path".into())],
            &[("src/main.rs".into(), "wired config".into())],
            &["verify cache".into()],
            Some("20260810-103045-abc.jsonl"),
        );
        assert_eq!(a, b);
        assert!(a.contains(SUMMARY_MARKER));
        assert!(a.contains("archive ref 20260810-103045-abc.jsonl"));
    }

    #[test]
    fn fallback_summary_extracts_user_goal_and_error_hint() {
        let msgs = vec![
            ChatMessage::system("sys"),
            ChatMessage::user("修一下 cache 命中率"),
            ChatMessage::tool_result("1", "ERROR: build failed"),
        ];
        let s = render_fallback_summary(&msgs);
        assert!(s.contains(SUMMARY_MARKER));
        assert!(s.contains("修一下 cache 命中率"));
        assert!(s.contains("error".to_lowercase().as_str()) || s.contains("Earlier tool results"));
    }
}
