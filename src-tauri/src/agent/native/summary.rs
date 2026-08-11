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
}