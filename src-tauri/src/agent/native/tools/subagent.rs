//! Subagent orchestration tools: `task` runs one isolated subagent turn,
//! `fleet` fans out several in parallel (bounded by `max_subagent_concurrency`),
//! and `read_subagent_result` pages through results that were spilled to disk.
//!
//! Subagents share the parent connection (notifications/permissions reuse the
//! same popup flow) but get a fresh transcript, tool registry without the
//! orchestration tools, and `harness: None` so they cannot recurse.

use std::rc::Rc;

use super::{arg_str, arg_usize, truncate_output, Tool, ToolCtx};
use crate::agent::native::session::run_subagent;
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
        "Delegate a self-contained task to an isolated subagent (own context, same \
         workspace tools). Only its final answer is returned. Good for parallelizable \
         research or bounded subtasks. Very large answers are stored on disk and \
         returned as a ref readable via read_subagent_result."
    }
    fn schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "prompt": { "type": "string", "description": "Complete, self-contained task description for the subagent." }
            },
            "required": ["prompt"],
            "additionalProperties": false
        })
    }
    fn kind(&self) -> acp::ToolKind {
        acp::ToolKind::Think
    }
    async fn execute(&self, args: serde_json::Value, ctx: &ToolCtx) -> Result<String, String> {
        let prompt = arg_str(&args, "prompt")?;
        let harness = ctx
            .harness
            .as_ref()
            .ok_or("subagents are disabled in this context")?
            .clone();
        run_subagent(&harness, &prompt).await
    }
}

pub struct Fleet;

#[async_trait::async_trait(?Send)]
impl Tool for Fleet {
    fn name(&self) -> &'static str {
        "fleet"
    }
    fn description(&self) -> &'static str {
        "Run several independent subagent tasks in parallel (concurrency-limited). \
         Each entry is a self-contained task description; results come back in order."
    }
    fn schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "tasks": {
                    "type": "array",
                    "items": { "type": "string" },
                    "description": "Task descriptions, one per subagent."
                }
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
        let tasks: Vec<String> = args
            .get("tasks")
            .and_then(|v| v.as_array())
            .ok_or("missing required argument `tasks` (array of strings)")?
            .iter()
            .filter_map(|v| v.as_str().map(|s| s.to_string()))
            .collect();
        if tasks.is_empty() {
            return Err("`tasks` must contain at least one task".to_string());
        }
        if tasks.len() > 16 {
            return Err("at most 16 tasks per fleet".to_string());
        }

        let sem = Rc::new(tokio::sync::Semaphore::new(harness.concurrency.max(1)));
        let futs = tasks.iter().map(|task| {
            let harness = harness.clone();
            let sem = sem.clone();
            let task = task.clone();
            async move {
                let _permit = sem.acquire().await;
                run_subagent(&harness, &task).await
            }
        });
        let outcomes = futures::future::join_all(futs).await;

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
        // Read from `offset` onward instead of slurping the whole file, so a
        // page never allocates more than the remaining (capped) bytes.
        use std::io::{Read, Seek, SeekFrom};
        let start = offset.min(meta.len() as usize);
        f.seek(SeekFrom::Start(start as u64))
            .map_err(|e| format!("seek failed: {e}"))?;
        let mut bytes = Vec::with_capacity((meta.len() as usize).saturating_sub(start));
        f.read_to_end(&mut bytes)
            .map_err(|e| format!("read failed: {e}"))?;
        let text = String::from_utf8_lossy(&bytes).to_string();
        let chars: Vec<char> = text.chars().collect();
        let page: String = chars.iter().take(PAGE_CHARS).collect();
        let consumed_bytes = page.len();
        let next_offset = start + consumed_bytes;
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
            archive_dir: dir.join(".nex-archive"),
            jobs: Rc::new(RefCell::new(JobTable::default())),
            harness: None,
            mutations: Rc::new(RefCell::new(Vec::new())),
            mode_id: None,
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
        let big: String = std::iter::repeat('a').take(40_000).collect();
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
                    archive_dir: tmp.path().join(".nex-archive"),
                    cancelled: Rc::new(std::cell::Cell::new(false)),
                    mode_id: Rc::new(std::cell::RefCell::new("code".to_string())),
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
