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
pub mod mode;
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
    /// Entries look like `write_file(…) -> ok`. Auto-`/review` only cares about
    /// [`is_workspace_edit_tool`] names in this log.
    pub mutations: Rc<RefCell<Vec<String>>>,
    /// Live session mode (`code`/`ask`/`plan`/`auto`); shared with [`super::session::TurnEnv`].
    /// `None` inside contexts that must not change the parent mode (rare test stubs).
    pub mode_id: Option<Rc<RefCell<String>>>,
}

/// Tools that rewrite workspace files. Auto-`/review` triggers only when at
/// least one of these succeeded in the turn (bash-only / todo / etc. do not).
pub fn is_workspace_edit_tool(name: &str) -> bool {
    matches!(name, "write_file" | "edit_file" | "multi_edit")
}

/// True when the mutation log contains a successful workspace file edit.
pub fn mutations_include_workspace_edit(log: &[String]) -> bool {
    log.iter().any(|entry| {
        let name = entry.split('(').next().unwrap_or("");
        is_workspace_edit_tool(name)
    })
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
                Box::new(mode::SwitchMode),
                Box::new(subagent::Task),
                Box::new(subagent::Fleet),
                Box::new(subagent::ReadSubagentResult),
            ],
        }
    }

    /// The subagent tool set: the builtins minus orchestration + mode tools so
    /// subagents cannot spawn further subagents or change the parent mode.
    pub fn subagents() -> Self {
        Self {
            tools: Self::builtins()
                .tools
                .into_iter()
                .filter(|t| {
                    !matches!(
                        t.name(),
                        "task" | "fleet" | "read_subagent_result" | "switch_mode"
                    )
                })
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
/// `cwd`. Lexical normalization first (so not-yet-existing write targets also
/// validate), then a symlink-aware check on the longest existing prefix so a
/// `link -> /elsewhere` inside the workspace cannot smuggle reads/writes out.
pub fn resolve_within(cwd: &Path, raw: &str) -> Result<PathBuf, String> {
    if raw.is_empty() {
        return Err("path is required".to_string());
    }
    // The workspace root must be canonical; sessions canonicalize at entry,
    // this is a defensive check for callers that don't (e.g. unit tests).
    let cwd_canon = cwd
        .canonicalize()
        .map_err(|e| format!("cannot resolve workspace root `{}`: {e}", cwd.display()))?;

    let p = Path::new(raw);
    let joined = if p.is_absolute() {
        p.to_path_buf()
    } else {
        cwd_canon.join(p)
    };
    let norm = normalize_lexical(&joined);
    if norm != cwd_canon && !norm.starts_with(&cwd_canon) {
        return Err(format!("path `{raw}` escapes the workspace root"));
    }

    // Symlink-aware check: canonicalize the longest existing prefix of the
    // target and verify it still lives under the canonical cwd. Components
    // that don't exist yet (a file being written, new subdirectories) are
    // appended verbatim — they cannot be symlinks, so the prefix check is
    // sufficient.
    let mut existing = norm.as_path();
    let mut suffix = PathBuf::new();
    while !existing.exists() {
        let Some(parent) = existing.parent() else {
            break;
        };
        let Some(name) = existing.file_name() else {
            break;
        };
        // Note: `PathBuf::from(name).join(&suffix)` appends a trailing
        // separator when suffix is empty, so build it component-wise.
        suffix = if suffix.as_os_str().is_empty() {
            PathBuf::from(name)
        } else {
            PathBuf::from(name).join(suffix)
        };
        existing = parent;
    }
    let canon = existing
        .canonicalize()
        .map_err(|e| format!("cannot resolve `{}`: {e}", existing.display()))?;
    if canon != cwd_canon && !canon.starts_with(&cwd_canon) {
        return Err(format!("path `{raw}` escapes the workspace root (via symlink)"));
    }
    if suffix.as_os_str().is_empty() {
        // Path already exists: join("") would append a trailing separator.
        Ok(canon)
    } else {
        Ok(canon.join(suffix))
    }
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
    args.get(key)
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
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

/// Builds a platform-appropriate shell runner with the script passed as a
/// single argument, so callers share one shape: `shell_command().arg(script)`.
/// Windows uses `cmd.exe /C` (present on every Windows install); Unix uses
/// `/bin/sh -c`. `CREATE_NO_WINDOW` is applied on Windows so GUI-spawned
/// shells never flash a console.
pub fn shell_command() -> tokio::process::Command {
    #[cfg(windows)]
    let mut cmd = {
        let mut c = tokio::process::Command::new("cmd.exe");
        c.arg("/C");
        c
    };
    #[cfg(not(windows))]
    let mut cmd = {
        let mut c = tokio::process::Command::new("/bin/sh");
        c.arg("-c");
        c
    };
    crate::win_process::no_window_tokio(&mut cmd);
    cmd
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn workspace_edit_gate_ignores_bash_only_mutations() {
        assert!(is_workspace_edit_tool("write_file"));
        assert!(is_workspace_edit_tool("edit_file"));
        assert!(is_workspace_edit_tool("multi_edit"));
        assert!(!is_workspace_edit_tool("bash"));
        assert!(!mutations_include_workspace_edit(&[
            "bash(ls) -> ok".into(),
            "run_in_background(npm test) -> ok".into(),
        ]));
        assert!(mutations_include_workspace_edit(&[
            "bash(ls) -> ok".into(),
            "edit_file(src/a.rs) -> ok".into(),
        ]));
    }

    #[test]
    fn resolve_keeps_inner_paths() {
        let tmp = tempfile::tempdir().unwrap();
        let cwd = tmp.path().canonicalize().unwrap();
        std::fs::create_dir_all(cwd.join("a")).unwrap();
        std::fs::create_dir_all(cwd.join("b")).unwrap();
        assert_eq!(
            resolve_within(&cwd, "a/b.txt").unwrap(),
            cwd.join("a/b.txt")
        );
        assert_eq!(
            resolve_within(&cwd, cwd.join("x").to_str().unwrap()).unwrap(),
            cwd.join("x")
        );
        assert_eq!(
            resolve_within(&cwd, "a/../b").unwrap(),
            cwd.join("b")
        );
    }

    #[test]
    fn resolve_rejects_escapes() {
        let tmp = tempfile::tempdir().unwrap();
        let cwd = tmp.path().canonicalize().unwrap();
        assert!(resolve_within(&cwd, "../other").is_err());
        assert!(resolve_within(&cwd, "/etc/passwd").is_err());
        assert!(resolve_within(&cwd, "a/../../x").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn resolve_rejects_symlink_escape() {
        use std::os::unix::fs::symlink;
        let tmp = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let cwd = tmp.path().canonicalize().unwrap();
        // `evil` -> outside dir; lexical resolution would happily walk into it.
        symlink(outside.path(), cwd.join("evil")).unwrap();
        // Reading through the symlink must fail for an existing file.
        std::fs::write(outside.path().join("creds.json"), "secret").unwrap();
        let abs = cwd.join("evil/creds.json");
        // Sanity: the lexical path resolves and exists once the symlink is followed.
        assert!(abs.exists());
        assert!(
            resolve_within(&cwd, "evil/creds.json").is_err(),
            "symlinked path escaped the workspace root"
        );
    }

    #[cfg(unix)]
    #[test]
    fn resolve_allows_inner_symlink_into_workspace() {
        use std::os::unix::fs::symlink;
        let tmp = tempfile::tempdir().unwrap();
        let cwd = tmp.path().canonicalize().unwrap();
        std::fs::create_dir_all(cwd.join("real")).unwrap();
        symlink(cwd.join("real"), cwd.join("alias")).unwrap();
        // A symlink pointing back INTO the workspace is fine.
        assert_eq!(
            resolve_within(&cwd, "alias/f.txt").unwrap(),
            cwd.join("real/f.txt")
        );
    }

    #[test]
    fn resolve_allows_new_file_in_existing_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let cwd = tmp.path().canonicalize().unwrap();
        std::fs::create_dir_all(cwd.join("src")).unwrap();
        // Write target does not exist yet — must still resolve.
        let p = resolve_within(&cwd, "src/new.rs").unwrap();
        assert_eq!(p, cwd.join("src/new.rs"));
    }

    #[test]
    fn registry_specs_are_ordered() {
        let reg = ToolRegistry::builtins();
        let names: Vec<_> = reg
            .specs()
            .iter()
            .map(|s| s.function.name.clone())
            .collect();
        assert_eq!(names[0], "read_file");
        assert!(names.contains(&"bash".to_string()));
        assert!(names.contains(&"history".to_string()));
        assert!(names.contains(&"run_in_background".to_string()));
        assert!(names.contains(&"checkpoint".to_string()));
        assert!(names.contains(&"load_skill".to_string()));
        assert!(names.contains(&"switch_mode".to_string()));
        assert!(names.contains(&"task".to_string()));
        assert_eq!(names.len(), 21);

        // Subagents see everything except orchestration + mode tools.
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
        assert!(!sub.contains(&"switch_mode".to_string()));
    }

    /// Canonical tool schemas must serialize to identical bytes on every run
    /// (prefix-cache friendliness). The sha256 snapshot below pins the exact
    /// shape; bump it deliberately when a schema genuinely changes.
    #[test]
    fn canonical_schema_snapshot_is_stable() {
        use sha2::{Digest, Sha256};
        let bytes = serde_json::to_vec(&ToolRegistry::builtins().specs()).unwrap();
        // Byte-stable across constructions within a run…
        assert_eq!(
            bytes,
            serde_json::to_vec(&ToolRegistry::builtins().specs()).unwrap()
        );
        let hash = hex(Sha256::digest(&bytes));
        eprintln!("canonical schema sha256: {hash}");
        assert_eq!(
            hash, "0a8d1604c2a158944d8f79abf860a0f578897b00cd386c2158e162676812ee82",
            "tool schema drift detected; update the snapshot intentionally"
        );
    }

    fn hex(digest: impl AsRef<[u8]>) -> String {
        digest.as_ref().iter().map(|b| format!("{b:02x}")).collect()
    }
}
