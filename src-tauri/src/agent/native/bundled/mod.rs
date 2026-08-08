//! Built-in slash commands and skills seeded into `~/.nex` on first use.
//!
//! Existing user files are never overwritten — only missing paths are written.

use std::path::Path;

/// Seeds default commands + skills under `nex_home` when absent.
pub fn ensure_bundled(nex_home: &Path) {
    let commands_dir = nex_home.join("commands");
    let skills_dir = nex_home.join("skills");
    let _ = std::fs::create_dir_all(&commands_dir);
    let _ = std::fs::create_dir_all(&skills_dir);

    for (name, body) in COMMANDS {
        write_if_missing(&commands_dir.join(format!("{name}.md")), body);
    }
    for (name, body) in SKILLS {
        let dir = skills_dir.join(name);
        let _ = std::fs::create_dir_all(&dir);
        write_if_missing(&dir.join("SKILL.md"), body);
    }
}

/// Names of bundled skills (used by the settings UI for the `builtin` badge).
pub fn bundled_skill_names() -> &'static [&'static str] {
    &["git-commit", "code-review", "debug", "refactor"]
}

fn write_if_missing(path: &Path, contents: &str) {
    if path.exists() {
        return;
    }
    if let Err(e) = std::fs::write(path, contents) {
        log::warn!("failed to seed {}: {e}", path.display());
    }
}

const COMMANDS: &[(&str, &str)] = &[
    (
        "commit",
        include_str!("commands/commit.md"),
    ),
    (
        "review",
        include_str!("commands/review.md"),
    ),
    (
        "explain",
        include_str!("commands/explain.md"),
    ),
    (
        "fix",
        include_str!("commands/fix.md"),
    ),
    (
        "test",
        include_str!("commands/test.md"),
    ),
    (
        "optimize",
        include_str!("commands/optimize.md"),
    ),
];

const SKILLS: &[(&str, &str)] = &[
    (
        "git-commit",
        include_str!("skills/git-commit/SKILL.md"),
    ),
    (
        "code-review",
        include_str!("skills/code-review/SKILL.md"),
    ),
    (
        "debug",
        include_str!("skills/debug/SKILL.md"),
    ),
    (
        "refactor",
        include_str!("skills/refactor/SKILL.md"),
    ),
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seeds_missing_and_preserves_existing() {
        let tmp = tempfile::tempdir().unwrap();
        ensure_bundled(tmp.path());
        let commit = tmp.path().join("commands/commit.md");
        assert!(commit.is_file());
        std::fs::write(&commit, "USER").unwrap();
        ensure_bundled(tmp.path());
        assert_eq!(std::fs::read_to_string(&commit).unwrap(), "USER");
        assert!(tmp.path().join("skills/git-commit/SKILL.md").is_file());
    }
}
