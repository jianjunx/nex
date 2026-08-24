//! NexAgent diagnostic log lines (`log` target `nex_agent`).
//!
//! Purpose: reconstruct hangs, unexpected stops, and provider/tool errors.
//! The app logger writes these to `~/.nex/logs/nex.log`. Never log API keys,
//! Authorization headers, or full prompt / tool bodies.

use super::home;

pub const TARGET: &str = "nex_agent";

/// `~/.nex/logs`, created on demand. `None` when home cannot be resolved.
pub fn log_dir() -> Option<std::path::PathBuf> {
    home::nex_home().map(|h| h.join("logs"))
}

pub fn info(session: &str, msg: impl std::fmt::Display) {
    log::info!(target: TARGET, "sid={} {msg}", sid(session));
}

pub fn warn(session: &str, msg: impl std::fmt::Display) {
    log::warn!(target: TARGET, "sid={} {msg}", sid(session));
}

pub fn error(session: &str, msg: impl std::fmt::Display) {
    log::error!(target: TARGET, "sid={} {msg}", sid(session));
}

/// First 8 chars of a session/conversation id (enough to correlate, short in grep).
pub fn sid(session: &str) -> &str {
    let end = session
        .char_indices()
        .nth(8)
        .map(|(i, _)| i)
        .unwrap_or(session.len());
    &session[..end]
}

/// Single-line preview; collapses whitespace and truncates.
pub fn preview(s: &str, max_chars: usize) -> String {
    let collapsed: String = s.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut out: String = collapsed.chars().take(max_chars).collect();
    if collapsed.chars().count() > max_chars {
        out.push('…');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sid_truncates_to_eight_chars() {
        assert_eq!(sid("abcdefghij"), "abcdefgh");
        assert_eq!(sid("short"), "short");
        assert_eq!(sid(""), "");
    }

    #[test]
    fn preview_collapses_and_truncates() {
        assert_eq!(preview("  hello   world  ", 20), "hello world");
        assert_eq!(preview("abcdef", 4), "abcd…");
    }
}
