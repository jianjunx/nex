//! Claude-compatible slash commands.
//!
//! A command is a markdown file `<name>.md` with YAML frontmatter
//! (`description`, optional `argument-hint`; unknown fields like
//! `allowed-tools` are tolerated for Claude compatibility) whose body is a
//! prompt template. At expansion time `$ARGUMENTS` in the body is replaced by
//! the text typed after `/name`.
//!
//! Commands are discovered in `~/.nex/commands` (global, applies to every
//! session) then `<cwd>/.nex/commands` (project level, overrides same-name
//! entries). The catalog is published once per session via
//! `AvailableCommandsUpdate`; expansion happens per turn inside `prompt()`
//! (the chat bubble keeps the user's raw input, the model sees the expansion).

use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// A parsed slash command.
#[derive(Debug, Clone)]
pub struct Command {
    /// Name without the leading slash (the Composer inserts it on pick).
    pub name: String,
    pub description: String,
    pub argument_hint: Option<String>,
    /// Prompt template body; `$ARGUMENTS` is substituted at expansion time.
    pub body: String,
}

/// Discovers commands for a session working dir: global `~/.nex/commands`
/// first, then project `.nex/commands` overriding same-name entries. The
/// result is sorted by name so the published catalog is byte-stable.
pub fn discover(cwd: &Path) -> Vec<Command> {
    discover_in(cwd, super::home::commands_dir())
}

/// Discovers slash commands for a session, merging in installed skills so
/// they appear in the Composer's `/` menu (Claude Code behaviour: skills are
/// invokable as slash commands). Commands win name collisions with skills;
/// project `.nex/skills` override same-name global skills; disabled skills
/// (config `disabled_skills`) are skipped. Result is sorted by name so the
/// published catalog is byte-stable.
pub fn discover_with_skills(cwd: &Path, disabled_skills: &[String]) -> Vec<Command> {
    discover_with_skills_in(
        cwd,
        super::home::commands_dir(),
        super::home::skills_dir(),
        disabled_skills,
    )
}

/// `discover_with_skills` with injectable global dirs (tests).
pub fn discover_with_skills_in(
    cwd: &Path,
    global_commands: Option<PathBuf>,
    skills_root: Option<PathBuf>,
    disabled_skills: &[String],
) -> Vec<Command> {
    let mut by_name: HashMap<String, Command> = HashMap::new();
    for cmd in discover_in(cwd, global_commands) {
        by_name.insert(cmd.name.clone(), cmd);
    }
    for skill in super::skills::discover_for_cwd(Some(cwd), skills_root.as_deref()) {
        if disabled_skills.iter().any(|d| d == &skill.name) {
            continue;
        }
        if by_name.contains_key(&skill.name) {
            continue;
        }
        let body = super::skills::load_body_from_dir(&skill.dir).unwrap_or_default();
        by_name.insert(
            skill.name.clone(),
            Command {
                name: skill.name.clone(),
                description: skill.description.clone(),
                argument_hint: None,
                body,
            },
        );
    }
    let mut out: Vec<Command> = by_name.into_values().collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

/// `discover` with an injectable global directory (tests).
pub fn discover_in(cwd: &Path, global: Option<std::path::PathBuf>) -> Vec<Command> {
    let mut by_name: HashMap<String, Command> = HashMap::new();
    if let Some(global) = global {
        for cmd in scan_dir(&global) {
            by_name.insert(cmd.name.clone(), cmd);
        }
    }
    for cmd in scan_dir(&cwd.join(".nex").join("commands")) {
        by_name.insert(cmd.name.clone(), cmd);
    }
    let mut out: Vec<Command> = by_name.into_values().collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

/// Scans one directory for `<name>.md` command files; malformed files are
/// skipped so a single bad command never breaks the whole catalog.
fn scan_dir(root: &Path) -> Vec<Command> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(root) else {
        return out;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() || path.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }
        let Some(name) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        if name.is_empty() || name.contains('/') || name.contains('\\') {
            continue;
        }
        let Ok(content) = std::fs::read_to_string(&path) else {
            continue;
        };
        if let Some(cmd) = parse_command_md(name, &content) {
            out.push(cmd);
        }
    }
    out
}

/// Splits a command file into a [`Command`]. Frontmatter is the YAML block
/// between the leading `---` line and the next `---`; the body is everything
/// after. Returns `None` when the frontmatter is missing or unparseable.
pub fn parse_command_md(name: &str, content: &str) -> Option<Command> {
    let content = content.strip_prefix('\u{feff}').unwrap_or(content);
    let mut lines = content.lines();
    if lines.next()?.trim() != "---" {
        return None;
    }
    let mut frontmatter = String::new();
    let mut body_lines: Vec<&str> = Vec::new();
    let mut closed = false;
    for line in lines {
        if !closed {
            if line.trim() == "---" {
                closed = true;
            } else {
                frontmatter.push_str(line);
                frontmatter.push('\n');
            }
        } else {
            body_lines.push(line);
        }
    }
    if !closed {
        return None;
    }
    let meta: CommandFrontmatter = serde_yaml::from_str(&frontmatter).ok()?;
    Some(Command {
        name: name.to_string(),
        description: meta.description.unwrap_or_default().trim().to_string(),
        argument_hint: meta.argument_hint.map(|h| h.trim().to_string()),
        body: body_lines.join("\n"),
    })
}

/// Only the fields we care about; serde ignores the rest (Claude compat).
#[derive(serde::Deserialize)]
struct CommandFrontmatter {
    #[serde(default)]
    description: Option<String>,
    #[serde(rename = "argument-hint", default)]
    argument_hint: Option<String>,
}

/// Expands `text` when its first token is `/name` (a known command):
/// `$ARGUMENTS` in the body is replaced by the text after the name, or the
/// arguments are appended when the body has no placeholder. Returns `None`
/// when the text is not a known command invocation.
pub fn expand(text: &str, commands: &[Command]) -> Option<String> {
    let text = text.trim_start();
    let rest = text.strip_prefix('/')?;
    let (name, args) = match rest.split_once(char::is_whitespace) {
        Some((n, a)) => (n, a.trim()),
        None => (rest, ""),
    };
    let cmd = commands.iter().find(|c| c.name == name)?;
    let body = cmd.body.trim();
    let expanded = if body.contains("$ARGUMENTS") {
        body.replace("$ARGUMENTS", args)
    } else if args.is_empty() {
        body.to_string()
    } else {
        format!("{body}\n\n{args}")
    };
    Some(expanded)
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
    fn parse_frontmatter_basic() {
        let md = "---\ndescription: Review the codebase.\nargument-hint: scope\n---\nReview with $ARGUMENTS";
        let cmd = parse_command_md("review", md).unwrap();
        assert_eq!(cmd.name, "review");
        assert_eq!(cmd.description, "Review the codebase.");
        assert_eq!(cmd.argument_hint.as_deref(), Some("scope"));
        assert!(cmd.body.contains("$ARGUMENTS"));
    }

    #[test]
    fn parse_tolerates_unknown_fields_and_missing_frontmatter() {
        let md = "---\ndescription: d\nallowed-tools: [Bash]\n---\nbody";
        assert_eq!(parse_command_md("x", md).unwrap().description, "d");
        assert!(parse_command_md("x", "# no frontmatter").is_none());
        assert!(parse_command_md("x", "---\ndescription: d\nno close").is_none());
    }

    #[test]
    fn expand_substitutes_arguments() {
        let cmds = vec![Command {
            name: "review".into(),
            description: "d".into(),
            argument_hint: None,
            body: "Review $ARGUMENTS".into(),
        }];
        assert_eq!(expand("/review", &cmds).as_deref(), Some("Review "));
        assert_eq!(expand("/review src", &cmds).as_deref(), Some("Review src"));
        assert_eq!(
            expand("/review   src/ ", &cmds).as_deref(),
            Some("Review src/")
        );
        assert_eq!(expand("/nope hi", &cmds), None);
        assert_eq!(expand("not a command", &cmds), None);
    }

    #[test]
    fn expand_appends_arguments_without_placeholder() {
        let cmds = vec![Command {
            name: "fix".into(),
            description: "d".into(),
            argument_hint: None,
            body: "Fix the issue".into(),
        }];
        assert_eq!(expand("/fix", &cmds).as_deref(), Some("Fix the issue"));
        assert_eq!(
            expand("/fix foo", &cmds).as_deref(),
            Some("Fix the issue\n\nfoo")
        );
    }

    #[test]
    fn discover_project_overrides_global_and_sorts() {
        let tmp = tempfile::tempdir().unwrap();
        let cwd = tmp.path().join("proj");
        std::fs::create_dir_all(cwd.join(".nex/commands")).unwrap();
        write(
            tmp.path(),
            "commands/zeta.md",
            "---\ndescription: global zeta\n---\nGLOBAL",
        );
        write(
            tmp.path(),
            "commands/alpha.md",
            "---\ndescription: global alpha\n---\nGLOBAL",
        );
        write(tmp.path(), "cwd-ignored.md", "noop");
        write(
            &cwd.join(".nex/commands"),
            "alpha.md",
            "---\ndescription: project alpha\n---\nPROJECT",
        );
        write(
            &cwd.join(".nex/commands"),
            "beta.md",
            "---\ndescription: project beta\n---\nB",
        );

        let cmds = discover_in(&cwd, Some(tmp.path().join("commands")));
        let names: Vec<&str> = cmds.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, vec!["alpha", "beta", "zeta"]);
        // Same-name project entry wins.
        assert_eq!(cmds[0].description, "project alpha");
        assert!(cmds[0].body.contains("PROJECT"));
    }

    #[test]
    fn discover_with_skills_merges_skills_commands_win_and_disabled_skipped() {
        let tmp = tempfile::tempdir().unwrap();
        let cwd = tmp.path().join("proj");
        std::fs::create_dir_all(cwd.join(".nex/commands")).unwrap();
        write(
            tmp.path(),
            "commands/review.md",
            "---\ndescription: Review code.\n---\nReview $ARGUMENTS",
        );
        // A skill sharing the command name must NOT override the command.
        write(
            tmp.path(),
            "skills/review/SKILL.md",
            "---\nname: review\ndescription: skill review\n---\nSKILL BODY",
        );
        // Ordinary skills become slash commands.
        write(
            tmp.path(),
            "skills/tdd/SKILL.md",
            "---\nname: tdd\ndescription: TDD loop.\n---\nRED GREEN REFACTOR",
        );
        write(
            tmp.path(),
            "skills/off/SKILL.md",
            "---\nname: off\ndescription: disabled skill.\n---\nBODY",
        );

        let cmds = discover_with_skills_in(
            &cwd,
            Some(tmp.path().join("commands")),
            Some(tmp.path().join("skills")),
            &["off".to_string()],
        );
        let names: Vec<&str> = cmds.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, vec!["review", "tdd"]);
        // The command body wins over the same-named skill.
        assert!(cmds[0].body.contains("Review $"));
        // The skill command body carries the full skill instructions.
        let tdd = cmds.iter().find(|c| c.name == "tdd").unwrap();
        assert_eq!(tdd.description, "TDD loop.");
        assert!(tdd.body.contains("RED GREEN REFACTOR"));
    }

    #[test]
    fn discover_with_skills_project_skill_overrides_global_skill() {
        let tmp = tempfile::tempdir().unwrap();
        let cwd = tmp.path().join("proj");
        std::fs::create_dir_all(cwd.join(".nex/commands")).unwrap();
        write(
            tmp.path(),
            "skills/tdd/SKILL.md",
            "---\nname: tdd\ndescription: global tdd\n---\nGLOBAL TDD",
        );
        write(
            &cwd,
            ".nex/skills/tdd/SKILL.md",
            "---\nname: tdd\ndescription: project tdd\n---\nPROJECT TDD",
        );
        write(
            &cwd,
            ".nex/skills/local/SKILL.md",
            "---\nname: local\ndescription: project-only\n---\nLOCAL BODY",
        );

        let cmds = discover_with_skills_in(
            &cwd,
            Some(tmp.path().join("commands")),
            Some(tmp.path().join("skills")),
            &[],
        );
        let names: Vec<&str> = cmds.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, vec!["local", "tdd"]);
        let tdd = cmds.iter().find(|c| c.name == "tdd").unwrap();
        assert_eq!(tdd.description, "project tdd");
        assert!(tdd.body.contains("PROJECT TDD"));
        let local = cmds.iter().find(|c| c.name == "local").unwrap();
        assert!(local.body.contains("LOCAL BODY"));
    }
}
