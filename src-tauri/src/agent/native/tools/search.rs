//! Search tools: `grep`, `glob`, `ls`. Read-only; respect `.gitignore` via the
//! `ignore` crate.

use ignore::WalkBuilder;

use super::{arg_str, arg_str_opt, arg_usize, resolve_within, truncate_output, Tool, ToolCtx};
use agent_client_protocol as acp;

/// Cap on emitted matches/entries.
const MAX_RESULTS: usize = 200;
/// Cap on total output characters.
const MAX_OUTPUT_CHARS: usize = 20_000;

pub struct Grep;

#[async_trait::async_trait(?Send)]
impl Tool for Grep {
    fn name(&self) -> &'static str {
        "grep"
    }
    fn description(&self) -> &'static str {
        "Search file contents with a regex pattern across the workspace \
         (respects .gitignore). Returns `path:line:match` entries."
    }
    fn schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "pattern": { "type": "string", "description": "Regex pattern to search for." },
                "path": { "type": "string", "description": "Directory to search in. Defaults to the workspace root." },
                "max_results": { "type": "integer", "description": "Maximum matches to return. Default 50." }
            },
            "required": ["pattern"],
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
        let pattern = arg_str(&args, "pattern")?;
        let re = regex::Regex::new(&pattern).map_err(|e| format!("invalid regex: {e}"))?;
        let root = match arg_str_opt(&args, "path") {
            Some(p) => resolve_within(&ctx.cwd, &p)?,
            None => ctx.cwd.clone(),
        };
        let max = arg_usize(&args, "max_results", 50).min(MAX_RESULTS);

        let mut out = String::new();
        let mut found = 0usize;
        'outer: for entry in WalkBuilder::new(&root).build() {
            let Ok(entry) = entry else { continue };
            let Some(ft) = entry.file_type() else { continue };
            if !ft.is_file() {
                continue;
            }
            let path = entry.path();
            let Ok(content) = std::fs::read_to_string(path) else { continue }; // skip binary
            for (idx, line) in content.lines().enumerate() {
                if re.is_match(line) {
                    found += 1;
                    let rel = path.strip_prefix(&ctx.cwd).unwrap_or(path);
                    out.push_str(&format!("{}:{}:{}\n", rel.display(), idx + 1, line.trim()));
                    if found >= max {
                        out.push_str(&format!("… [stopped at {max} matches]\n"));
                        break 'outer;
                    }
                }
            }
        }
        if found == 0 {
            return Ok(format!("no matches for `{pattern}`"));
        }
        Ok(truncate_output(out, MAX_OUTPUT_CHARS))
    }
}

pub struct Glob;

#[async_trait::async_trait(?Send)]
impl Tool for Glob {
    fn name(&self) -> &'static str {
        "glob"
    }
    fn description(&self) -> &'static str {
        "List workspace files whose paths match a glob pattern (e.g. `src/**/*.rs`). \
         Returns workspace-relative paths."
    }
    fn schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "pattern": { "type": "string", "description": "Glob pattern, e.g. `**/*.ts`." },
                "path": { "type": "string", "description": "Directory to search in. Defaults to the workspace root." },
                "max_results": { "type": "integer", "description": "Maximum entries to return. Default 100." }
            },
            "required": ["pattern"],
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
        let pattern = arg_str(&args, "pattern")?;
        let root = match arg_str_opt(&args, "path") {
            Some(p) => resolve_within(&ctx.cwd, &p)?,
            None => ctx.cwd.clone(),
        };
        let max = arg_usize(&args, "max_results", 100).min(MAX_RESULTS);

        let matcher = globset::GlobBuilder::new(&pattern)
            .literal_separator(true)
            .build()
            .map_err(|e| format!("invalid glob: {e}"))?
            .compile_matcher();

        let mut out = String::new();
        let mut found = 0usize;
        for entry in WalkBuilder::new(&root).build() {
            let Ok(entry) = entry else { continue };
            let path = entry.path();
            let rel = path.strip_prefix(&ctx.cwd).unwrap_or(path);
            let rel_str = rel.to_string_lossy();
            let matched = matcher.is_match(rel_str.as_ref())
                || matcher.is_match(path.strip_prefix(&root).unwrap_or(path));
            if !matched {
                continue;
            }
            found += 1;
            let suffix = if path.is_dir() { "/" } else { "" };
            out.push_str(&format!("{}{}\n", rel.display(), suffix));
            if found >= max {
                out.push_str(&format!("… [stopped at {max} entries]\n"));
                break;
            }
        }
        if found == 0 {
            return Ok(format!("no files match `{pattern}`"));
        }
        Ok(truncate_output(out, MAX_OUTPUT_CHARS))
    }
}

pub struct Ls;

#[async_trait::async_trait(?Send)]
impl Tool for Ls {
    fn name(&self) -> &'static str {
        "ls"
    }
    fn description(&self) -> &'static str {
        "List the entries of a directory (directories suffixed with `/`)."
    }
    fn schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "path": { "type": "string", "description": "Directory to list. Defaults to the workspace root." }
            },
            "additionalProperties": false
        })
    }
    fn kind(&self) -> acp::ToolKind {
        acp::ToolKind::Read
    }
    fn read_only(&self) -> bool {
        true
    }
    async fn execute(&self, args: serde_json::Value, ctx: &ToolCtx) -> Result<String, String> {
        let dir = match arg_str_opt(&args, "path") {
            Some(p) => resolve_within(&ctx.cwd, &p)?,
            None => ctx.cwd.clone(),
        };
        let entries = std::fs::read_dir(&dir)
            .map_err(|e| format!("failed to list `{}`: {e}", dir.display()))?;
        let mut names: Vec<String> = Vec::new();
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') {
                continue; // skip hidden entries
            }
            let suffix = if entry.path().is_dir() { "/" } else { "" };
            names.push(format!("{name}{suffix}"));
        }
        names.sort();
        names.truncate(MAX_RESULTS);
        if names.is_empty() {
            return Ok(format!("(empty directory: {})", dir.display()));
        }
        Ok(truncate_output(names.join("\n"), MAX_OUTPUT_CHARS))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn ctx(dir: &std::path::Path) -> ToolCtx {
        ToolCtx {
            cwd: dir.to_path_buf(),
            bash_timeout: Duration::from_secs(30),
            archive_dir: dir.join(".nex-archive"),
            jobs: std::rc::Rc::new(std::cell::RefCell::new(
                crate::agent::native::tools::jobs::JobTable::default(),
            )),
            harness: None,
            mutations: std::rc::Rc::new(std::cell::RefCell::new(Vec::new())),
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn grep_finds_matches() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("a.rs"), "fn main() {}\nfn helper() {}").unwrap();
        let out = Grep
            .execute(serde_json::json!({"pattern": "fn \\w+"}), &ctx(tmp.path()))
            .await
            .unwrap();
        assert!(out.contains("a.rs:1:fn main"));
        assert!(out.contains("a.rs:2:fn helper"));
        let none = Grep
            .execute(serde_json::json!({"pattern": "zzz"}), &ctx(tmp.path()))
            .await
            .unwrap();
        assert!(none.contains("no matches"));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn glob_matches_patterns() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join("src")).unwrap();
        std::fs::write(tmp.path().join("src/main.rs"), "x").unwrap();
        std::fs::write(tmp.path().join("README.md"), "x").unwrap();
        let out = Glob
            .execute(serde_json::json!({"pattern": "**/*.rs"}), &ctx(tmp.path()))
            .await
            .unwrap();
        assert!(out.contains("src/main.rs"));
        assert!(!out.contains("README.md"));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn ls_lists_sorted() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir(tmp.path().join("dir_b")).unwrap();
        std::fs::write(tmp.path().join("file_a.txt"), "x").unwrap();
        std::fs::write(tmp.path().join(".hidden"), "x").unwrap();
        let out = Ls.execute(serde_json::json!({}), &ctx(tmp.path())).await.unwrap();
        assert_eq!(out, "dir_b/\nfile_a.txt");
    }
}
