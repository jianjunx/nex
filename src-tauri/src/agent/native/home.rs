//! The `~/.nex` home directory: the user-level root for Nex extensibility
//! artifacts (skills, rules, ...). Mirrors the `~/.claude` convention so skills
//! authored for Claude can be dropped in with little or no change.

use std::path::PathBuf;

/// The Nex home directory (`~/.nex`), or `None` when the OS home directory
/// cannot be resolved. Callers treat `None` as "feature unavailable" rather
/// than failing the whole session.
pub fn nex_home() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".nex"))
}

/// `~/.nex/skills` — root of Claude-compatible agent skills.
pub fn skills_dir() -> Option<PathBuf> {
    nex_home().map(|h| h.join("skills"))
}

/// `~/.nex/rules` — global user rules (`*.md`), applied to every session.
pub fn rules_dir() -> Option<PathBuf> {
    nex_home().map(|h| h.join("rules"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn home_subdirs_nest_under_dot_nex() {
        let Some(home) = nex_home() else { return };
        assert_eq!(skills_dir().unwrap(), home.join("skills"));
        assert_eq!(rules_dir().unwrap(), home.join("rules"));
        assert!(home.ends_with(".nex"));
    }
}
