//! The `bash` tool: runs a shell command synchronously in the session cwd with
//! a hard timeout.

use super::{arg_str, truncate_output, Tool, ToolCtx};
use agent_client_protocol as acp;
use tokio::io::AsyncReadExt;

#[cfg(windows)]
fn apply_path_env(cmd: &mut tokio::process::Command, path_env: &std::ffi::OsStr) {
    cmd.env("PATH", path_env).env("Path", path_env);
}

#[cfg(not(windows))]
fn apply_path_env(cmd: &mut tokio::process::Command, path_env: &std::ffi::OsStr) {
    cmd.env("PATH", path_env);
}

/// Cap on total output characters.
const MAX_OUTPUT_CHARS: usize = 20_000;
/// Each pipe is drained continuously, but only this many bytes are retained.
/// Keeping a bounded prefix prevents `output()`-style unbounded buffering while
/// still avoiding a child deadlock when it writes more than we return.
const MAX_CAPTURE_BYTES_PER_STREAM: usize = 512 * 1024;
/// After a timeout, give the direct child a brief chance to reap after its
/// process group is killed. Never let cleanup itself turn into an unbounded
/// wait.
const TERMINATION_WAIT: std::time::Duration = std::time::Duration::from_secs(1);

struct CapturedOutput {
    bytes: Vec<u8>,
    truncated: bool,
}

/// Drain a child output pipe without letting its retained data grow without
/// bound. Reads continue after the cap so a noisy command cannot block on a
/// full OS pipe; excess bytes are intentionally discarded.
async fn capture_output<R>(mut reader: R) -> std::io::Result<CapturedOutput>
where
    R: tokio::io::AsyncRead + Unpin,
{
    let mut bytes = Vec::with_capacity(MAX_CAPTURE_BYTES_PER_STREAM.min(8192));
    let mut buf = [0u8; 8192];
    let mut truncated = false;
    loop {
        let read = reader.read(&mut buf).await?;
        if read == 0 {
            break;
        }
        let available = MAX_CAPTURE_BYTES_PER_STREAM.saturating_sub(bytes.len());
        let keep = available.min(read);
        bytes.extend_from_slice(&buf[..keep]);
        truncated |= keep < read;
    }
    Ok(CapturedOutput { bytes, truncated })
}

#[cfg(unix)]
fn configure_process_group(cmd: &mut tokio::process::Command) {
    // Give the shell and all of its descendants a fresh process group. This
    // lets timeout kill the entire tree instead of orphaning `sleep`, compiler
    // workers, or background jobs started by the shell.
    cmd.process_group(0);
}

#[cfg(not(unix))]
fn configure_process_group(_cmd: &mut tokio::process::Command) {}

/// `kill_on_drop` only kills the direct shell. On Unix, retain its dedicated
/// process-group id as a synchronous drop guard too, so cancellation of the
/// tool future cannot orphan descendants that inherited the shell's group.
#[cfg(unix)]
struct ProcessGroupGuard {
    pid: libc::pid_t,
    armed: bool,
}

#[cfg(unix)]
impl ProcessGroupGuard {
    fn new(pid: u32) -> Self {
        Self {
            pid: pid as libc::pid_t,
            armed: true,
        }
    }

    fn disarm(&mut self) {
        self.armed = false;
    }
}

#[cfg(unix)]
impl Drop for ProcessGroupGuard {
    fn drop(&mut self) {
        if self.armed {
            // The group belongs only to this shell (set with process_group(0)).
            // Ignore ESRCH after a normal/previously-killed exit.
            unsafe {
                let _ = libc::kill(-self.pid, libc::SIGKILL);
            }
        }
    }
}

#[cfg(unix)]
async fn terminate_process_tree(child: &mut tokio::process::Child) {
    if let Some(pid) = child.id() {
        // Negative pid addresses the process group created above. Ignore
        // ESRCH: a fast-exiting process may have won the timeout race.
        unsafe {
            let _ = libc::kill(-(pid as libc::pid_t), libc::SIGKILL);
        }
    }
    let _ = child.start_kill();
}

async fn clean_up_timed_out_command(
    child: &mut tokio::process::Child,
    stdout_task: &tokio::task::JoinHandle<std::io::Result<CapturedOutput>>,
    stderr_task: &tokio::task::JoinHandle<std::io::Result<CapturedOutput>>,
) {
    terminate_process_tree(child).await;
    // Do not await pipe drains indefinitely: a daemonized descendant could
    // have retained a pipe despite the kill attempt. Aborting the tasks drops
    // their readers and releases their bounded buffers.
    stdout_task.abort();
    stderr_task.abort();
    let _ = tokio::time::timeout(TERMINATION_WAIT, child.wait()).await;
}

fn timeout_error(timeout: std::time::Duration) -> String {
    format!(
        "command timed out after {}s; process tree was terminated",
        timeout.as_secs()
    )
}

#[cfg(windows)]
async fn terminate_process_tree(child: &mut tokio::process::Child) {
    if let Some(pid) = child.id() {
        // `/T` includes descendants. `taskkill` is part of supported Windows
        // installations; start_kill below remains a fallback if it fails.
        let _ = tokio::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .output()
            .await;
    }
    let _ = child.start_kill();
}

#[cfg(all(not(unix), not(windows)))]
async fn terminate_process_tree(child: &mut tokio::process::Child) {
    let _ = child.start_kill();
}

pub struct Bash;

#[async_trait::async_trait(?Send)]
impl Tool for Bash {
    fn name(&self) -> &'static str {
        "bash"
    }
    fn description(&self) -> &'static str {
        "Run a shell command in the workspace directory and return its exit code, \
         stdout and stderr. The command is killed after the configured timeout. \
         Runs under `cmd.exe /C` on Windows and `/bin/sh -c` on macOS/Linux."
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
        // Absent `timeout_secs` uses the context timeout verbatim (keeps
        // sub-second precision; `arg_usize` would truncate via `as_secs()`).
        let timeout = match args
            .get("timeout_secs")
            .and_then(|v| v.as_u64())
            .filter(|v| *v > 0)
        {
            Some(secs) => std::time::Duration::from_secs(secs),
            None => ctx.bash_timeout,
        };

        let mut cmd = super::shell_command_script(super::shell_command(), &command);
        cmd.current_dir(&ctx.cwd);
        apply_path_env(&mut cmd, &ctx.path_env);
        configure_process_group(&mut cmd);
        cmd.stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            // Covers caller cancellation / future drop, not just the explicit
            // timeout branch below.
            .kill_on_drop(true);
        let mut child = cmd
            .spawn()
            .map_err(|e| format!("failed to run command: {e}"))?;
        #[cfg(unix)]
        let mut process_group_guard = child.id().map(ProcessGroupGuard::new);
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "command stdout pipe unavailable".to_string())?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "command stderr pipe unavailable".to_string())?;
        let mut stdout_task = tokio::spawn(capture_output(stdout));
        let mut stderr_task = tokio::spawn(capture_output(stderr));
        // The timeout applies to the full operation, including pipe draining.
        // A shell can exit while a background child keeps stdout/stderr open.
        let deadline = tokio::time::Instant::now() + timeout;

        let status = match tokio::time::timeout_at(deadline, child.wait()).await {
            Ok(res) => res.map_err(|e| format!("failed to wait for command: {e}"))?,
            Err(_) => {
                clean_up_timed_out_command(&mut child, &stdout_task, &stderr_task).await;
                return Err(timeout_error(timeout));
            }
        };
        let stdout = match tokio::time::timeout_at(deadline, &mut stdout_task).await {
            Ok(result) => result
                .map_err(|e| format!("stdout capture task failed: {e}"))?
                .map_err(|e| format!("stdout capture failed: {e}"))?,
            Err(_) => {
                clean_up_timed_out_command(&mut child, &stdout_task, &stderr_task).await;
                return Err(timeout_error(timeout));
            }
        };
        let stderr = match tokio::time::timeout_at(deadline, &mut stderr_task).await {
            Ok(result) => result
                .map_err(|e| format!("stderr capture task failed: {e}"))?
                .map_err(|e| format!("stderr capture failed: {e}"))?,
            Err(_) => {
                clean_up_timed_out_command(&mut child, &stdout_task, &stderr_task).await;
                return Err(timeout_error(timeout));
            }
        };
        #[cfg(unix)]
        if let Some(guard) = process_group_guard.as_mut() {
            guard.disarm();
        }
        let stdout_text = String::from_utf8_lossy(&stdout.bytes);
        let stderr_text = String::from_utf8_lossy(&stderr.bytes);
        let code = status.code().unwrap_or(-1);
        let mut out = format!("exit code: {code}\n");
        let mut truncated = stdout.truncated || stderr.truncated;
        if !stdout_text.is_empty() {
            let (body, was_truncated) = tier_tool_output("bash", &stdout_text);
            truncated |= was_truncated || stdout.truncated;
            out.push_str(&format!("--- stdout ---\n{body}"));
            if !body.ends_with('\n') {
                out.push('\n');
            }
            if stdout.truncated {
                out.push_str(&format!(
                    "[stdout capture capped at {} bytes; remaining output discarded]\n",
                    MAX_CAPTURE_BYTES_PER_STREAM
                ));
            }
        }
        if !stderr_text.is_empty() {
            let (body, was_truncated) = tier_tool_output("bash", &stderr_text);
            truncated |= was_truncated || stderr.truncated;
            out.push_str(&format!("--- stderr ---\n{body}"));
            if !body.ends_with('\n') {
                out.push('\n');
            }
            if stderr.truncated {
                out.push_str(&format!(
                    "[stderr capture capped at {} bytes; remaining output discarded]\n",
                    MAX_CAPTURE_BYTES_PER_STREAM
                ));
            }
        }
        // Captured for future use (e.g. tagging the result as partial in
        // metrics). Keeping it explicit avoids silently reintroducing the
        // "we don't know the model saw partial output" regression in the
        // next refactor.
        let _ = truncated;
        if code != 0 {
            // Surface non-zero exits as tool errors so the model reacts.
            return Err(truncate_output(out, MAX_OUTPUT_CHARS));
        }
        Ok(truncate_output(out, MAX_OUTPUT_CHARS))
    }
}

/// Apply the shared output tiering helper: inline if it fits, else
/// preview head + tail + stable marker + recovery hint.
fn tier_tool_output(tool: &'static str, raw: &str) -> (String, bool) {
    use super::super::tools::{preview_partial, INLINE_CAP_CHARS};
    let chars = raw.chars().count();
    if chars <= INLINE_CAP_CHARS {
        return (raw.to_string(), false);
    }
    let head_chars = INLINE_CAP_CHARS / 3;
    let tail_chars = INLINE_CAP_CHARS / 3;
    let head: String = raw.chars().take(head_chars).collect();
    let tail: String = raw
        .chars()
        .rev()
        .take(tail_chars)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    let omitted = chars.saturating_sub(head_chars + tail_chars);
    let notice = preview_partial(
        tool,
        chars,
        head_chars,
        "Re-run with `head/tail/sed`/`grep -n` to inspect the rest, or archive via `history` if the transcript already compacted it.",
    );
    (
        format!("{notice}{head}\n--- omitted middle: {omitted} chars ---\n{tail}"),
        true,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn ctx(dir: &std::path::Path) -> ToolCtx {
        ToolCtx {
            cwd: dir.to_path_buf(),
            bash_timeout: Duration::from_secs(10),
            path_env: std::env::var_os("PATH").unwrap_or_default(),
            archive_dir: dir.join(".nex-archive"),
            jobs: std::rc::Rc::new(std::cell::RefCell::new(
                crate::agent::native::tools::jobs::JobTable::default(),
            )),
            harness: None,
            mutations: std::rc::Rc::new(std::cell::RefCell::new(Vec::new())),
            mode_id: None,
            memory: super::super::test_memory_handle(),
            graph: None,
        conn: None,
        session_id: None,
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn bash_runs_in_cwd() {
        let tmp = tempfile::tempdir().unwrap();
        // Platform-appropriate cwd probe: cmd has no `pwd`.
        let command = if cfg!(windows) {
            "echo %CD% && echo hi"
        } else {
            "pwd && echo hi"
        };
        let out = Bash
            .execute(serde_json::json!({ "command": command }), &ctx(tmp.path()))
            .await
            .unwrap();
        assert!(out.contains("exit code: 0"));
        assert!(out.contains("hi"));
        // cwd respected. On Windows `canonicalize()` prefixes `\\?\` while
        // cmd's `%CD%` does not, so compare against both forms.
        let canon = tmp
            .path()
            .canonicalize()
            .unwrap()
            .to_string_lossy()
            .replace(r"\\?\", "");
        assert!(
            out.contains(&canon) || out.contains(&tmp.path().to_string_lossy().to_string()),
            "cwd must be reflected in output: {out}"
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn bash_nonzero_is_error() {
        let tmp = tempfile::tempdir().unwrap();
        let err = Bash
            .execute(serde_json::json!({ "command": if cfg!(windows) { "exit /b 3" } else { "sh -c 'exit 3'" } }), &ctx(tmp.path()))
            .await
            .unwrap_err();
        assert!(err.contains("exit code: 3"));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn bash_times_out() {
        let tmp = tempfile::tempdir().unwrap();
        let mut c = ctx(tmp.path());
        c.bash_timeout = Duration::from_millis(300);
        // `cmd` has no `sleep`; `ping -n 6` blocks ~5s and always exists.
        let command = if cfg!(windows) {
            "ping -n 6 127.0.0.1 >nul"
        } else {
            "sleep 5"
        };
        let err = Bash
            .execute(serde_json::json!({"command": command}), &c)
            .await
            .unwrap_err();
        assert!(err.contains("timed out"));
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "current_thread")]
    async fn bash_timeout_covers_background_children_that_hold_output_pipes() {
        let tmp = tempfile::tempdir().unwrap();
        let mut c = ctx(tmp.path());
        c.bash_timeout = Duration::from_millis(250);
        // The shell exits immediately, but the background process inherits
        // stdout. Waiting only on `child.wait()` would then hang at output
        // drain time (until the 30s sleep ends) and leave the child running.
        let result = tokio::time::timeout(
            Duration::from_secs(3),
            Bash.execute(
                serde_json::json!({
                    "command": "sleep 30 & echo $! > background.pid; echo shell-exited"
                }),
                &c,
            ),
        )
        .await
        .expect("entire bash operation must honor its timeout");
        let err = result.expect_err("background pipe holder must be terminated");
        assert!(err.contains("timed out"), "got: {err}");
    }

    #[cfg(not(windows))]
    #[tokio::test(flavor = "current_thread")]
    async fn bash_drains_but_caps_noisy_output() {
        let tmp = tempfile::tempdir().unwrap();
        let out = Bash
            .execute(
                serde_json::json!({
                    "command": "yes x | head -c 1048576",
                    "timeout_secs": 5,
                }),
                &ctx(tmp.path()),
            )
            .await
            .unwrap();
        assert!(out.contains("stdout capture capped"), "got: {out}");
        assert!(
            out.len() <= MAX_OUTPUT_CHARS + 128,
            "result should remain bounded"
        );
    }

    #[test]
    fn tier_tool_output_inlines_small_results() {
        let (body, was_truncated) = tier_tool_output("bash", "small output");
        assert_eq!(body, "small output");
        assert!(!was_truncated);
    }

    #[test]
    fn tier_tool_output_truncates_with_stable_marker() {
        let big = format!("{}TAIL-ERROR-SUMMARY", "x".repeat(8_000));
        let (body, was_truncated) = tier_tool_output("bash", &big);
        assert!(was_truncated);
        assert!(body.contains(super::super::PARTIAL_MARKER));
        assert!(body.contains("bash output truncated"));
        assert!(
            body.contains("TAIL-ERROR-SUMMARY"),
            "tail should survive preview"
        );
        assert!(body.contains("omitted middle"));
    }
}
