//! Subagent orchestration tools: `task` runs one isolated subagent turn,
//! `fleet` runs several subagent tasks concurrently. Writable children use
//! detached worktrees and return explicit patch refs; `read_subagent_result`
//! pages through spilled answers and patches.
//!
//! Subagents share the parent connection (notifications/permissions reuse the
//! same popup flow) but get a fresh transcript, tool registry without the
//! orchestration tools, and `harness: None` so they cannot recurse.

use std::io::Write;
#[cfg(test)]
use std::rc::Rc;

use super::{arg_str, arg_usize, truncate_output, Tool, ToolCtx};
use crate::agent::native::session::{
    run_isolated_subagent, run_read_only_subagent, run_subagent, SubagentHarness,
};
use agent_client_protocol as acp;

/// Max characters per `read_subagent_result` page.
const PAGE_CHARS: usize = 16_000;
/// Cap on a subagent result file. Larger spills are rejected outright so a
/// single giant output can never be slurped into memory by one tool call.
const MAX_RESULT_FILE_BYTES: u64 = 32 * 1024 * 1024;

pub struct Task;

#[async_trait::async_trait(?Send)]
impl Tool for Task {
    fn name(&self) -> &'static str {
        "task"
    }
    fn description(&self) -> &'static str {
        "Delegate a self-contained task to an isolated subagent. Read-only tasks use an \
         isolated memory snapshot; writable tasks use a detached Git worktree and return \
         a reviewable patch ref. Only its final answer is returned. Very large answers are \
         stored on disk and returned as a ref readable via read_subagent_result."
    }
    fn schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "prompt": { "type": "string", "description": "Complete, self-contained task description for the subagent." },
                "read_only": { "type": "boolean", "default": false, "description": "Run in Ask mode with all mutating tools and commands blocked." }
                ,"role": { "type": "string", "description": "Optional specialist role/instructions prepended to the child task." }
            },
            "required": ["prompt"],
            "additionalProperties": false
        })
    }
    fn kind(&self) -> acp::ToolKind {
        acp::ToolKind::Think
    }
    async fn execute(&self, args: serde_json::Value, ctx: &ToolCtx) -> Result<String, String> {
        let prompt = with_role(
            arg_str(&args, "prompt")?,
            args.get("role").and_then(|v| v.as_str()),
        );
        let harness = ctx
            .harness
            .as_ref()
            .ok_or("subagents are disabled in this context")?
            .clone();
        if args
            .get("read_only")
            .and_then(|value| value.as_bool())
            .unwrap_or(false)
        {
            run_read_only_subagent(&harness, &prompt).await
        } else {
            run_writable_worktree_subagent(&harness, &prompt).await
        }
    }
}

pub struct Fleet;

#[async_trait::async_trait(?Send)]
impl Tool for Fleet {
    fn name(&self) -> &'static str {
        "fleet"
    }
    fn description(&self) -> &'static str {
        "Run several independent subagent tasks. With read_only=true they run \
         concurrently up to the configured limit. Read-only children have isolated memory \
         and mutations blocked; writable children run in separate Git worktrees and return \
         reviewable patch refs. Results always come back in input order."
    }
    fn schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "tasks": {
                    "type": "array",
                    "items": { "type": "string" },
                    "description": "Task descriptions, one per subagent."
                },
                "read_only": { "type": "boolean", "default": false, "description": "Enable safe concurrent research with all mutations blocked." }
                ,"role": { "type": "string", "description": "Optional specialist role/instructions prepended to every child task." }
            },
            "required": ["tasks"],
            "additionalProperties": false
        })
    }
    fn kind(&self) -> acp::ToolKind {
        acp::ToolKind::Think
    }
    async fn execute(&self, args: serde_json::Value, ctx: &ToolCtx) -> Result<String, String> {
        let harness = ctx
            .harness
            .as_ref()
            .ok_or("subagents are disabled in this context")?
            .clone();
        let role = args.get("role").and_then(|value| value.as_str());
        let tasks: Vec<String> = args
            .get("tasks")
            .and_then(|v| v.as_array())
            .ok_or("missing required argument `tasks` (array of strings)")?
            .iter()
            .filter_map(|v| v.as_str().map(|s| with_role(s.to_string(), role)))
            .collect();
        if tasks.is_empty() {
            return Err("`tasks` must contain at least one task".to_string());
        }
        if tasks.len() > 16 {
            return Err("at most 16 tasks per fleet".to_string());
        }

        let read_only = args
            .get("read_only")
            .and_then(|value| value.as_bool())
            .unwrap_or(false);
        let mut outcomes = Vec::with_capacity(tasks.len());
        if read_only {
            // Futures are joined on the native agent's LocalSet; no Send bound
            // is required. Batching enforces the configured concurrency while
            // preserving deterministic output order.
            let concurrency = harness.concurrency.clamp(1, tasks.len());
            for batch in tasks.chunks(concurrency) {
                outcomes.extend(
                    futures::future::join_all(
                        batch
                            .iter()
                            .map(|task| run_read_only_subagent(&harness, task)),
                    )
                    .await,
                );
            }
        } else if git2::Repository::discover(&harness.cwd).is_ok() {
            let concurrency = harness.concurrency.clamp(1, tasks.len());
            for batch in tasks.chunks(concurrency) {
                outcomes.extend(
                    futures::future::join_all(
                        batch
                            .iter()
                            .map(|task| run_writable_worktree_subagent(&harness, task)),
                    )
                    .await,
                );
            }
        } else {
            // Non-Git folders cannot provide independent worktrees. Preserve
            // functionality and safety by running writable children serially.
            for task in &tasks {
                outcomes.push(run_subagent(&harness, task).await);
            }
        }

        let mut out = String::new();
        for (i, (task, res)) in tasks.iter().zip(outcomes).enumerate() {
            out.push_str(&format!("--- subagent {} ---\ntask: {}\n", i + 1, task));
            match res {
                Ok(answer) => out.push_str(&answer),
                Err(e) => out.push_str(&format!("ERROR: {e}")),
            }
            out.push_str("\n\n");
        }
        Ok(truncate_output(out, 40_000))
    }
}

fn with_role(prompt: String, role: Option<&str>) -> String {
    match role.map(str::trim).filter(|role| !role.is_empty()) {
        Some(role) => format!("Specialist role:\n{role}\n\nTask:\n{prompt}"),
        None => prompt,
    }
}

/// Snapshot the live checkout without touching its index, run a child in a
/// detached worktree, then export the child's complete change set as a binary
/// patch. Applying that patch is a separate permission-gated tool call.
async fn run_writable_worktree_subagent(
    harness: &SubagentHarness,
    task: &str,
) -> Result<String, String> {
    if git2::Repository::discover(&harness.cwd).is_err() {
        return run_subagent(harness, task).await;
    }
    let prepared = WorktreeRun::prepare(harness)?;
    let child_cwd = prepared.child_cwd.clone();
    let answer = run_isolated_subagent(harness, task, child_cwd).await;
    let patch = prepared.export_patch();
    let cleanup = prepared.cleanup();
    if let Err(error) = cleanup {
        log::warn!("subagent worktree cleanup failed: {error}");
    }
    let answer = answer?;
    match patch? {
        Some(reference) => Ok(format!(
            "{answer}\n\nWorkspace changes are isolated. Patch ref: `{reference}`. Review with `read_subagent_result`, then apply with `apply_subagent_patch`."
        )),
        None => Ok(format!("{answer}\n\nWorkspace changes: none.")),
    }
}

struct WorktreeRun {
    repo_root: std::path::PathBuf,
    worktree_root: std::path::PathBuf,
    child_cwd: std::path::PathBuf,
    archive_dir: std::path::PathBuf,
    base: String,
    path_env: std::ffi::OsString,
}

impl WorktreeRun {
    fn prepare(harness: &SubagentHarness) -> Result<Self, String> {
        let repo = git2::Repository::discover(&harness.cwd)
            .map_err(|_| "writable parallel agents require a Git workspace".to_string())?;
        let repo_root = repo
            .workdir()
            .ok_or("writable parallel agents require a non-bare Git workspace")?
            .canonicalize()
            .map_err(|e| format!("resolve repository root: {e}"))?;
        let relative_cwd = harness
            .cwd
            .strip_prefix(&repo_root)
            .map_err(|_| "session cwd is outside the discovered repository")?
            .to_path_buf();

        // Build a dangling snapshot commit from an in-memory index. The user's
        // real index is never written or changed.
        let mut index = repo.index().map_err(|e| format!("read Git index: {e}"))?;
        index
            .add_all(["*"].iter(), git2::IndexAddOption::DEFAULT, None)
            .map_err(|e| format!("snapshot workspace: {e}"))?;
        index
            .update_all(["*"].iter(), None)
            .map_err(|e| format!("snapshot deletions: {e}"))?;
        for prefix in [".nex", ".nex-archive"] {
            let path = std::path::Path::new(prefix);
            index.remove_path(path).ok();
            index.remove_dir(path, 0).ok();
        }
        let tree_id = index
            .write_tree_to(&repo)
            .map_err(|e| format!("write snapshot tree: {e}"))?;
        let tree = repo
            .find_tree(tree_id)
            .map_err(|e| format!("snapshot tree: {e}"))?;
        let signature = repo
            .signature()
            .or_else(|_| git2::Signature::now("Nex Agent", "nex-agent@localhost"))
            .map_err(|e| format!("snapshot signature: {e}"))?;
        let parent = repo.head().ok().and_then(|head| head.peel_to_commit().ok());
        let parents: Vec<&git2::Commit> = parent.iter().collect();
        let base = repo
            .commit(
                None,
                &signature,
                &signature,
                "nex isolated subagent snapshot",
                &tree,
                &parents,
            )
            .map_err(|e| format!("create snapshot commit: {e}"))?
            .to_string();

        let id = uuid::Uuid::new_v4().simple().to_string();
        let worktree_root = harness.archive_dir.join("worktrees").join(&id);
        std::fs::create_dir_all(worktree_root.parent().unwrap_or(&harness.archive_dir))
            .map_err(|e| format!("create worktree parent: {e}"))?;
        let output = git_command(&repo_root, &harness.path_env)
            .args(["worktree", "add", "--detach"])
            .arg(&worktree_root)
            .arg(&base)
            .output()
            .map_err(|e| format!("start git worktree: {e}"))?;
        if !output.status.success() {
            return Err(format!(
                "create isolated worktree: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }
        let child_cwd = worktree_root.join(relative_cwd);
        Ok(Self {
            repo_root,
            worktree_root,
            child_cwd,
            archive_dir: harness.archive_dir.clone(),
            base,
            path_env: harness.path_env.clone(),
        })
    }

    fn export_patch(&self) -> Result<Option<String>, String> {
        let add = git_command(&self.worktree_root, &self.path_env)
            .args(["add", "-A"])
            .output()
            .map_err(|e| format!("stage isolated changes: {e}"))?;
        if !add.status.success() {
            return Err(format!(
                "stage isolated changes: {}",
                String::from_utf8_lossy(&add.stderr).trim()
            ));
        }
        let diff = git_command(&self.worktree_root, &self.path_env)
            .args(["diff", "--cached", "--binary", "--full-index", &self.base])
            .output()
            .map_err(|e| format!("export isolated changes: {e}"))?;
        if !diff.status.success() {
            return Err(format!(
                "export isolated changes: {}",
                String::from_utf8_lossy(&diff.stderr).trim()
            ));
        }
        if diff.stdout.is_empty() {
            return Ok(None);
        }
        std::fs::create_dir_all(&self.archive_dir)
            .map_err(|e| format!("create result archive: {e}"))?;
        let name = format!("subagent-patch-{}.patch", uuid::Uuid::new_v4().simple());
        write_private(&self.archive_dir.join(&name), &diff.stdout)
            .map_err(|e| format!("store isolated patch: {e}"))?;
        Ok(Some(name))
    }

    fn cleanup(&self) -> Result<(), String> {
        let output = git_command(&self.repo_root, &self.path_env)
            .args(["worktree", "remove", "--force"])
            .arg(&self.worktree_root)
            .output()
            .map_err(|e| format!("remove isolated worktree: {e}"))?;
        if output.status.success() {
            Ok(())
        } else {
            Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
        }
    }
}

fn write_private(path: &std::path::Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut options = std::fs::OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(bytes)?;
    file.sync_all()
}

fn git_command(cwd: &std::path::Path, path_env: &std::ffi::OsStr) -> std::process::Command {
    let mut command = std::process::Command::new("git");
    command.current_dir(cwd).env("PATH", path_env);
    command
}

pub struct ApplySubagentPatch;

#[async_trait::async_trait(?Send)]
impl Tool for ApplySubagentPatch {
    fn name(&self) -> &'static str {
        "apply_subagent_patch"
    }
    fn description(&self) -> &'static str {
        "Apply a reviewed binary patch returned by a writable task/fleet child to the current workspace. Conflicts fail without partial application."
    }
    fn schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type":"object",
            "properties":{"ref":{"type":"string","description":"subagent-patch-<id>.patch ref"}},
            "required":["ref"],
            "additionalProperties":false
        })
    }
    fn kind(&self) -> acp::ToolKind {
        acp::ToolKind::Edit
    }
    async fn execute(&self, args: serde_json::Value, ctx: &ToolCtx) -> Result<String, String> {
        let name = arg_str(&args, "ref")?;
        if !name.starts_with("subagent-patch-")
            || !name.ends_with(".patch")
            || name.contains('/')
            || name.contains("..")
        {
            return Err("invalid subagent patch ref".to_string());
        }
        let patch = ctx.archive_dir.join(&name);
        let check = git_command(&ctx.cwd, &ctx.path_env)
            .args(["apply", "--check"])
            .arg(&patch)
            .output()
            .map_err(|e| format!("check patch: {e}"))?;
        if !check.status.success() {
            return Err(format!(
                "patch does not apply cleanly: {}",
                String::from_utf8_lossy(&check.stderr).trim()
            ));
        }
        let apply = git_command(&ctx.cwd, &ctx.path_env)
            .args(["apply"])
            .arg(&patch)
            .output()
            .map_err(|e| format!("apply patch: {e}"))?;
        if !apply.status.success() {
            return Err(format!(
                "apply patch failed: {}",
                String::from_utf8_lossy(&apply.stderr).trim()
            ));
        }
        ctx.mutations
            .borrow_mut()
            .push(format!("apply_subagent_patch({name}) -> ok"));
        Ok(format!("applied isolated subagent patch `{name}`"))
    }
}

pub struct ReadSubagentResult;

#[async_trait::async_trait(?Send)]
impl Tool for ReadSubagentResult {
    fn name(&self) -> &'static str {
        "read_subagent_result"
    }
    fn description(&self) -> &'static str {
        "Page through a stored subagent result (ref returned by task/fleet). \
         Pass the byte `offset` from the previous page to continue reading."
    }
    fn schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "ref": { "type": "string", "description": "Result ref, e.g. `subagent-<id>.txt`." },
                "offset": { "type": "integer", "description": "Byte offset to start reading from. Default 0." }
            },
            "required": ["ref"],
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
        let name = arg_str(&args, "ref")?;
        if name.contains('/') || name.contains("..") {
            return Err("invalid ref".to_string());
        }
        let offset = arg_usize(&args, "offset", 0);
        let path = ctx.archive_dir.join(&name);
        let mut f = std::fs::File::open(&path).map_err(|_| format!("ref `{name}` not found"))?;
        let meta = f
            .metadata()
            .map_err(|_| format!("ref `{name}` not found"))?;
        if meta.len() > MAX_RESULT_FILE_BYTES {
            return Err(format!(
                "ref `{name}` exceeds the {} MiB result limit",
                MAX_RESULT_FILE_BYTES / (1024 * 1024)
            ));
        }
        // Read a bounded byte page instead of slurping the whole file. Refs are
        // normally UTF-8 text or Git's ASCII binary-patch encoding; lossy
        // decoding keeps diagnostics usable for a malformed result without
        // making the continuation cursor ambiguous.
        use std::io::{Read, Seek, SeekFrom};
        let start = offset.min(meta.len() as usize);
        f.seek(SeekFrom::Start(start as u64))
            .map_err(|e| format!("seek failed: {e}"))?;
        let remaining = (meta.len() as usize).saturating_sub(start);
        let page_bytes = remaining.min(PAGE_CHARS);
        let mut bytes = vec![0u8; page_bytes];
        f.read_exact(&mut bytes)
            .map_err(|e| format!("read failed: {e}"))?;
        let page = String::from_utf8_lossy(&bytes);
        let next_offset = start + page_bytes;
        let more = next_offset < meta.len() as usize;
        Ok(format!(
            "ref `{name}`; next offset: {next_offset}; more: {more}\n{page}"
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::native::session::SubagentHarness;
    use crate::agent::native::tools::jobs::JobTable;
    use std::cell::RefCell;

    fn ctx_without_harness(dir: &std::path::Path) -> ToolCtx {
        ToolCtx {
            cwd: dir.to_path_buf(),
            bash_timeout: std::time::Duration::from_secs(10),
            shell_sandbox: crate::agent::native::config::ShellSandboxMode::ApprovalOnly,
            path_env: std::env::var_os("PATH").unwrap_or_default(),
            archive_dir: dir.join(".nex-archive"),
            jobs: Rc::new(RefCell::new(JobTable::default())),
            harness: None,
            mutations: Rc::new(RefCell::new(Vec::new())),
            mode_id: None,
            memory: super::super::test_memory_handle(),
            graph: None,
            conn: None,
            session_id: None,
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn task_refused_without_harness() {
        let tmp = tempfile::tempdir().unwrap();
        let ctx = ctx_without_harness(tmp.path());
        let err = Task
            .execute(serde_json::json!({"prompt": "do things"}), &ctx)
            .await
            .unwrap_err();
        assert!(err.contains("disabled"));
        let err2 = Fleet
            .execute(serde_json::json!({"tasks": ["a"]}), &ctx)
            .await
            .unwrap_err();
        assert!(err2.contains("disabled"));
    }

    #[test]
    fn task_and_fleet_expose_read_only_isolation() {
        assert_eq!(Task.schema()["properties"]["read_only"]["default"], false);
        assert_eq!(Fleet.schema()["properties"]["read_only"]["default"], false);
        assert!(Fleet.description().contains("concurrently"));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn read_subagent_result_rejects_oversized_file() {
        let tmp = tempfile::tempdir().unwrap();
        let archive = tmp.path().join(".nex-archive");
        std::fs::create_dir_all(&archive).unwrap();
        // A sparse file larger than the cap — no real disk usage.
        let big = archive.join("subagent-huge.txt");
        let f = std::fs::File::create(&big).unwrap();
        f.set_len(MAX_RESULT_FILE_BYTES + 1).unwrap();
        drop(f);

        let mut ctx = ctx_without_harness(tmp.path());
        ctx.archive_dir = archive;
        let err = ReadSubagentResult
            .execute(serde_json::json!({"ref": "subagent-huge.txt"}), &ctx)
            .await
            .unwrap_err();
        assert!(err.contains("result limit"), "got: {err}");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn read_subagent_result_pages_by_offset() {
        let tmp = tempfile::tempdir().unwrap();
        let archive = tmp.path().join(".nex-archive");
        std::fs::create_dir_all(&archive).unwrap();
        // 40k chars -> needs more than two pages of 16k.
        let big = "a".repeat(40_000);
        std::fs::write(archive.join("subagent-x.txt"), &big).unwrap();

        let mut ctx = ctx_without_harness(tmp.path());
        ctx.archive_dir = archive;

        let p1 = ReadSubagentResult
            .execute(serde_json::json!({"ref": "subagent-x.txt"}), &ctx)
            .await
            .unwrap();
        assert!(p1.contains("more: true"));
        let next: usize = p1
            .split("next offset: ")
            .nth(1)
            .and_then(|s| s.split(';').next())
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        assert_eq!(next, 16_000);

        let p3 = ReadSubagentResult
            .execute(
                serde_json::json!({"ref": "subagent-x.txt", "offset": 32_000}),
                &ctx,
            )
            .await
            .unwrap();
        assert!(p3.contains("more: false"));

        let missing = ReadSubagentResult
            .execute(serde_json::json!({"ref": "nope.txt"}), &ctx)
            .await
            .unwrap_err();
        assert!(missing.contains("not found"));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn fleet_rejects_bad_input() {
        let local = tokio::task::LocalSet::new();
        local
            .run_until(async {
                let tmp = tempfile::tempdir().unwrap();
                use crate::agent::native::tools::ToolRegistry;
                let registry = Rc::new(ToolRegistry::subagents());
                let harness = SubagentHarness {
                    conn: unreachable_conn(),
                    parent_session_id: acp::SessionId(std::sync::Arc::from("s")),
                    provider: unreachable_provider(),
                    registry: registry.clone(),
                    tool_specs: registry.specs(),
                    model: "m".into(),
                    reasoning: crate::agent::native::provider::ReasoningControl::Off,
                    max_sub_steps: 5,
                    concurrency: 2,
                    cwd: tmp.path().to_path_buf(),
                    bash_timeout: std::time::Duration::from_secs(5),
                    shell_sandbox: crate::agent::native::config::ShellSandboxMode::ApprovalOnly,
                    path_env: std::env::var_os("PATH").unwrap_or_default(),
                    archive_dir: tmp.path().join(".nex-archive"),
                    context_window: 0,
                    cancelled: Rc::new(std::cell::Cell::new(false)),
                    mode_id: Rc::new(std::cell::RefCell::new("code".to_string())),
                    mutations: Rc::new(RefCell::new(Vec::new())),
                    memory: super::super::test_memory_handle(),
                    graph: None,
                };
                let mut ctx = ctx_without_harness(tmp.path());
                ctx.harness = Some(Rc::new(harness));
                let err = Fleet
                    .execute(serde_json::json!({"tasks": []}), &ctx)
                    .await
                    .unwrap_err();
                assert!(err.contains("at least one"));
                let err = Fleet
                    .execute(serde_json::json!({"nope": 1}), &ctx)
                    .await
                    .unwrap_err();
                assert!(err.contains("tasks"));
            })
            .await;
    }

    /// A connection handle that is never actually used in these tests
    /// (validation fails first). Built over a dead duplex.
    fn unreachable_conn() -> std::sync::Arc<acp::AgentSideConnection> {
        use tokio_util::compat::{TokioAsyncReadCompatExt, TokioAsyncWriteCompatExt};

        struct NullAgent;
        #[async_trait::async_trait(?Send)]
        impl acp::Agent for NullAgent {
            async fn initialize(
                &self,
                _a: acp::InitializeRequest,
            ) -> acp::Result<acp::InitializeResponse> {
                Err(acp::Error::method_not_found())
            }
            async fn authenticate(
                &self,
                _a: acp::AuthenticateRequest,
            ) -> acp::Result<acp::AuthenticateResponse> {
                Err(acp::Error::method_not_found())
            }
            async fn new_session(
                &self,
                _a: acp::NewSessionRequest,
            ) -> acp::Result<acp::NewSessionResponse> {
                Err(acp::Error::method_not_found())
            }
            async fn prompt(&self, _a: acp::PromptRequest) -> acp::Result<acp::PromptResponse> {
                Err(acp::Error::method_not_found())
            }
            async fn cancel(&self, _a: acp::CancelNotification) -> acp::Result<()> {
                Ok(())
            }
        }

        let (_client_end, agent_end) = tokio::io::duplex(1024);
        let (r, w) = tokio::io::split(agent_end);
        let (conn, _io) =
            acp::AgentSideConnection::new(NullAgent, w.compat_write(), r.compat(), |fut| {
                tokio::task::spawn_local(fut);
            });
        std::sync::Arc::new(conn)
    }

    fn unreachable_provider() -> std::sync::Arc<dyn crate::agent::native::provider::Provider> {
        struct Never;
        #[async_trait::async_trait]
        impl crate::agent::native::provider::Provider for Never {
            fn name(&self) -> &str {
                "never"
            }
            async fn stream(
                &self,
                _req: crate::agent::native::provider::ChatRequest,
            ) -> Result<crate::agent::native::provider::ChunkStream, crate::error::NexError>
            {
                Err(crate::error::NexError::Internal("unused".into()))
            }
        }
        std::sync::Arc::new(Never)
    }
}
