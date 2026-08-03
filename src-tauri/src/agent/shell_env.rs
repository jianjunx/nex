//! Shell environment capture for GUI processes.
//!
//! On macOS / Linux, an app launched from Finder / Dock / a `.app` bundle does
//! not load the user's shell profile (`~/.zshrc`, `~/.bash_profile`), so PATH
//! is the bare system value — nvm / fnm / volta-installed Node is invisible.
//! This module captures PATH (and other vars) by running the user's login
//! shell in interactive mode, then broadcasts the result so that downstream
//! code (`which_in`, `PackageCache::ensure_installed`) can use the real PATH.
//!
//! A `ShellEnv` is cheap to construct, shareable via `Arc`, and the
//! `watch::Sender<bool>` channel means `wait_loaded` can be awaited by any
//! number of callers without any extra sync primitive.
//!
//! Mirrors the design in Zed's `crates/node_runtime/src/node_runtime.rs` but
//! uses `tokio::sync::watch` instead of `futures::future::Shared` to avoid
//! adding a new dependency.

use std::collections::HashMap;
use std::ffi::OsString;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex as StdMutex;
use std::time::Duration;

use tokio::sync::watch;

/// Hard cap on how long the login shell is allowed to run. .zshrc /
/// .zprofile / Homebrew analytics can be slow on cold start; we'd rather fall
/// back to a partial / empty env than block the GUI on this.
const SHELL_LOAD_TIMEOUT: Duration = Duration::from_secs(10);

/// Captured shell environment plus a "loaded" signal.
///
/// The signal is a `tokio::sync::watch::Sender<bool>` so that any number of
/// callers can `subscribe()` and `wait_loaded` without any extra dep on the
/// `futures` crate. The initial receiver is held by the struct itself so
/// the channel never closes (which would break `Sender::borrow()` and any
/// later `send`).
pub struct ShellEnv {
    /// Cached PATH from the login shell, if loaded.
    path: StdMutex<Option<OsString>>,
    /// `true` once `signal_loaded` has fired.
    loaded_tx: watch::Sender<bool>,
    /// Kept so the watch channel stays open. Without it, the first
    /// `signal_loaded` would no-op (closed-channel) and `is_loaded` would
    /// always return `false`.
    _loaded_rx: watch::Receiver<bool>,
    /// True once `try_trigger_lazy_load` has actually fired the background
    /// load task. Prevents duplicate zsh forks on concurrent first-touches.
    lazy_started: AtomicBool,
}

impl ShellEnv {
    /// Create a new `ShellEnv` wrapped in an `Arc`. The returned value is
    /// cheap to clone and should be stored on the long-lived manager so that
    /// any background tasks spawned with a clone outlive their spawn point.
    pub fn new() -> std::sync::Arc<Self> {
        let (loaded_tx, loaded_rx) = watch::channel(false);
        std::sync::Arc::new(Self {
            path: StdMutex::new(None),
            loaded_tx,
            _loaded_rx: loaded_rx,
            lazy_started: AtomicBool::new(false),
        })
    }

    /// Returns the loaded PATH, or the current process PATH as a fallback if
    /// the shell env hasn't been captured yet (or capture failed).
    pub fn path(&self) -> OsString {
        self.path
            .lock()
            .unwrap()
            .clone()
            .unwrap_or_else(|| std::env::var_os("PATH").unwrap_or_default())
    }

    /// True once `signal_loaded` has fired. Cheap synchronous read.
    pub fn is_loaded(&self) -> bool {
        *self.loaded_tx.borrow()
    }

    /// Triggers the background load task exactly once across the process
    /// lifetime. Returns `true` if this call fired the task, `false` if
    /// another caller already did.
    ///
    /// The task is spawned on `tauri::async_runtime` so it works correctly
    /// when called from Tauri's sync `setup` hook. The returned task holds
    /// an `Arc<Self>` so the receiver can't be dropped before it fires.
    pub fn try_trigger_lazy_load(self: &std::sync::Arc<Self>) -> bool {
        if self.lazy_started.swap(true, Ordering::SeqCst) {
            return false;
        }
        let me = std::sync::Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            let env = load_shell_env().await;
            me.signal_loaded(env);
        });
        true
    }

    /// Wait up to `timeout` for the loaded signal. Returns `true` if the
    /// signal fired within the timeout, `false` otherwise.
    pub async fn wait_loaded(&self, timeout: Duration) -> bool {
        // Fast path: already loaded.
        if self.is_loaded() {
            return true;
        }
        let mut rx = self.loaded_tx.subscribe();
        match tokio::time::timeout(timeout, rx.changed()).await {
            Ok(Ok(())) => *rx.borrow(),
            _ => false,
        }
    }

    /// Mark the shell env as loaded. Called by the background task spawned
    /// from `try_trigger_lazy_load`. Caches PATH so `path()` returns it
    /// synchronously from now on.
    pub fn signal_loaded(&self, env: HashMap<String, String>) {
        if let Some(p) = env.get("PATH") {
            *self.path.lock().unwrap() = Some(OsString::from(p));
        }
        // Ignore send errors — they only happen if there are no receivers,
        // which can't happen because `Self::new` always retains a `_rx`.
        let _ = self.loaded_tx.send(true);
    }
}

/// Run the user's login shell and capture its environment. Best-effort:
/// returns an empty map on any failure (shell missing, non-zero exit,
/// timeout). The caller decides what to do with partial results.
pub async fn load_shell_env() -> HashMap<String, String> {
    let shell = std::env::var_os("SHELL").unwrap_or_else(|| "/bin/zsh".into());
    let mut cmd = std::process::Command::new(&shell);
    // `-i` (interactive) + `-l` (login) so that the user's full profile chain
    // runs. `set +o nomatch` suppresses zsh "no match found" errors when
    // glob expansion runs against empty arrays (e.g. $PATH that has been
    // cleared). `env -0` emits NUL-separated `KEY=VALUE` pairs.
    cmd.args(["-ilc", "set +o nomatch; env -0"]);
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::null());

    let output = match tokio::time::timeout(SHELL_LOAD_TIMEOUT, async {
        tokio::process::Command::from(cmd).output().await
    })
    .await
    {
        Ok(Ok(out)) => out,
        _ => return HashMap::new(),
    };

    parse_env_nul(&output.stdout)
}

/// Parse a NUL-separated `KEY=VALUE` stream (as emitted by `env -0`).
///
/// Skips entries whose key isn't a POSIX identifier, and values containing
/// embedded NUL or LF bytes (which would corrupt the wire format).
pub fn parse_env_nul(bytes: &[u8]) -> HashMap<String, String> {
    let mut out = HashMap::new();
    for entry in bytes.split(|b| *b == 0) {
        if entry.is_empty() {
            continue;
        }
        let Some(eq) = entry.iter().position(|b| *b == b'=') else {
            continue;
        };
        let (key, val_with_eq) = entry.split_at(eq);
        let val = &val_with_eq[1..];
        if !is_posix_key(key) {
            continue;
        }
        if val.contains(&b'\n') || val.contains(&0) {
            continue;
        }
        if let (Ok(k), Ok(v)) = (
            std::str::from_utf8(key),
            std::str::from_utf8(val),
        ) {
            out.insert(k.to_string(), v.to_string());
        }
    }
    out
}

/// Returns true iff `b` is a valid POSIX environment variable name
/// (`[A-Za-z_][A-Za-z0-9_]*`).
pub fn is_posix_key(b: &[u8]) -> bool {
    let mut chars = b.iter();
    let Some(first) = chars.next() else {
        return false;
    };
    if !first.is_ascii_alphabetic() && *first != b'_' {
        return false;
    }
    chars.all(|c| c.is_ascii_alphanumeric() || *c == b'_')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn is_posix_key_accepts_canonical_names() {
        assert!(is_posix_key(b"PATH"));
        assert!(is_posix_key(b"HOME"));
        assert!(is_posix_key(b"_PRIVATE"));
        assert!(is_posix_key(b"A1"));
    }

    #[test]
    fn is_posix_key_rejects_invalid_names() {
        assert!(!is_posix_key(b""));
        assert!(!is_posix_key(b"1HOME"));
        assert!(!is_posix_key(b"HOME-USER"));
        assert!(!is_posix_key(b"HOME USER"));
        assert!(!is_posix_key(b"HOME=foo"));
    }

    #[test]
    fn parse_env_nul_extracts_keys_and_values() {
        let bytes = b"PATH=/usr/bin\0HOME=/home/u\0NOT POSIX=skip\0BAD\0EMPTY=\0K=V\0";
        let env = parse_env_nul(bytes);
        assert_eq!(env.get("PATH").map(String::as_str), Some("/usr/bin"));
        assert_eq!(env.get("HOME").map(String::as_str), Some("/home/u"));
        assert_eq!(env.get("K").map(String::as_str), Some("V"));
        assert_eq!(env.get("EMPTY").map(String::as_str), Some(""));
        assert!(!env.contains_key("NOT POSIX"));
        assert!(!env.contains_key("BAD"));
    }

    #[test]
    fn parse_env_nul_drops_values_with_embedded_lf() {
        // Embedded LF means the env entry crosses a record boundary, which
        // would silently merge two vars. Drop it.
        let bytes = b"BAD=line1\nline2\0GOOD=ok\0";
        let env = parse_env_nul(bytes);
        assert!(!env.contains_key("BAD"));
        assert_eq!(env.get("GOOD").map(String::as_str), Some("ok"));
    }

    #[test]
    fn shell_env_signal_makes_path_visible_synchronously() {
        let env = ShellEnv::new();
        let mut captured = HashMap::new();
        captured.insert("PATH".to_string(), "/from/shell/bin".to_string());
        env.signal_loaded(captured);
        assert_eq!(env.path(), OsString::from("/from/shell/bin"));
        assert!(env.is_loaded());
    }

    #[test]
    fn shell_env_path_falls_back_to_process_when_unloaded() {
        // Replace process PATH temporarily so we can detect the fallback.
        let original = std::env::var_os("PATH");
        let sentinel = OsString::from("/sentinel/nex-test");
        std::env::set_var("PATH", &sentinel);
        let env = ShellEnv::new();
        assert_eq!(env.path(), sentinel);
        if let Some(prev) = original {
            std::env::set_var("PATH", prev);
        } else {
            std::env::remove_var("PATH");
        }
    }

    #[tokio::test]
    async fn shell_env_wait_loaded_returns_immediately_when_already_loaded() {
        let env = ShellEnv::new();
        env.signal_loaded(HashMap::new());
        assert!(env.wait_loaded(Duration::from_millis(50)).await);
    }

    #[tokio::test]
    async fn shell_env_wait_loaded_times_out_when_never_signaled() {
        let env = ShellEnv::new();
        assert!(!env.wait_loaded(Duration::from_millis(20)).await);
    }
}
