//! Claude-compatible Agent Skills.
//!
//! A skill is a folder under `~/.nex/skills/<name>/` containing a `SKILL.md`
//! with YAML frontmatter (`name`, `description`) and a markdown body. Extra
//! files (scripts, templates, references) live alongside and are pulled in on
//! demand.
//!
//! Progressive disclosure (same as Claude Code): only `name` + `description`
//! are surfaced in the system-prompt catalog; the model calls the `load_skill`
//! tool to pull the full body, or a specific supporting file, when a task
//! matches. The on-disk layout matches Claude's, so existing skills work as-is.

use std::path::{Path, PathBuf};

/// Parsed skill metadata plus where it lives on disk.
#[derive(Debug, Clone)]
pub struct Skill {
    pub name: String,
    pub description: String,
    /// Directory containing `SKILL.md` (and any supporting files).
    pub dir: PathBuf,
}

/// Scans `root` for `<name>/SKILL.md` skill folders and returns their metadata,
/// sorted by name for a byte-stable catalog. Malformed skills are skipped so a
/// single bad skill never breaks the whole catalog.
pub fn discover(root: &Path) -> Vec<Skill> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(root) else {
        return out;
    };
    for entry in entries.flatten() {
        let dir = entry.path();
        if !dir.is_dir() {
            continue;
        }
        let Ok(content) = std::fs::read_to_string(dir.join("SKILL.md")) else {
            continue;
        };
        let Some((_name, description, _body)) = parse_skill_md(&content) else {
            continue;
        };
        // The folder name is the canonical lookup key: `load_skill` resolves
        // `root.join(name)`, so the catalog must advertise folder names even
        // when the frontmatter `name` differs (common in third-party skills).
        let name = dir
            .file_name()
            .map(|f| f.to_string_lossy().to_string())
            .unwrap_or_default();
        if name.is_empty() {
            continue;
        }
        out.push(Skill {
            name,
            description: description.trim().to_string(),
            dir,
        });
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

/// Splits a `SKILL.md` into `(name, description, body)`.
///
/// Frontmatter is the YAML block between the leading `---` line and the next
/// `---` line; the body is everything after. Returns `None` when there is no
/// parseable frontmatter block. Unknown frontmatter fields (e.g. `allowed-tools`)
/// are tolerated for Claude compatibility.
pub fn parse_skill_md(content: &str) -> Option<(String, String, String)> {
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
    let meta: Frontmatter = serde_yaml::from_str(&frontmatter).ok()?;
    Some((
        meta.name.unwrap_or_default(),
        meta.description.unwrap_or_default(),
        body_lines.join("\n"),
    ))
}

/// Only the fields we care about; serde ignores the rest (Claude compat).
#[derive(serde::Deserialize)]
struct Frontmatter {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    description: Option<String>,
}

/// Resolves a skill's directory under `root`, rejecting names that could escape
/// it. Returns a clear error when the skill does not exist.
fn skill_dir(root: &Path, name: &str) -> Result<PathBuf, String> {
    if name.is_empty()
        || name == "."
        || name == ".."
        || name.contains('/')
        || name.contains('\\')
    {
        return Err(format!("invalid skill name `{name}`"));
    }
    let dir = root.join(name);
    if !dir.is_dir() {
        return Err(format!("skill `{name}` not found"));
    }
    Ok(dir)
}

/// Reads the full `SKILL.md` body for skill `name` under `root`.
pub fn load_body(root: &Path, name: &str) -> Result<String, String> {
    let dir = skill_dir(root, name)?;
    let content = std::fs::read_to_string(dir.join("SKILL.md"))
        .map_err(|e| format!("failed to read SKILL.md: {e}"))?;
    let Some((_, _, body)) = parse_skill_md(&content) else {
        return Err("SKILL.md has no valid frontmatter".to_string());
    };
    Ok(body)
}

/// Reads a supporting file `rel` (relative to the skill dir), guarded against
/// path traversal so a skill cannot reach outside its own folder.
pub fn load_file(root: &Path, name: &str, rel: &str) -> Result<String, String> {
    let dir = skill_dir(root, name)?;
    let rel_path = Path::new(rel);
    if rel_path.is_absolute() {
        return Err("path must be relative to the skill directory".to_string());
    }
    for comp in rel_path.components() {
        if matches!(comp, std::path::Component::ParentDir) {
            return Err("path must not contain `..`".to_string());
        }
    }
    std::fs::read_to_string(dir.join(rel_path))
        .map_err(|e| format!("failed to read `{rel}`: {e}"))
}

/// Renders the skills catalog block injected into the system prompt. Returns an
/// empty string when there are no skills.
pub fn catalog_block(skills: &[Skill]) -> String {
    if skills.is_empty() {
        return String::new();
    }
    let mut s = String::from("# Available skills\n");
    s.push_str(
        "When a task matches a skill below, load its full instructions with the \
         `load_skill` tool (skill = the name) and follow them.\n",
    );
    for sk in skills {
        if sk.description.is_empty() {
            s.push_str(&format!("- {}\n", sk.name));
        } else {
            s.push_str(&format!("- {}: {}\n", sk.name, sk.description));
        }
    }
    s
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
        let md = "---\nname: pdf\ndescription: Extract text from PDFs.\n---\n# Steps\n1. run it\n";
        let (name, desc, body) = parse_skill_md(md).unwrap();
        assert_eq!(name, "pdf");
        assert_eq!(desc, "Extract text from PDFs.");
        assert!(body.contains("# Steps"));
    }

    #[test]
    fn parse_tolerates_unknown_fields_and_multiline() {
        let md = "---\nname: x\ndescription: >\n  a long\n  description\nallowed-tools: [Bash]\n---\nbody\n";
        let (name, desc, body) = parse_skill_md(md).unwrap();
        assert_eq!(name, "x");
        assert!(desc.contains("a long"));
        assert_eq!(body.trim(), "body");
    }

    #[test]
    fn parse_rejects_missing_frontmatter() {
        assert!(parse_skill_md("# just markdown, no frontmatter").is_none());
        assert!(parse_skill_md("---\nname: x\nno closing").is_none());
    }

    #[test]
    fn discover_sorts_and_skips_malformed() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        write(root, "zeta/SKILL.md", "---\nname: zeta\ndescription: z\n---\nbody");
        write(root, "alpha/SKILL.md", "---\nname: alpha\ndescription: a\n---\nbody");
        // Malformed: no frontmatter -> skipped.
        write(root, "broken/SKILL.md", "no frontmatter here");
        // Folder without SKILL.md -> skipped.
        std::fs::create_dir_all(root.join("empty")).unwrap();

        let skills = discover(root);
        let names: Vec<&str> = skills.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, vec!["alpha", "zeta"]);
    }

    #[test]
    fn discover_uses_folder_name_even_when_frontmatter_differs() {
        // Regression: the catalog must advertise the folder name (the
        // `load_skill` lookup key), not the frontmatter name.
        let tmp = tempfile::tempdir().unwrap();
        write(
            tmp.path(),
            "pdf-tools/SKILL.md",
            "---\nname: pdf\ndescription: d\n---\nBODY",
        );
        let skills = discover(tmp.path());
        assert_eq!(skills.len(), 1);
        assert_eq!(skills[0].name, "pdf-tools");
        // The advertised name must actually load.
        assert_eq!(load_body(tmp.path(), "pdf-tools").unwrap(), "BODY");
    }

    #[test]
    fn discover_falls_back_to_folder_name() {
        let tmp = tempfile::tempdir().unwrap();
        write(
            tmp.path(),
            "my-skill/SKILL.md",
            "---\ndescription: d\n---\nbody",
        );
        let skills = discover(tmp.path());
        assert_eq!(skills.len(), 1);
        assert_eq!(skills[0].name, "my-skill");
    }

    #[test]
    fn load_body_and_file() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        write(root, "demo/SKILL.md", "---\nname: demo\ndescription: d\n---\nBODY");
        write(root, "demo/assets/tpl.txt", "template-content");

        assert_eq!(load_body(root, "demo").unwrap(), "BODY");
        assert_eq!(
            load_file(root, "demo", "assets/tpl.txt").unwrap(),
            "template-content"
        );
    }

    #[test]
    fn load_file_blocks_traversal_and_bad_names() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        write(root, "demo/SKILL.md", "---\nname: demo\n---\nB");
        write(root, "secret.txt", "top-secret");

        assert!(load_file(root, "demo", "../secret.txt").is_err());
        assert!(load_file(root, "demo", "/etc/passwd").is_err());
        assert!(load_body(root, "../demo").is_err());
        assert!(load_body(root, "nope").is_err());
    }

    #[test]
    fn catalog_block_lists_names_and_descriptions() {
        let skills = vec![
            Skill {
                name: "a".into(),
                description: "does a".into(),
                dir: PathBuf::new(),
            },
            Skill {
                name: "b".into(),
                description: String::new(),
                dir: PathBuf::new(),
            },
        ];
        let block = catalog_block(&skills);
        assert!(block.contains("a: does a"));
        assert!(block.contains("- b"));
        assert!(catalog_block(&[]).is_empty());
    }
}
