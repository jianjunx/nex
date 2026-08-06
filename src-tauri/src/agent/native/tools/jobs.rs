//! Background shell jobs: `run_in_background`, `bash_output`, `kill_shell`,
//! `wait`. Jobs live in a per-session [`JobTable`] and survive across turns.

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use tokio::io::{AsyncBufReadExt, AsyncReadExt};
use tokio::sync::oneshot;

use super::{arg_str, arg_usize, truncate_output, Tool, ToolCtx};
use agent_client_protocol as acp;

/// Cap on total output characters returned per call.
const MAX_OUTPUT_CHARS: usize = 20_000;

/// Handle to one background job.
struct BgJobHandle {
    #[allow(dead_code)] // kept for future listings/diagnostics
    command: String,
    /// Accumulated stdout+stderr (interleaved, best-effort ordering).
    output: Rc<RefCell<Vec<u8>>>,
    /// Set once the process exits (or is killed).
    exit_code: Rc<RefCell<Option<i32>>>,
    /// Sends the kill signal to the supervising task (once).
    kill_tx: Option<oneshot::Sender<()>>,
}

impl BgJobHandle {
    fn running(&self) -> bool {
        self.exit_code.borrow().is_none()
    }
}

/// Per-session table of background jobs.
#[derive(Default)]
pub struct JobTable {
    jobs: HashMap<String, BgJobHandle>,
    next_id: u64,
}

impl JobTable {
    /// Spawns `command` under `/bin/sh` in `cwd`, returning the job id.
    pub async fn spawn(
        &mut self,
        command: &str,
        cwd: &std::path::Path,
    ) -> Result<String, String> {
        let mut cmd = tokio::process::Command::new("/bin/sh");
        cmd.arg("-c")
            .arg(command)
            .current_dir(cwd)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);
        let mut child = cmd
            .spawn()
            .map_err(|e| format!("failed to spawn background job: {e}"))?;

        self.next_id += 1;
        let id = format!("job-{}", self.next_id);
        let output: Rc<RefCell<Vec<u8>>> = Rc::new(RefCell::new(Vec::new()));
        let exit_code: Rc<RefCell<Option<i32>>> = Rc::new(RefCell::new(None));
        let (kill_tx, kill_rx) = oneshot::channel::<()>();

        // Supervising task: drain stdout (kill-aware)…
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let out2 = output.clone();
        let exit2 = exit_code.clone();
        tokio::task::spawn_local(async move {
            let mut kill_rx = kill_rx;
            if let Some(stdout) = stdout {
                let mut reader = tokio::io::BufReader::new(stdout);
                let mut line = Vec::new();
                loop {
                    line.clear();
                    tokio::select! {
                        _ = &mut kill_rx => {
                            let _ = child.kill().await;
                            break;
                        }
                        res = reader.read_until(b'\n', &mut line) => {
                            match res {
                                Ok(0) => break,
                                Ok(_) => out2.borrow_mut().extend_from_slice(&line),
                                Err(_) => break,
                            }
                        }
                    }
                }
            }
            let status = child.wait().await;
            *exit2.borrow_mut() = Some(status.map(|s| s.code().unwrap_or(-1)).unwrap_or(-1));
        });

        // …and stderr on its own task into the same buffer.
        if let Some(mut stderr) = stderr {
            let out3 = output.clone();
            tokio::task::spawn_local(async move {
                let mut buf = [0u8; 4096];
                loop {
                    match stderr.read(&mut buf).await {
                        Ok(0) | Err(_) => break,
                        Ok(n) => out3.borrow_mut().extend_from_slice(&buf[..n]),
                    }
                }
            });
        }

        self.jobs.insert(
            id.clone(),
            BgJobHandle {
                command: command.to_string(),
                output,
                exit_code,
                kill_tx: Some(kill_tx),
            },
        );
        Ok(id)
    }
}

pub struct RunInBackground;

#[async_trait::async_trait(?Send)]
impl Tool for RunInBackground {
    fn name(&self) -> &'static str {
        "run_in_background"
    }
    fn description(&self) -> &'static str {
        "Start a long-running shell command in the background (dev servers, watchers). \
         Returns a job id. Use `bash_output` to read its output, `wait` for it to exit, \
         and `kill_shell` to stop it."
    }
    fn schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "command": { "type": "string", "description": "Shell command to run in the background." }
            },
            "required": ["command"],
            "additionalProperties": false
        })
    }
    fn kind(&self) -> acp::ToolKind {
        acp::ToolKind::Execute
    }
    async fn execute(&self, args: serde_json::Value, ctx: &ToolCtx) -> Result<String, String> {
        let command = arg_str(&args, "command")?;
        let id = ctx.jobs.borrow_mut().spawn(&command, &ctx.cwd).await?;
        Ok(format!("started background job `{id}`: {command}"))
    }
}

pub struct BashOutput;

#[async_trait::async_trait(?Send)]
impl Tool for BashOutput {
    fn name(&self) -> &'static str {
        "bash_output"
    }
    fn description(&self) -> &'static str {
        "Read accumulated output of a background job. Pass `offset` (byte position from \
         the previous read) to fetch only new output."
    }
    fn schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "job_id": { "type": "string", "description": "Job id returned by run_in_background." },
                "offset": { "type": "integer", "description": "Byte offset to start reading from. Default 0." }
            },
            "required": ["job_id"],
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
        let job_id = arg_str(&args, "job_id")?;
        let offset = arg_usize(&args, "offset", 0);
        let jobs = ctx.jobs.borrow();
        let job = jobs.jobs.get(&job_id).ok_or_else(|| format!("unknown job `{job_id}`"))?;
        let (text, next_offset, status) = {
            let buf = job.output.borrow();
            let status = if job.running() { "running".to_string() } else {
                format!("exited with code {}", job.exit_code.borrow().unwrap_or(-1))
            };
            let text = String::from_utf8_lossy(&buf[offset.min(buf.len())..]).to_string();
            (text, buf.len(), status)
        };
        drop(jobs);
        let body = if text.is_empty() {
            "(no new output)".to_string()
        } else {
            truncate_output(text, MAX_OUTPUT_CHARS)
        };
        Ok(format!("job `{job_id}` ({status}); next offset: {next_offset}\n{body}"))
    }
}

pub struct KillShell;

#[async_trait::async_trait(?Send)]
impl Tool for KillShell {
    fn name(&self) -> &'static str {
        "kill_shell"
    }
    fn description(&self) -> &'static str {
        "Kill a background job started with run_in_background."
    }
    fn schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "job_id": { "type": "string", "description": "Job id to kill." }
            },
            "required": ["job_id"],
            "additionalProperties": false
        })
    }
    fn kind(&self) -> acp::ToolKind {
        acp::ToolKind::Execute
    }
    async fn execute(&self, args: serde_json::Value, ctx: &ToolCtx) -> Result<String, String> {
        let job_id = arg_str(&args, "job_id")?;
        let mut jobs = ctx.jobs.borrow_mut();
        let job = jobs.jobs.get_mut(&job_id).ok_or_else(|| format!("unknown job `{job_id}`"))?;
        if !job.running() {
            return Ok(format!("job `{job_id}` already exited"));
        }
        if let Some(tx) = job.kill_tx.take() {
            let _ = tx.send(());
        }
        Ok(format!("kill signal sent to job `{job_id}`"))
    }
}

pub struct WaitJob;

#[async_trait::async_trait(?Send)]
impl Tool for WaitJob {
    fn name(&self) -> &'static str {
        "wait"
    }
    fn description(&self) -> &'static str {
        "Wait for a background job to exit (up to `timeout_secs`, default 30) and \
         report its exit code."
    }
    fn schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "job_id": { "type": "string", "description": "Job id to wait for." },
                "timeout_secs": { "type": "integer", "description": "Max seconds to wait. Default 30." }
            },
            "required": ["job_id"],
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
        let job_id = arg_str(&args, "job_id")?;
        let timeout_secs = arg_usize(&args, "timeout_secs", 30) as u64;
        let exit_flag = {
            let jobs = ctx.jobs.borrow();
            let job = jobs.jobs.get(&job_id).ok_or_else(|| format!("unknown job `{job_id}`"))?;
            job.exit_code.clone()
        };
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(timeout_secs);
        loop {
            if let Some(code) = *exit_flag.borrow() {
                return Ok(format!("job `{job_id}` exited with code {code}"));
            }
            if tokio::time::Instant::now() >= deadline {
                return Ok(format!("job `{job_id}` still running after {timeout_secs}s"));
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::native::tools::ToolCtx;

    fn ctx(dir: &std::path::Path) -> ToolCtx {
        ToolCtx {
            cwd: dir.to_path_buf(),
            bash_timeout: std::time::Duration::from_secs(10),
            archive_dir: dir.join(".nex-archive"),
            jobs: Rc::new(RefCell::new(JobTable::default())),
            harness: None,
            mutations: Rc::new(RefCell::new(Vec::new())),
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn background_job_lifecycle() {
        let local = tokio::task::LocalSet::new();
        local
            .run_until(async {
                let tmp = tempfile::tempdir().unwrap();
                let c = ctx(tmp.path());
                let started = RunInBackground
                    .execute(serde_json::json!({"command": "echo bg-out && sleep 0.1 && echo done"}), &c)
                    .await
                    .unwrap();
                assert!(started.contains("job-1"));

                let waited = WaitJob
                    .execute(serde_json::json!({"job_id": "job-1", "timeout_secs": 5}), &c)
                    .await
                    .unwrap();
                assert!(waited.contains("exited with code 0"));

                let out = BashOutput
                    .execute(serde_json::json!({"job_id": "job-1"}), &c)
                    .await
                    .unwrap();
                assert!(out.contains("bg-out"));
                assert!(out.contains("done"));

                // Incremental read from the end yields no new output.
                let next: usize = out
                    .split("next offset: ")
                    .nth(1)
                    .and_then(|s| s.lines().next())
                    .unwrap()
                    .parse()
                    .unwrap();
                let tail = BashOutput
                    .execute(serde_json::json!({"job_id": "job-1", "offset": next}), &c)
                    .await
                    .unwrap();
                assert!(tail.contains("(no new output)"));
            })
            .await;
    }

    #[tokio::test(flavor = "current_thread")]
    async fn kill_stops_a_running_job() {
        let local = tokio::task::LocalSet::new();
        local
            .run_until(async {
                let tmp = tempfile::tempdir().unwrap();
                let c = ctx(tmp.path());
                RunInBackground
                    .execute(serde_json::json!({"command": "sleep 30"}), &c)
                    .await
                    .unwrap();
                let killed = KillShell
                    .execute(serde_json::json!({"job_id": "job-1"}), &c)
                    .await
                    .unwrap();
                assert!(killed.contains("kill signal"));
                let waited = WaitJob
                    .execute(serde_json::json!({"job_id": "job-1", "timeout_secs": 5}), &c)
                    .await
                    .unwrap();
                assert!(waited.contains("exited"), "{waited}");
            })
            .await;
    }
}
