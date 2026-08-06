//! The `bash` tool: runs a shell command synchronously in the session cwd with
//! a hard timeout.

use super::{arg_str, arg_usize, truncate_output, Tool, ToolCtx};
use agent_client_protocol as acp;

/// Cap on total output characters.
const MAX_OUTPUT_CHARS: usize = 20_000;

pub struct Bash;

#[async_trait::async_trait(?Send)]
impl Tool for Bash {
    fn name(&self) -> &'static str {
        "bash"
    }
    fn description(&self) -> &'static str {
        "Run a shell command in the workspace directory and return its exit code, \
         stdout and stderr. The command is killed after the configured timeout."
    }
    fn schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "command": { "type": "string", "description": "Shell command to execute." },
                "timeout_secs": { "type": "integer", "description": "Override timeout in seconds (default from agent config)." }
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
        let timeout = std::time::Duration::from_secs(
            arg_usize(&args, "timeout_secs", ctx.bash_timeout.as_secs() as usize) as u64,
        );

        let mut cmd = tokio::process::Command::new("/bin/sh");
        cmd.arg("-c").arg(&command).current_dir(&ctx.cwd);
        // `output()` kills the child when its future is dropped (timeout).
        let output = match tokio::time::timeout(timeout, cmd.output()).await {
            Ok(res) => res.map_err(|e| format!("failed to run command: {e}"))?,
            Err(_) => return Err(format!("command timed out after {}s", timeout.as_secs())),
        };

        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        let code = output.status.code().unwrap_or(-1);
        let mut out = format!("exit code: {code}\n");
        if !stdout.is_empty() {
            out.push_str(&format!("--- stdout ---\n{stdout}"));
            if !stdout.ends_with('\n') {
                out.push('\n');
            }
        }
        if !stderr.is_empty() {
            out.push_str(&format!("--- stderr ---\n{stderr}"));
            if !stderr.ends_with('\n') {
                out.push('\n');
            }
        }
        if code != 0 {
            // Surface non-zero exits as tool errors so the model reacts.
            return Err(truncate_output(out, MAX_OUTPUT_CHARS));
        }
        Ok(truncate_output(out, MAX_OUTPUT_CHARS))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn ctx(dir: &std::path::Path) -> ToolCtx {
        ToolCtx {
            cwd: dir.to_path_buf(),
            bash_timeout: Duration::from_secs(10),
            archive_dir: dir.join(".nex-archive"),
            jobs: std::rc::Rc::new(std::cell::RefCell::new(
                crate::agent::native::tools::jobs::JobTable::default(),
            )),
            harness: None,
            mutations: std::rc::Rc::new(std::cell::RefCell::new(Vec::new())),
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn bash_runs_in_cwd() {
        let tmp = tempfile::tempdir().unwrap();
        let out = Bash
            .execute(serde_json::json!({"command": "pwd && echo hi"}), &ctx(tmp.path()))
            .await
            .unwrap();
        assert!(out.contains("exit code: 0"));
        assert!(out.contains("hi"));
        // cwd respected
        let canon = tmp.path().canonicalize().unwrap();
        assert!(out.contains(&canon.to_string_lossy().to_string()));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn bash_nonzero_is_error() {
        let tmp = tempfile::tempdir().unwrap();
        let err = Bash
            .execute(serde_json::json!({"command": "exit 3"}), &ctx(tmp.path()))
            .await
            .unwrap_err();
        assert!(err.contains("exit code: 3"));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn bash_times_out() {
        let tmp = tempfile::tempdir().unwrap();
        let mut c = ctx(tmp.path());
        c.bash_timeout = Duration::from_millis(300);
        let err = Bash
            .execute(serde_json::json!({"command": "sleep 5"}), &c)
            .await
            .unwrap_err();
        assert!(err.contains("timed out"));
    }
}
