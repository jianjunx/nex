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
pub mod spreadsheet;
pub mod subagent;
pub mod todo;

use std::cell::RefCell;
use std::ffi::OsString;
use std::path::{Component, Path, PathBuf};
use std::rc::Rc;
use std::time::Duration;

use agent_client_protocol as acp;

use super::memory::WorkingMemory;
use super::provider::{FunctionSpec, ToolSpec};

/// Per-turn environment handed to every tool execution.
pub struct ToolCtx {
    /// Canonicalized session working directory (the sandbox root).
    pub cwd: PathBuf,
    /// Synchronous `bash` tool timeout.
    pub bash_timeout: Duration,
    /// Project/login-shell PATH used for shell-based tools.
    pub path_env: OsString,
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
    /// Session working memory; tools call `record_*` here when they touch
    /// tracked state (file write, tool error, etc.). The harness renders it
    /// back into the transcript just before each provider request.
    pub memory: Rc<RefCell<WorkingMemory>>,
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

/// Build a no-op working-memory handle for tests and other contexts where
/// memory is not exercised (subagents, MCP proxies, mock tool contexts).
pub fn test_memory_handle() -> Rc<RefCell<WorkingMemory>> {
    Rc::new(RefCell::new(WorkingMemory::new()))
}

/// Ensure the working-memory block is present after the system prompt and
/// matches `memory`. Updates in-place when the marker is already there
/// (byte-stable when unchanged). Re-inserts after compact/summary if the
/// block was lost — older archived transcripts never had one.
pub fn ensure_working_memory(
    messages: &mut Vec<super::provider::ChatMessage>,
    memory: &WorkingMemory,
) -> bool {
    let next = super::memory::render(memory);
    for msg in messages.iter_mut() {
        if msg.role != "assistant" {
            continue;
        }
        let current = msg
            .content
            .as_ref()
            .and_then(super::provider::Content::as_text)
            .unwrap_or("");
        if !current.starts_with(super::memory::MARKER) {
            continue;
        }
        if current == next {
            return false;
        }
        msg.content = Some(super::provider::Content::Text(next));
        return true;
    }
    let insert_at = if messages.first().is_some_and(|m| m.role == "system") {
        1
    } else {
        0
    };
    messages.insert(
        insert_at.min(messages.len()),
        super::provider::ChatMessage::assistant(next),
    );
    true
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
                Box::new(spreadsheet::ReadSpreadsheet),
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

// ----- Output tiering ---------------------------------------------------
//
// Shared building blocks for keeping long tool results out of the live
// transcript. Each tool picks its own character budget, but the truncation
// marker is byte-stable across tools so it is friendly to the provider's
// prefix cache and friendly to BM25-style retrievers that scan the transcript
// looking for partial content.

/// Stable marker that the model can grep for when it wants to know whether
/// a transcript result is partial. The literal `partial-output` is shared
/// with archive-side search tools.
pub const PARTIAL_MARKER: &str = "[nex:partial-output]";

/// Per-tool inline cap: anything bigger than this is considered "long" and
/// should be replaced with a summary + `preview_partial` instead of being
/// embedded verbatim. Kept as a constant so the threshold is shared and
/// greppable in tests.
pub const INLINE_CAP_CHARS: usize = 4_000;

/// Build a stable, byte-stable "this output was truncated" notice for a
/// tool result, leaving the first `head_chars` of the original in place so
/// the model still has a hook to anchor on.
pub fn preview_partial(
    tool: &'static str,
    original_chars: usize,
    head_chars: usize,
    recovery_hint: &str,
) -> String {
    debug_assert!(head_chars <= original_chars);
    format!(
        "{PARTIAL_MARKER} {tool} output truncated: showing first {head_chars} of {original_chars} chars. \
{recovery_hint}\n--- preview head ---\n",
    )
}

/// Builds a platform-appropriate shell runner with the script passed as a
/// single argument, so callers share one shape: `shell_command().arg(script)`.
/// Windows uses `cmd.exe /S /C` (present on every Windows install); Unix uses
/// `/bin/sh -c`. `CREATE_NO_WINDOW` is applied on Windows so GUI-spawned
/// shells never flash a console.
///
/// Windows quoting note: `Command::arg` escapes `"` as `\"` (CRT argv
/// rules), but `cmd.exe` does not understand that escaping and passes the
/// quotes through literally — a quoted argument like `"needle here"` arrives
/// split. Callers must therefore use `raw_arg` on Windows so the script
/// reaches cmd verbatim and cmd's own quote parsing applies.
pub fn shell_command() -> tokio::process::Command {
    #[cfg(windows)]
    let mut cmd = {
        let mut c = tokio::process::Command::new("cmd.exe");
        // /S: strip surrounding quotes per cmd's rules when the script is
        // passed as a raw (unescaped) argument.
        c.arg("/S").arg("/C");
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

/// Attach `script` to a [`shell_command`] result, preserving quotes on every
/// platform: `raw_arg` on Windows (cmd parses quotes itself), `arg` elsewhere.
pub fn shell_command_script(mut cmd: tokio::process::Command, script: &str) -> tokio::process::Command {
    #[cfg(windows)]
    {
        cmd.raw_arg(script);
    }
    #[cfg(not(windows))]
    {
        cmd.arg(script);
    }
    cmd
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::native::memory;
    use crate::agent::native::provider::{ChatMessage, Content};

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
        assert!(names.contains(&"read_spreadsheet".to_string()));
        assert!(names.contains(&"checkpoint".to_string()));
        assert!(names.contains(&"load_skill".to_string()));
        assert!(names.contains(&"switch_mode".to_string()));
        assert!(names.contains(&"task".to_string()));
        assert_eq!(names.len(), 22);

        // Subagents see everything except orchestration + mode tools.
        let sub: Vec<_> = ToolRegistry::subagents()
            .specs()
            .iter()
            .map(|s| s.function.name.clone())
            .collect();
        assert_eq!(sub.len(), 18);
        assert!(sub.contains(&"load_skill".to_string()));
        assert!(!sub.contains(&"task".to_string()));
        assert!(!sub.contains(&"fleet".to_string()));
        assert!(!sub.contains(&"read_subagent_result".to_string()));
        assert!(!sub.contains(&"switch_mode".to_string()));
    }

    #[test]
    fn test_memory_handle_builds_empty_memory() {
        let mem = test_memory_handle();
        assert_eq!(mem.borrow().goal.len(), 0);
    }

    #[test]
    fn refresh_working_memory_in_place_returns_false_when_unchanged() {
        let mem = test_memory_handle();
        mem.borrow_mut().set_goal("ship v1");
        let rendered = memory::render(&mem.borrow());
        let mut msgs = vec![ChatMessage::assistant(rendered.clone())];
        assert!(!ensure_working_memory(&mut msgs, &mem.borrow()));
        assert_eq!(
            msgs[0].content.as_ref().and_then(Content::as_text),
            Some(rendered.as_str())
        );
    }

    #[test]
    fn ensure_working_memory_reinserts_after_system_prompt() {
        let mem = test_memory_handle();
        mem.borrow_mut().set_goal("ship v1");
        let mut msgs = vec![
            ChatMessage::system("sys"),
            ChatMessage::user("hello"),
        ];
        assert!(ensure_working_memory(&mut msgs, &mem.borrow()));
        assert_eq!(msgs[0].role, "system");
        assert!(msgs[1]
            .content
            .as_ref()
            .and_then(Content::as_text)
            .unwrap()
            .starts_with(memory::MARKER));
        assert_eq!(msgs[2].role, "user");
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
            hash, "4a643180e7cf7e1da8a2b098227b27f86bec713f98f1a6594ea6801be450e1f3",
            "tool schema drift detected; update the snapshot intentionally"
        );
    }

    fn hex(digest: impl AsRef<[u8]>) -> String {
        digest.as_ref().iter().map(|b| format!("{b:02x}")).collect()
    }

    /// Windows: a quoted argument must arrive intact at the child process.
    /// Regression — `Command::arg` escapes `"` inside the script, which
    /// `cmd.exe` does not understand (it passes the quotes through as literal
    /// chars), so `findstr /C:"needle here"` was split into two arguments.
    #[cfg(windows)]
    #[tokio::test(flavor = "current_thread")]
    async fn windows_quoted_args_reach_child_intact() {
        let tmp = tempfile::tempdir().unwrap();
        let f = tmp.path().join("probe.txt");
        std::fs::write(&f, "needle here\n").unwrap();
        // The pattern contains a space and is quoted: `findstr` must receive
        // it as ONE argument (`/C:"needle here"`).
        let script = format!("findstr /C:\"needle here\" \"{}\"", f.display());
        let mut cmd = shell_command_script(shell_command(), &script);
        let out = cmd.output().await.unwrap();
        assert!(
            out.status.success(),
            "quoted arg must reach findstr intact: {script}\nstdout: {}\nstderr: {}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        );
        assert!(
            String::from_utf8_lossy(&out.stdout).contains("needle here"),
            "findstr must match the multi-word pattern"
        );
    }
}
