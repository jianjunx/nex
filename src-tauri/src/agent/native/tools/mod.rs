//! Built-in tools for the native agent.
//!
//! Each tool implements [`Tool`]; [`ToolRegistry::builtins`] assembles the
//! canonical set handed to the model (schemas) and the harness (execution).
//! File/bash tools are sandboxed to the session cwd by [`resolve_within`].

pub mod bash;
pub mod checkpoint;
pub mod fs;
pub mod history;
pub mod jobs;
pub mod mcp;
pub mod search;
pub mod skill;
pub mod subagent;
pub mod todo;

use std::cell::RefCell;
use std::path::{Component, Path, PathBuf};
use std::rc::Rc;
use std::time::Duration;

use agent_client_protocol as acp;

use super::provider::{FunctionSpec, ToolSpec};

/// Per-turn environment handed to every tool execution.
pub struct ToolCtx {
    /// Canonicalized session working directory (the sandbox root).
    pub cwd: PathBuf,
    /// Synchronous `bash` tool timeout.
    pub bash_timeout: Duration,
    /// Where compacted transcript chunks are archived (`history` searches it)
    /// and where oversized subagent results are spilled.
    pub archive_dir: PathBuf,
    /// Per-session background shell jobs (`run_in_background` & friends).
    pub jobs: Rc<RefCell<jobs::JobTable>>,
    /// Subagent orchestration support; `None` inside subagents themselves
    /// (recursion guard) and in read-only test setups.
    pub harness: Option<Rc<super::session::SubagentHarness>>,
    /// Append-only log of mutating tool executions (for observability).
    pub mutations: Rc<RefCell<Vec<String>>>,
}

/// A builtin tool.
#[async_trait::async_trait(?Send)]
pub trait Tool {
    fn name(&self) -> &str;
    fn description(&self) -> &str;
    /// JSON Schema of the tool's arguments (canonical, byte-stable ordering).
    fn schema(&self) -> serde_json::Value;
    /// ACP tool kind (drives client iconography).
    fn kind(&self) -> acp::ToolKind;
    /// Read-only tools skip the permission prompt.
    fn read_only(&self) -> bool {
        false
    }
    /// Execute; `Ok(text)` becomes the tool result, `Err(text)` a tool error.
    async fn execute(&self, args: serde_json::Value, ctx: &ToolCtx) -> Result<String, String>;
}

/// The canonical builtin tool set.
pub struct ToolRegistry {
    tools: Vec<Box<dyn Tool>>,
}

impl ToolRegistry {
    pub fn builtins() -> Self {
        Self {
            tools: vec![
                Box::new(fs::ReadFile),
                Box::new(fs::WriteFile),
                Box::new(fs::EditFile),
                Box::new(fs::MultiEditFile),
                Box::new(search::Grep),
                Box::new(search::Glob),
                Box::new(search::Ls),
                Box::new(bash::Bash),
                Box::new(todo::TodoWrite),
                Box::new(history::History),
                Box::new(jobs::RunInBackground),
                Box::new(jobs::BashOutput),
                Box::new(jobs::KillShell),
                Box::new(jobs::WaitJob),
                Box::new(checkpoint::Checkpoint),
                Box::new(checkpoint::Rewind),
                Box::new(skill::LoadSkill),
                Box::new(subagent::Task),
                Box::new(subagent::Fleet),
                Box::new(subagent::ReadSubagentResult),
            ],
        }
    }

    /// The subagent tool set: the builtins minus the orchestration tools so
    /// subagents cannot spawn further subagents.
    pub fn subagents() -> Self {
        Self {
            tools: Self::builtins()
                .tools
                .into_iter()
                .filter(|t| !matches!(t.name(), "task" | "fleet" | "read_subagent_result"))
                .collect(),
        }
    }

    /// Appends a session-level tool (e.g. an MCP proxy). Not part of the
    /// canonical builtin set, so the schema snapshot is unaffected.
    pub fn add(&mut self, tool: Box<dyn Tool>) {
        self.tools.push(tool);
    }

    pub fn get(&self, name: &str) -> Option<&dyn Tool> {
        self.tools.iter().find(|t| t.name() == name).map(|t| &**t)
    }

    /// OpenAI `tools` array; serialization order is fixed by `builtins()`.
    pub fn specs(&self) -> Vec<ToolSpec> {
        self.tools
            .iter()
            .map(|t| ToolSpec {
                typ: "function".to_string(),
                function: FunctionSpec {
                    name: t.name().to_string(),
                    description: t.description().to_string(),
                    parameters: t.schema(),
                },
            })
            .collect()
    }
}

/// Resolves `raw` (absolute or cwd-relative) and guarantees it stays inside
/// `cwd`. Lexical normalization (no symlink resolution) so not-yet-existing
/// write targets also validate.
pub fn resolve_within(cwd: &Path, raw: &str) -> Result<PathBuf, String> {
    if raw.is_empty() {
        return Err("path is required".to_string());
    }
    let p = Path::new(raw);
    let joined = if p.is_absolute() { p.to_path_buf() } else { cwd.join(p) };
    let norm = normalize_lexical(&joined);
    if norm != cwd && !norm.starts_with(cwd) {
        return Err(format!("path `{raw}` escapes the workspace root"));
    }
    Ok(norm)
}

fn normalize_lexical(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for comp in path.components() {
        match comp {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            c => out.push(c.as_os_str()),
        }
    }
    out
}

/// Helper to pull a required string arg.
pub fn arg_str(args: &serde_json::Value, key: &str) -> Result<String, String> {
    args.get(key)
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| format!("missing required argument `{key}`"))
}

/// Helper to pull an optional string arg.
pub fn arg_str_opt(args: &serde_json::Value, key: &str) -> Option<String> {
    args.get(key).and_then(|v| v.as_str()).map(|s| s.to_string())
}

/// Helper to pull an optional positive usize with a default.
pub fn arg_usize(args: &serde_json::Value, key: &str, default: usize) -> usize {
    args.get(key)
        .and_then(|v| v.as_u64())
        .map(|v| v as usize)
        .filter(|v| *v > 0)
        .unwrap_or(default)
}

/// Cap huge outputs so a single tool result can't blow up the context.
pub fn truncate_output(s: String, max_chars: usize) -> String {
    if s.chars().count() <= max_chars {
        return s;
    }
    let cut: String = s.chars().take(max_chars).collect();
    format!("{cut}\n… [output truncated at {max_chars} chars]")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_keeps_inner_paths() {
        let cwd = Path::new("/tmp/proj");
        assert_eq!(resolve_within(cwd, "a/b.txt").unwrap(), Path::new("/tmp/proj/a/b.txt"));
        assert_eq!(resolve_within(cwd, "/tmp/proj/x").unwrap(), Path::new("/tmp/proj/x"));
        assert_eq!(resolve_within(cwd, "a/../b").unwrap(), Path::new("/tmp/proj/b"));
    }

    #[test]
    fn resolve_rejects_escapes() {
        let cwd = Path::new("/tmp/proj");
        assert!(resolve_within(cwd, "../other").is_err());
        assert!(resolve_within(cwd, "/etc/passwd").is_err());
        assert!(resolve_within(cwd, "a/../../x").is_err());
    }

    #[test]
    fn registry_specs_are_ordered() {
        let reg = ToolRegistry::builtins();
        let names: Vec<_> = reg.specs().iter().map(|s| s.function.name.clone()).collect();
        assert_eq!(names[0], "read_file");
        assert!(names.contains(&"bash".to_string()));
        assert!(names.contains(&"history".to_string()));
        assert!(names.contains(&"run_in_background".to_string()));
        assert!(names.contains(&"checkpoint".to_string()));
        assert!(names.contains(&"load_skill".to_string()));
        assert!(names.contains(&"task".to_string()));
        assert_eq!(names.len(), 20);

        // Subagents see everything except the orchestration tools.
        let sub: Vec<_> = ToolRegistry::subagents()
            .specs()
            .iter()
            .map(|s| s.function.name.clone())
            .collect();
        assert_eq!(sub.len(), 17);
        assert!(sub.contains(&"load_skill".to_string()));
        assert!(!sub.contains(&"task".to_string()));
        assert!(!sub.contains(&"fleet".to_string()));
        assert!(!sub.contains(&"read_subagent_result".to_string()));
    }

    /// Canonical tool schemas must serialize to identical bytes on every run
    /// (prefix-cache friendliness). The sha256 snapshot below pins the exact
    /// shape; bump it deliberately when a schema genuinely changes.
    #[test]
    fn canonical_schema_snapshot_is_stable() {
        use sha2::{Digest, Sha256};
        let bytes = serde_json::to_vec(&ToolRegistry::builtins().specs()).unwrap();
        // Byte-stable across constructions within a run…
        assert_eq!(bytes, serde_json::to_vec(&ToolRegistry::builtins().specs()).unwrap());
        let hash = hex(Sha256::digest(&bytes));
        eprintln!("canonical schema sha256: {hash}");
        assert_eq!(
            hash,
            "b3d4046c150f65482c5c0910daada3db578050a99efed89eacf0f139f941a9e3",
            "tool schema drift detected; update the snapshot intentionally"
        );
    }

    fn hex(digest: impl AsRef<[u8]>) -> String {
        digest.as_ref().iter().map(|b| format!("{b:02x}")).collect()
    }
}
