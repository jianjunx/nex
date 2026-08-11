//! The `bash` tool: runs a shell command synchronously in the session cwd with
//! a hard timeout.

use super::{arg_str, truncate_output, Tool, ToolCtx};
use agent_client_protocol as acp;

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
        let timeout = match args.get("timeout_secs").and_then(|v| v.as_u64()).filter(|v| *v > 0) {
            Some(secs) => std::time::Duration::from_secs(secs),
            None => ctx.bash_timeout,
        };

        let mut cmd = super::shell_command_script(super::shell_command(), &command);
        cmd.current_dir(&ctx.cwd);
        apply_path_env(&mut cmd, &ctx.path_env);
        // `output()` kills the child when its future is dropped (timeout).
        let output = match tokio::time::timeout(timeout, cmd.output()).await {
            Ok(res) => res.map_err(|e| format!("failed to run command: {e}"))?,
            Err(_) => return Err(format!("command timed out after {}s", timeout.as_secs())),
        };

        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        let code = output.status.code().unwrap_or(-1);
        let mut out = format!("exit code: {code}\n");
        let mut truncated = false;
        if !stdout.is_empty() {
            let (body, was_truncated) = tier_tool_output("bash", &stdout);
            truncated |= was_truncated;
            out.push_str(&format!("--- stdout ---\n{body}"));
            if !body.ends_with('\n') {
                out.push('\n');
            }
        }
        if !stderr.is_empty() {
            let (body, was_truncated) = tier_tool_output("bash", &stderr);
            truncated |= was_truncated;
            out.push_str(&format!("--- stderr ---\n{body}"));
            if !body.ends_with('\n') {
                out.push('\n');
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
/// preview head + stable marker + recovery hint.
fn tier_tool_output(tool: &'static str, raw: &str) -> (String, bool) {
    use super::super::tools::{preview_partial, INLINE_CAP_CHARS};
    let chars = raw.chars().count();
    if chars <= INLINE_CAP_CHARS {
        return (raw.to_string(), false);
    }
    let head_chars = INLINE_CAP_CHARS / 2;
    let head: String = raw.chars().take(head_chars).collect();
    let notice = preview_partial(
        tool,
        chars,
        head_chars,
        "Re-run with `head/tail/sed`/`grep -n` to inspect the rest, or archive via `history` if the transcript already compacted it.",
    );
    (format!("{notice}{head}"), true)
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

    #[test]
    fn tier_tool_output_inlines_small_results() {
        let (body, was_truncated) = tier_tool_output("bash", "small output");
        assert_eq!(body, "small output");
        assert!(!was_truncated);
    }

    #[test]
    fn tier_tool_output_truncates_with_stable_marker() {
        let big = "x".repeat(8_000);
        let (body, was_truncated) = tier_tool_output("bash", &big);
        assert!(was_truncated);
        assert!(body.contains(super::super::PARTIAL_MARKER));
        assert!(body.contains("bash output truncated"));
    }
}
