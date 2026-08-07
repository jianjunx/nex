//! Session-level instruction injection: user rules and the project `AGENTS.md`.
//!
//! Two sources, both optional:
//! - **Rules**: markdown files under `~/.nex/rules/` (global) and
//!   `<project>/.nex/rules/` (project-scoped, applied after global so project
//!   rules read last).
//! - **AGENTS.md**: the project-root `AGENTS.md` (falling back to `CLAUDE.md`),
//!   the conventional place projects put agent-facing instructions.
//!
//! Everything is gathered once per session (when the transcript is seeded) so
//! the byte-stable system prompt stays warm.

use std::path::Path;

/// Collects rule markdown from the global `~/.nex/rules` and the project's
/// `.nex/rules`, concatenated into one block. Returns an empty string when no
/// rules exist. Files are read in sorted filename order for stability.
pub fn rules_block(cwd: &Path) -> String {
    let mut parts: Vec<String> = Vec::new();

    if let Some(global) = crate::agent::native::home::rules_dir() {
        parts.extend(read_md_files(&global));
    }
    parts.extend(read_md_files(&cwd.join(".nex").join("rules")));

    if parts.is_empty() {
        return String::new();
    }
    let mut out = String::from("# Rules\n");
    out.push_str("Follow these standing instructions for every task:\n\n");
    out.push_str(&parts.join("\n\n"));
    out
}

/// Reads every `*.md` file directly inside `dir` (non-recursive), sorted by
/// file name. Missing/empty directories yield nothing.
fn read_md_files(dir: &Path) -> Vec<String> {
    let mut files: Vec<_> = match std::fs::read_dir(dir) {
        Ok(entries) => entries
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.is_file() && p.extension().is_some_and(|x| x == "md"))
            .collect(),
        Err(_) => return Vec::new(),
    };
    files.sort();
    files
        .into_iter()
        .filter_map(|p| std::fs::read_to_string(p).ok())
        .filter(|c| !c.trim().is_empty())
        .map(|c| c.trim().to_string())
        .collect()
}

/// Reads the project-root `AGENTS.md`, falling back to `CLAUDE.md`. Returns an
/// empty string when neither exists or the file is blank.
pub fn agents_md_block(cwd: &Path) -> String {
    for name in ["AGENTS.md", "CLAUDE.md"] {
        let path = cwd.join(name);
        if let Ok(content) = std::fs::read_to_string(&path) {
            let content = content.trim();
            if !content.is_empty() {
                return format!("# Project instructions ({name})\n{content}");
            }
        }
    }
    String::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(dir: &Path, rel: &str, content: &str) {
        let p = dir.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, content).unwrap();
    }

    #[test]
    fn project_rules_are_collected_sorted() {
        let tmp = tempfile::tempdir().unwrap();
        write(tmp.path(), ".nex/rules/02-b.md", "rule B");
        write(tmp.path(), ".nex/rules/01-a.md", "rule A");
        write(tmp.path(), ".nex/rules/not-md.txt", "ignored");

        let block = rules_block(tmp.path());
        assert!(block.contains("# Rules"));
        let a = block.find("rule A").unwrap();
        let b = block.find("rule B").unwrap();
        assert!(a < b, "rules must be in sorted filename order");
        assert!(!block.contains("ignored"));
    }

    #[test]
    fn rules_block_empty_when_no_rules() {
        let tmp = tempfile::tempdir().unwrap();
        assert_eq!(rules_block(tmp.path()), "");
    }

    #[test]
    fn agents_md_preferred_then_claude_fallback() {
        let tmp = tempfile::tempdir().unwrap();
        write(tmp.path(), "CLAUDE.md", "claude instructions");
        assert!(agents_md_block(tmp.path()).contains("claude instructions"));

        write(tmp.path(), "AGENTS.md", "agents instructions");
        let block = agents_md_block(tmp.path());
        assert!(block.contains("agents instructions"));
        assert!(!block.contains("claude instructions"));
    }

    #[test]
    fn agents_md_blank_is_ignored() {
        let tmp = tempfile::tempdir().unwrap();
        write(tmp.path(), "AGENTS.md", "   \n  ");
        assert_eq!(agents_md_block(tmp.path()), "");
    }
}
