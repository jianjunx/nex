//! Kill a spawned child together with the descendants that inherited its
//! process group (Unix) or process tree (Windows).
//!
//! `Child::start_kill` / `kill_on_drop` only terminate the direct child. MCP
//! servers launched via `uvx` / `uv` / `pipx` and tools started by an external
//! ACP agent are typically grandchildren (the wrapper stays in the middle).
//! Closing a conversation then orphans those processes — on macOS they show
//! up in Activity Monitor as `Python` / `Python3.12` and keep growing.

use tokio::process::{Child, Command};

/// Put the child in a fresh process group so later [`kill_tree`] / [`kill_tree_sync`]
/// can address the whole tree with one signal (Unix). No-op on Windows, where
/// `taskkill /T` walks the parent/child tree instead.
pub fn configure_new_group(cmd: &mut Command) {
    #[cfg(unix)]
    {
        cmd.process_group(0);
    }
    #[cfg(not(unix))]
    {
        let _ = cmd;
    }
}

/// Synchronous tree kill for `Drop` and other non-async teardown.
pub fn kill_tree_sync(child: &mut Child) {
    #[cfg(unix)]
    kill_unix_group(child);
    #[cfg(windows)]
    {
        if let Some(pid) = child.id() {
            let mut cmd = std::process::Command::new("taskkill");
            cmd.args(["/PID", &pid.to_string(), "/T", "/F"])
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null());
            crate::win_process::no_window(&mut cmd);
            let _ = cmd.spawn();
        }
    }
    let _ = child.start_kill();
}

/// Async tree kill used on handshake failure and other awaited teardown paths.
pub async fn kill_tree(child: &mut Child) {
    #[cfg(unix)]
    kill_unix_group(child);
    #[cfg(windows)]
    {
        if let Some(pid) = child.id() {
            let mut cmd = tokio::process::Command::new("taskkill");
            cmd.args(["/PID", &pid.to_string(), "/T", "/F"]);
            crate::win_process::no_window_tokio(&mut cmd);
            let _ = cmd.output().await;
        }
    }
    let _ = child.start_kill();
}

#[cfg(unix)]
fn kill_unix_group(child: &Child) {
    if let Some(pid) = child.id() {
        // Negative pid addresses the process group created by `process_group(0)`.
        // Ignore ESRCH: a fast-exiting process may have already reaped.
        unsafe {
            let _ = libc::kill(-(pid as libc::pid_t), libc::SIGKILL);
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::time::Duration;
    use tokio::io::AsyncReadExt;

    #[tokio::test]
    async fn kill_tree_reaps_grandchild_in_the_same_group() {
        let mut cmd = Command::new("/bin/sh");
        cmd.args(["-c", "sleep 30 & echo STARTED; wait"])
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true);
        configure_new_group(&mut cmd);
        let mut child = cmd.spawn().expect("spawn sleeper tree");
        let mut stdout = child.stdout.take().expect("piped stdout");
        let mut buf = [0u8; 16];
        let _ = tokio::time::timeout(Duration::from_secs(2), stdout.read(&mut buf))
            .await
            .expect("shell should print STARTED");

        let pgid = child.id().expect("child pid") as libc::pid_t;
        kill_tree(&mut child).await;
        tokio::time::timeout(Duration::from_secs(2), child.wait())
            .await
            .expect("shell should exit after kill_tree")
            .expect("wait for killed shell");

        // The shell can be reaped before its orphaned grandchild zombie is
        // adopted and reaped by launchd/init. Give that asynchronous cleanup a
        // bounded window instead of treating one scheduler tick as a leak.
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                // Signal 0 fails with ESRCH once every group member is gone.
                if unsafe { libc::kill(-pgid, 0) } == -1
                    && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap_or_else(|_| panic!("process group {pgid} still has members after kill_tree"));
    }
}
