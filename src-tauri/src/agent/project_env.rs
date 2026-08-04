//! Per-project environment capture (direnv / nix / mise-friendly).
//!
//! Login-shell PATH alone is not enough for agents: tools like direnv inject
//! PATH entries only after `cd` into the project. Mirrors Zed's approach —
//! run the user's login shell with an explicit `cd` into `cwd`, then parse
//! `env -0` (Unix) or `set` (Windows).
//!
//! Results are cached by canonical cwd string so opening many sessions in the
//! same project does not re-fork zsh every time. Cache is best-effort; a miss
//! or failure falls back to [`ShellEnv::path`].

use std::collections::HashMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Mutex;
use std::time::Duration;

use super::shell_env::{parse_env_nul, ShellEnv};

const PROJECT_ENV_TIMEOUT: Duration = Duration::from_secs(8);

/// In-memory cache of per-cwd environments.
pub struct ProjectEnvCache {
    cache: Mutex<HashMap<String, HashMap<String, String>>>,
}

impl ProjectEnvCache {
    pub fn new() -> std::sync::Arc<Self> {
        std::sync::Arc::new(Self {
            cache: Mutex::new(HashMap::new()),
        })
    }

    /// PATH for `cwd`, preferring a project-scoped capture (direnv etc.) and
    /// falling back to the login-shell PATH from `fallback`.
    pub async fn path_for_cwd(&self, cwd: &str, fallback: &ShellEnv) -> OsString {
        let env = self.env_for_cwd(cwd, fallback).await;
        env.get("PATH")
            .map(OsString::from)
            .unwrap_or_else(|| fallback.path())
    }

    /// Full env map for `cwd` (cached). On capture failure returns the
    /// login-shell snapshot so callers still get *something* useful.
    pub async fn env_for_cwd(
        &self,
        cwd: &str,
        fallback: &ShellEnv,
    ) -> HashMap<String, String> {
        let key = normalize_cwd_key(cwd);
        if let Some(hit) = self.cache.lock().unwrap().get(&key).cloned() {
            return hit;
        }

        let captured = capture_project_env(Path::new(cwd)).await;
        let resolved = if captured.get("PATH").map(|p| !p.is_empty()).unwrap_or(false) {
            captured
        } else {
            let mut snap = fallback.snapshot();
            if snap.is_empty() {
                // Shell env still loading — at least expose process PATH.
                if let Some(p) = std::env::var_os("PATH") {
                    snap.insert("PATH".to_string(), p.to_string_lossy().into_owned());
                }
            }
            snap
        };

        self.cache
            .lock()
            .unwrap()
            .insert(key, resolved.clone());
        resolved
    }
}

impl Default for ProjectEnvCache {
    fn default() -> Self {
        Self {
            cache: Mutex::new(HashMap::new()),
        }
    }
}

fn normalize_cwd_key(cwd: &str) -> String {
    PathBuf::from(cwd)
        .canonicalize()
        .unwrap_or_else(|_| PathBuf::from(cwd))
        .to_string_lossy()
        .into_owned()
}

/// Escape a path for safe inclusion inside single-quoted shell strings.
fn shell_single_quote(path: &str) -> String {
    // 'foo'bar' → 'foo'\''bar'
    format!("'{}'", path.replace('\'', "'\\''"))
}

/// Best-effort capture of the environment as seen after `cd` into `cwd`.
pub async fn capture_project_env(cwd: &Path) -> HashMap<String, String> {
    #[cfg(windows)]
    {
        capture_project_env_windows(cwd).await
    }
    #[cfg(not(windows))]
    {
        capture_project_env_unix(cwd).await
    }
}

#[cfg(not(windows))]
async fn capture_project_env_unix(cwd: &Path) -> HashMap<String, String> {
    let shell = std::env::var_os("SHELL").unwrap_or_else(|| "/bin/zsh".into());
    let cwd_str = cwd.to_string_lossy();
    let quoted = shell_single_quote(&cwd_str);
    // `cd` into the project so direnv / nix-direnv / asdf hooks fire, then
    // dump the environment. Same login+interactive flags as ShellEnv.
    let script = format!("set +o nomatch; cd {quoted} && env -0");

    let mut cmd = std::process::Command::new(&shell);
    cmd.args(["-ilc", &script]);
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::null());

    let output = match tokio::time::timeout(PROJECT_ENV_TIMEOUT, async {
        tokio::process::Command::from(cmd).output().await
    })
    .await
    {
        Ok(Ok(out)) => out,
        _ => return HashMap::new(),
    };

    parse_env_nul(&output.stdout)
}

#[cfg(windows)]
async fn capture_project_env_windows(cwd: &Path) -> HashMap<String, String> {
    use super::shell_env::parse_env_cmd_windows;

    let shell = std::env::var_os("COMSPEC").unwrap_or_else(|| OsString::from("cmd.exe"));
    let mut cmd = std::process::Command::new(&shell);
    // `cd /d` switches drive+dir; `set` dumps the user/system env (direnv
    // on Windows is uncommon — this still picks up Git for Windows etc.).
    cmd.args(["/U", "/C", "set"]);
    cmd.current_dir(cwd);
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::null());

    let output = match tokio::time::timeout(PROJECT_ENV_TIMEOUT, async {
        tokio::process::Command::from(cmd).output().await
    })
    .await
    {
        Ok(Ok(out)) => out,
        _ => return HashMap::new(),
    };

    parse_env_cmd_windows(&output.stdout)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shell_single_quote_escapes_embedded_quotes() {
        assert_eq!(shell_single_quote("/tmp/foo"), "'/tmp/foo'");
        assert_eq!(
            shell_single_quote("/tmp/it's"),
            "'/tmp/it'\\''s'"
        );
    }

    #[test]
    fn normalize_cwd_key_stable_for_relative() {
        let a = normalize_cwd_key(".");
        let b = normalize_cwd_key(".");
        assert_eq!(a, b);
    }

    #[tokio::test]
    async fn path_for_cwd_falls_back_to_shell_env() {
        let cache = ProjectEnvCache::new();
        let shell = ShellEnv::new();
        let mut snap = HashMap::new();
        snap.insert("PATH".to_string(), "/fallback/bin".to_string());
        shell.signal_loaded(snap);

        // Use a path that almost certainly fails `cd` in a login shell
        // capture (missing dir) so we exercise the fallback path. Cache
        // still stores the fallback result.
        let path = cache
            .path_for_cwd("/nex-definitely-missing-cwd-xyz", &shell)
            .await;
        assert_eq!(path, OsString::from("/fallback/bin"));
    }
}
