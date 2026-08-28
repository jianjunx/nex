//! User-configured native-agent lifecycle hooks.
//!
//! Hooks live in the global native-agent config (never repository-controlled),
//! receive a bounded JSON payload on stdin, and run with the session cwd/PATH.
//! They are intended for policy checks, telemetry and local integrations.

use std::collections::HashMap;
use std::ffi::OsStr;
use std::path::Path;
use std::time::Duration;

use serde::{Deserialize, Serialize};

const MAX_HOOK_OUTPUT_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HookEvent {
    BeforeTurn,
    AfterTurn,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HookCommand {
    pub event: HookEvent,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
    #[serde(default = "default_timeout")]
    pub timeout_secs: u64,
    /// A failed before-turn hook aborts the model turn when true.
    #[serde(default)]
    pub fail_closed: bool,
}

fn default_timeout() -> u64 {
    15
}

pub async fn run(
    hooks: &[HookCommand],
    event: HookEvent,
    cwd: &Path,
    path_env: &OsStr,
    payload: &serde_json::Value,
) -> Result<(), String> {
    let input = serde_json::to_vec(payload).map_err(|e| format!("encode hook payload: {e}"))?;
    for hook in hooks.iter().filter(|hook| hook.event == event) {
        if hook.command.trim().is_empty() {
            continue;
        }
        let executable = which::which_in(&hook.command, Some(path_env), cwd)
            .unwrap_or_else(|_| hook.command.clone().into());
        let mut child = tokio::process::Command::new(executable);
        child
            .args(&hook.args)
            .current_dir(cwd)
            .env("PATH", path_env)
            .envs(&hook.env)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);
        let mut child = match child.spawn() {
            Ok(child) => child,
            Err(error) => {
                let error = format!("hook `{}` failed to start: {error}", hook.command);
                if hook.fail_closed {
                    return Err(error);
                }
                log::warn!("{error}");
                continue;
            }
        };
        if let Some(mut stdin) = child.stdin.take() {
            use tokio::io::AsyncWriteExt;
            if let Err(error) = stdin.write_all(&input).await {
                if hook.fail_closed {
                    return Err(format!("hook `{}` stdin failed: {error}", hook.command));
                }
            }
        }
        let timeout = Duration::from_secs(hook.timeout_secs.clamp(1, 300));
        let output = match tokio::time::timeout(timeout, child.wait_with_output()).await {
            Ok(Ok(output)) => output,
            Ok(Err(error)) => {
                let error = format!("hook `{}` failed: {error}", hook.command);
                if hook.fail_closed {
                    return Err(error);
                }
                log::warn!("{error}");
                continue;
            }
            Err(_) => {
                let error = format!("hook `{}` timed out", hook.command);
                if hook.fail_closed {
                    return Err(error);
                }
                log::warn!("{error}");
                continue;
            }
        };
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(
                &output.stderr[..output.stderr.len().min(MAX_HOOK_OUTPUT_BYTES)],
            );
            let error = format!(
                "hook `{}` exited {}: {}",
                hook.command,
                output.status,
                stderr.trim()
            );
            if hook.fail_closed {
                return Err(error);
            }
            log::warn!("{error}");
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hook_config_defaults_are_bounded() {
        let hook: HookCommand = serde_json::from_value(serde_json::json!({
            "event":"before_turn", "command":"policy-check"
        }))
        .unwrap();
        assert_eq!(hook.timeout_secs, 15);
        assert!(!hook.fail_closed);
    }
}
