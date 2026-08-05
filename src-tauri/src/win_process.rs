//! Windows helpers so GUI-spawned console tools (git / cmd / node) do not
//! flash a visible terminal window.
//!
//! On Windows, spawning a console-subsystem binary from a GUI app creates a
//! new console unless `CREATE_NO_WINDOW` is set. Agent launch already does
//! this (`launch.rs`); git network ops / shell-env capture historically did
//! not — hence the cascade of flashes on startup and during pull/fetch.

#![allow(dead_code)] // helpers are cfg-gated at call sites on non-Windows

/// `CREATE_NO_WINDOW` — process is created without a new console window.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Apply `CREATE_NO_WINDOW` to a `std::process::Command` (no-op on non-Windows).
pub fn no_window(cmd: &mut std::process::Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    {
        let _ = cmd;
    }
}

/// Apply `CREATE_NO_WINDOW` to a `tokio::process::Command` (no-op on non-Windows).
pub fn no_window_tokio(cmd: &mut tokio::process::Command) {
    #[cfg(windows)]
    {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    {
        let _ = cmd;
    }
}
