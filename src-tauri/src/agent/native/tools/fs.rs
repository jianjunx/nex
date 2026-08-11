//! Filesystem tools: `read_file`, `write_file`, `edit_file`, `multi_edit`.
//!
//! All paths are resolved through [`super::resolve_within`] so they can never
//! escape the session cwd.

use super::{arg_str, arg_usize, resolve_within, Tool, ToolCtx, PARTIAL_MARKER};
use agent_client_protocol as acp;

/// Default page size for `read_file`.
const DEFAULT_LIMIT: usize = 2000;
/// Absolute cap so one read can't blow up the context.
const MAX_LIMIT: usize = 4000;

pub struct ReadFile;

#[async_trait::async_trait(?Send)]
impl Tool for ReadFile {
    fn name(&self) -> &'static str {
        "read_file"
    }
    fn description(&self) -> &'static str {
        "Read a text file from the workspace. Returns numbered lines \
         (`   12→content`). Use `offset`/`limit` to page through large files."
    }
    fn schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "path": { "type": "string", "description": "File path (absolute or workspace-relative)." },
                "offset": { "type": "integer", "description": "1-based line to start at. Default 1." },
                "limit": { "type": "integer", "description": "Max lines to return. Default 2000." }
            },
            "required": ["path"],
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
        let path = resolve_within(&ctx.cwd, &arg_str(&args, "path")?)?;
        let offset = arg_usize(&args, "offset", 1);
        let limit = arg_usize(&args, "limit", DEFAULT_LIMIT).min(MAX_LIMIT);

        let content = std::fs::read_to_string(&path)
            .map_err(|e| format!("failed to read `{}`: {e}", path.display()))?;
        let total = content.lines().count();
        let start = offset.max(1);
        let mut out = String::new();
        for (idx, line) in content.lines().enumerate().skip(start - 1).take(limit) {
            out.push_str(&format!("{:>6}→{}\n", idx + 1, line));
        }
                if out.is_empty() {
            return Ok(format!(
                "(file has {total} lines; offset {start} is past the end)"
            ));
        }
        if start + limit <= total {
            out.push_str(&format!(
                "{PARTIAL_MARKER} read_file slice: showing lines {start}–{} of {total}; pass a larger `offset` for more\n",
                start + limit - 1
            ));
        }
        Ok(out)
    }
}

pub struct WriteFile;

#[async_trait::async_trait(?Send)]
impl Tool for WriteFile {
    fn name(&self) -> &'static str {
        "write_file"
    }
    fn description(&self) -> &'static str {
        "Create or overwrite a file in the workspace with the given full content. \
         Parent directories are created automatically."
    }
    fn schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "path": { "type": "string", "description": "File path (absolute or workspace-relative)." },
                "content": { "type": "string", "description": "Full file content to write." }
            },
            "required": ["path", "content"],
            "additionalProperties": false
        })
    }
    fn kind(&self) -> acp::ToolKind {
        acp::ToolKind::Edit
    }
    async fn execute(&self, args: serde_json::Value, ctx: &ToolCtx) -> Result<String, String> {
        let path = resolve_within(&ctx.cwd, &arg_str(&args, "path")?)?;
        let content = arg_str(&args, "content")?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("failed to create `{}`: {e}", parent.display()))?;
        }
        std::fs::write(&path, &content)
            .map_err(|e| format!("failed to write `{}`: {e}", path.display()))?;
        Ok(format!(
            "wrote {} bytes to {}",
            content.len(),
            path.display()
        ))
    }
}

pub struct EditFile;

#[async_trait::async_trait(?Send)]
impl Tool for EditFile {
    fn name(&self) -> &'static str {
        "edit_file"
    }
    fn description(&self) -> &'static str {
        "Replace exactly one occurrence of `old_string` with `new_string` in a file. \
         Fails if `old_string` matches zero or multiple places."
    }
    fn schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "path": { "type": "string", "description": "File path (absolute or workspace-relative)." },
                "old_string": { "type": "string", "description": "Exact text to replace (must be unique in the file)." },
                "new_string": { "type": "string", "description": "Replacement text." }
            },
            "required": ["path", "old_string", "new_string"],
            "additionalProperties": false
        })
    }
    fn kind(&self) -> acp::ToolKind {
        acp::ToolKind::Edit
    }
    async fn execute(&self, args: serde_json::Value, ctx: &ToolCtx) -> Result<String, String> {
        let path = resolve_within(&ctx.cwd, &arg_str(&args, "path")?)?;
        let old = arg_str(&args, "old_string")?;
        let new = arg_str(&args, "new_string")?;
        if old.is_empty() {
            return Err("`old_string` must not be empty".into());
        }
        let content = std::fs::read_to_string(&path)
            .map_err(|e| format!("failed to read `{}`: {e}", path.display()))?;
        let updated = replace_unique(&content, &old, &new)?;
        std::fs::write(&path, &updated)
            .map_err(|e| format!("failed to write `{}`: {e}", path.display()))?;
        Ok(format!("edited {}", path.display()))
    }
}

pub struct MultiEditFile;

#[async_trait::async_trait(?Send)]
impl Tool for MultiEditFile {
    fn name(&self) -> &'static str {
        "multi_edit"
    }
    fn description(&self) -> &'static str {
        "Apply multiple `edit_file`-style replacements to one file atomically: \
         either every edit succeeds and the file is written once, or nothing changes."
    }
    fn schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "path": { "type": "string", "description": "File path (absolute or workspace-relative)." },
                "edits": {
                    "type": "array",
                    "description": "Ordered edits applied against the evolving file content.",
                    "items": {
                        "type": "object",
                        "properties": {
                            "old_string": { "type": "string" },
                            "new_string": { "type": "string" }
                        },
                        "required": ["old_string", "new_string"],
                        "additionalProperties": false
                    }
                }
            },
            "required": ["path", "edits"],
            "additionalProperties": false
        })
    }
    fn kind(&self) -> acp::ToolKind {
        acp::ToolKind::Edit
    }
    async fn execute(&self, args: serde_json::Value, ctx: &ToolCtx) -> Result<String, String> {
        let path = resolve_within(&ctx.cwd, &arg_str(&args, "path")?)?;
        let edits = args
            .get("edits")
            .and_then(|v| v.as_array())
            .ok_or("missing required argument `edits`")?;
        if edits.is_empty() {
            return Err("`edits` must not be empty".into());
        }
        let original = std::fs::read_to_string(&path)
            .map_err(|e| format!("failed to read `{}`: {e}", path.display()))?;

        // Validate + apply in memory first (atomicity: write only on full success).
        let mut working = original;
        for (i, edit) in edits.iter().enumerate() {
            let old = edit
                .get("old_string")
                .and_then(|v| v.as_str())
                .ok_or_else(|| format!("edits[{i}]: missing `old_string`"))?;
            let new = edit
                .get("new_string")
                .and_then(|v| v.as_str())
                .ok_or_else(|| format!("edits[{i}]: missing `new_string`"))?;
            if old.is_empty() {
                return Err(format!("edits[{i}]: `old_string` must not be empty"));
            }
            working = replace_unique(&working, old, new).map_err(|e| format!("edits[{i}]: {e}"))?;
        }
        std::fs::write(&path, &working)
            .map_err(|e| format!("failed to write `{}`: {e}", path.display()))?;
        Ok(format!(
            "applied {} edit(s) to {}",
            edits.len(),
            path.display()
        ))
    }
}

/// Replaces the single occurrence of `old`; errors on zero or multiple matches.
pub(crate) fn replace_unique(content: &str, old: &str, new: &str) -> Result<String, String> {
    let mut count = 0usize;
    let mut search_from = 0usize;
    while let Some(rel) = content[search_from..].find(old) {
        count += 1;
        search_from += rel + old.len();
        if count > 1 {
            return Err(format!(
                "`old_string` matches multiple places ({count}+ found)"
            ));
        }
    }
    if count == 0 {
        return Err("`old_string` not found in file".into());
    }
    Ok(content.replacen(old, new, 1))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn ctx(dir: &std::path::Path) -> ToolCtx {
        ToolCtx {
            cwd: dir.to_path_buf(),
            bash_timeout: Duration::from_secs(30),
            path_env: std::env::var_os("PATH").unwrap_or_default(),
            archive_dir: dir.join(".nex-archive"),
            jobs: std::rc::Rc::new(std::cell::RefCell::new(
                crate::agent::native::tools::jobs::JobTable::default(),
            )),
            harness: None,
            mutations: std::rc::Rc::new(std::cell::RefCell::new(Vec::new())),
            mode_id: None,
            memory: super::super::test_memory_handle(),
        }
    }

    async fn run(
        tool: &dyn Tool,
        args: serde_json::Value,
        dir: &std::path::Path,
    ) -> Result<String, String> {
        tool.execute(args, &ctx(dir)).await
    }

    #[tokio::test(flavor = "current_thread")]
    async fn read_file_numbers_and_pages() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("a.txt"), "one\ntwo\nthree\n").unwrap();
        let out = run(&ReadFile, serde_json::json!({"path": "a.txt"}), tmp.path())
            .await
            .unwrap();
        assert!(out.contains("1→one"));
        assert!(out.contains("3→three"));
        let out = run(
            &ReadFile,
            serde_json::json!({"path": "a.txt", "offset": 2, "limit": 1}),
            tmp.path(),
        )
        .await
        .unwrap();
        assert!(out.contains("2→two"));
        assert!(!out.contains("3→three"));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn write_and_edit_round_trip() {
        let tmp = tempfile::tempdir().unwrap();
        run(
            &WriteFile,
            serde_json::json!({"path": "sub/b.txt", "content": "hello world"}),
            tmp.path(),
        )
        .await
        .unwrap();
        run(
            &EditFile,
            serde_json::json!({"path": "sub/b.txt", "old_string": "world", "new_string": "nex"}),
            tmp.path(),
        )
        .await
        .unwrap();
        assert_eq!(
            std::fs::read_to_string(tmp.path().join("sub/b.txt")).unwrap(),
            "hello nex"
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn edit_requires_unique_match() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("c.txt"), "a a a").unwrap();
        let err = run(
            &EditFile,
            serde_json::json!({"path": "c.txt", "old_string": "a", "new_string": "b"}),
            tmp.path(),
        )
        .await
        .unwrap_err();
        assert!(err.contains("multiple"));
        let err = run(
            &EditFile,
            serde_json::json!({"path": "c.txt", "old_string": "z", "new_string": "b"}),
            tmp.path(),
        )
        .await
        .unwrap_err();
        assert!(err.contains("not found"));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn multi_edit_is_atomic() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("d.txt"), "fn a() {}\nfn b() {}").unwrap();
        run(
            &MultiEditFile,
            serde_json::json!({
                "path": "d.txt",
                "edits": [
                    {"old_string": "fn a", "new_string": "fn alpha"},
                    {"old_string": "fn b", "new_string": "fn beta"}
                ]
            }),
            tmp.path(),
        )
        .await
        .unwrap();
        assert_eq!(
            std::fs::read_to_string(tmp.path().join("d.txt")).unwrap(),
            "fn alpha() {}\nfn beta() {}"
        );
        // Second edit fails -> nothing is written.
        let err = run(
            &MultiEditFile,
            serde_json::json!({
                "path": "d.txt",
                "edits": [
                    {"old_string": "fn alpha", "new_string": "fn x"},
                    {"old_string": "nope", "new_string": "y"}
                ]
            }),
            tmp.path(),
        )
        .await
        .unwrap_err();
        assert!(err.contains("edits[1]"));
        assert_eq!(
            std::fs::read_to_string(tmp.path().join("d.txt")).unwrap(),
            "fn alpha() {}\nfn beta() {}"
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn write_cannot_escape_cwd() {
        let tmp = tempfile::tempdir().unwrap();
        let err = run(
            &WriteFile,
            serde_json::json!({"path": "../escape.txt", "content": "x"}),
            tmp.path(),
        )
        .await
        .unwrap_err();
        assert!(err.contains("escapes"));
    }
}
