//! Agent process launch — turning a registry entry (or a user's custom server)
//! into a concrete OS command, then spawning it.
//!
//! Clean-room port of the launch *mechanism* from Zed's
//! `crates/project/src/{external_agents,agent_server_store}.rs` and
//! `crates/agent_servers/src/custom.rs`: we build `npx --yes -- <package> <args>`
//! for registry agents, apply the one per-agent env override that actually
//! changes behavior (`claude-acp` clears a stray `ANTHROPIC_API_KEY`), and on
//! Windows run npm `.cmd` shims through `cmd /c` without flashing a console
//! window. Zed reads the proxy URL from its own settings; Nex does not read
//! Zed's config, and proxy variables are inherited from Nex's environment
//! automatically, so no explicit proxy pass-through is needed here.

use std::collections::HashMap;

use super::registry::RegistryEntry;
use crate::error::NexError;

/// Registry id of Anthropic's Claude agent — the one agent that needs an env
/// override (see `apply_per_id_env`). Matches Zed's `CLAUDE_AGENT_ID`.
pub const CLAUDE_AGENT_ID: &str = "claude-acp";

/// A fully-resolved command ready to spawn.
#[derive(Debug, Clone)]
pub struct LaunchSpec {
    pub program: String,
    pub args: Vec<String>,
    pub env: HashMap<String, String>,
    pub cwd: String,
}

/// Resolves a registry agent into a launch spec.
///
/// v1 supports the `npx` distribution (the common case: claude-acp, codex-acp,
/// gemini, …). For binary-only agents we look up the current platform's target
/// and spawn the command directly — Nex does not download or extract archives,
/// so the binary must already be installed on PATH.
pub fn resolve_registry(entry: &RegistryEntry, cwd: &str) -> Result<LaunchSpec, NexError> {
    if let Some(npx) = &entry.distribution.npx {
        // `npx --yes -- <package@version> <entry args…>`. The registry's
        // `package` already embeds the pinned version, so we use it verbatim.
        let mut args = vec!["--yes".to_string(), "--".to_string(), npx.package.clone()];
        args.extend(npx.args.iter().cloned());

        let mut env = npx.env.clone();
        apply_per_id_env(&entry.id, &mut env);

        return Ok(LaunchSpec { program: "npx".to_string(), args, env, cwd: cwd.to_string() });
    }

    if let Some(binaries) = &entry.distribution.binary {
        let key = current_platform_key();
        if let Some(target) = binaries.get(&key) {
            let program = target.cmd.clone();
            let args = target.args.clone();
            let mut env = target.env.clone();
            apply_per_id_env(&entry.id, &mut env);
            return Ok(LaunchSpec { program, args, env, cwd: cwd.to_string() });
        }
        return Err(NexError::Agent(format!(
            "agent `{}` has no binary for platform `{}` (available: {:?})",
            entry.id, key, binaries.keys().collect::<Vec<_>>()
        )));
    }

    Err(NexError::Agent(format!(
        "agent `{}` has no supported distribution (an `npx` or `binary` distribution is required)",
        entry.id
    )))
}

/// Builds the platform key used to index binary targets in the registry
/// (e.g. `windows-x86_64`, `macos-aarch64`).
fn current_platform_key() -> String {
    format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH)
}

/// Resolves a user-defined custom server (a raw command string) into a launch
/// spec. Unlike registry agents this string is the *user's* input, not a Nex
/// guess, so splitting it on whitespace is appropriate.
pub fn resolve_custom(command: &str, env: HashMap<String, String>, cwd: &str) -> Result<LaunchSpec, NexError> {
    let mut parts = command.split_whitespace();
    let program = parts
        .next()
        .ok_or_else(|| NexError::Agent("empty agent command".to_string()))?
        .to_string();
    let args: Vec<String> = parts.map(str::to_string).collect();
    Ok(LaunchSpec { program, args, env, cwd: cwd.to_string() })
}

/// Per-agent env overrides, mirroring Zed's `custom.rs`.
///
/// Only `claude-acp` needs an explicit override: clearing `ANTHROPIC_API_KEY`
/// forces the wrapper to use its own stored-credentials/OAuth flow instead of a
/// stray ambient API key. Zed also re-passes `CODEX_API_KEY`/`GEMINI_API_KEY`
/// and sets `SURFACE=zed`, but those are redundant here — the child inherits
/// Nex's environment (so any such keys already flow through), and `SURFACE` is
/// a Zed-specific telemetry marker we don't want to impersonate.
fn apply_per_id_env(agent_id: &str, env: &mut HashMap<String, String>) {
    if agent_id == CLAUDE_AGENT_ID {
        env.insert("ANTHROPIC_API_KEY".to_string(), String::new());
    }
}

/// True when `program` is an npm/node shim that Windows can only run through a
/// shell (`npx`/`npm`/`node` resolve to `.cmd` batch files; `CreateProcess`
/// cannot execute those directly).
fn needs_shell(program: &str) -> bool {
    let p = program.to_ascii_lowercase();
    p == "npx" || p == "npm" || p == "node" || p.ends_with(".cmd") || p.ends_with(".bat")
}

/// Computes the real `(program, args)` to hand the OS, wrapping shell shims in
/// `cmd /c` on Windows.
///
/// OS-independent (takes an explicit `windows` flag) so the wrapping logic is
/// unit-testable on any host.
pub fn shell_argv(program: &str, args: &[String], windows: bool) -> (String, Vec<String>) {
    if windows && needs_shell(program) {
        let mut wrapped = Vec::with_capacity(args.len() + 2);
        wrapped.push("/c".to_string());
        wrapped.push(program.to_string());
        wrapped.extend_from_slice(args);
        ("cmd".to_string(), wrapped)
    } else {
        (program.to_string(), args.to_vec())
    }
}

/// Spawns the agent with piped stdio. On Windows, npm shims are wrapped in
/// `cmd /c` (see `shell_argv`) and `CREATE_NO_WINDOW` is set so the shim
/// doesn't flash a console window in this GUI app.
pub fn spawn_agent(spec: &LaunchSpec) -> Result<tokio::process::Child, NexError> {
    spawn_with(spec, cfg!(windows))
}

fn spawn_with(spec: &LaunchSpec, windows: bool) -> Result<tokio::process::Child, NexError> {
    let (program, args) = shell_argv(&spec.program, &spec.args, windows);

    let mut cmd = tokio::process::Command::new(&program);
    cmd.args(&args);
    configure(&mut cmd, spec);

    match cmd.spawn() {
        Ok(child) => Ok(child),
        // A custom command on Windows may be a shim `needs_shell` didn't catch;
        // retry through `cmd /c` before giving up.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound && windows && !needs_shell(&spec.program) => {
            let mut via_cmd = tokio::process::Command::new("cmd");
            via_cmd.arg("/c").arg(&spec.program).args(&spec.args);
            configure(&mut via_cmd, spec);
            via_cmd.spawn().map_err(|e2| {
                NexError::Agent(format!(
                    "failed to spawn agent `{}`: {e2} (is it installed and on PATH?)",
                    spec.program
                ))
            })
        }
        Err(e) => Err(NexError::Agent(format!(
            "failed to spawn agent `{}`: {e} (is it installed and on PATH?)",
            spec.program
        ))),
    }
}

/// Common spawn configuration shared by the direct and `cmd /c` paths: piped
/// stdio (stderr is drained by the adapter — inheriting would deadlock the
/// child once the pipe buffer fills), working dir, extra env, kill-on-drop, and
/// (Windows) no console window.
fn configure(cmd: &mut tokio::process::Command, spec: &LaunchSpec) {
    cmd.current_dir(&spec.cwd)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .envs(&spec.env);

    #[cfg(windows)]
    {
        // Inherent on `tokio::process::Command` on Windows; prevents the npm
        // `.cmd` shim from flashing a console window in this GUI app.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::registry::{RegistryDistribution, RegistryNpxDistribution};

    fn entry(id: &str, npx: Option<RegistryNpxDistribution>) -> RegistryEntry {
        RegistryEntry {
            id: id.to_string(),
            name: id.to_string(),
            version: "1.0.0".to_string(),
            description: String::new(),
            icon: None,
            distribution: RegistryDistribution { binary: None, npx },
        }
    }

    fn npx(package: &str, args: &[&str]) -> RegistryNpxDistribution {
        RegistryNpxDistribution {
            package: package.to_string(),
            args: args.iter().map(|s| s.to_string()).collect(),
            env: HashMap::new(),
        }
    }

    #[test]
    fn shell_argv_wraps_npx_on_windows() {
        let args: Vec<String> = vec!["--yes".into(), "--".into(), "pkg@1.0.0".into()];
        let (program, wrapped) = shell_argv("npx", &args, true);
        assert_eq!(program, "cmd");
        assert_eq!(wrapped, vec!["/c", "npx", "--yes", "--", "pkg@1.0.0"]);
    }

    #[test]
    fn shell_argv_is_identity_off_windows() {
        let args: Vec<String> = vec!["--yes".into()];
        let (program, out) = shell_argv("npx", &args, false);
        assert_eq!(program, "npx");
        assert_eq!(out, vec!["--yes"]);
    }

    #[test]
    fn shell_argv_does_not_wrap_plain_binary() {
        let args: Vec<String> = vec!["acp".into()];
        let (program, out) = shell_argv("/opt/agent/agent", &args, true);
        assert_eq!(program, "/opt/agent/agent");
        assert_eq!(out, vec!["acp"]);
    }

    #[test]
    fn shell_argv_wraps_cmd_shim() {
        let (program, _) = shell_argv("mytool.cmd", &[], true);
        assert_eq!(program, "cmd");
    }

    #[test]
    fn resolve_registry_builds_npx_command_verbatim_package() {
        let e = entry("codex-acp", Some(npx("@agentclientprotocol/codex-acp@1.1.7", &[])));
        let spec = resolve_registry(&e, "/work").unwrap();
        assert_eq!(spec.program, "npx");
        assert_eq!(spec.args, vec!["--yes", "--", "@agentclientprotocol/codex-acp@1.1.7"]);
        assert_eq!(spec.cwd, "/work");
        // Not claude-acp, so no ANTHROPIC_API_KEY override.
        assert!(!spec.env.contains_key("ANTHROPIC_API_KEY"));
    }

    #[test]
    fn resolve_registry_appends_entry_args() {
        let e = entry("gemini", Some(npx("@google/gemini-cli@0.52.0", &["--acp"])));
        let spec = resolve_registry(&e, "/w").unwrap();
        assert_eq!(spec.args, vec!["--yes", "--", "@google/gemini-cli@0.52.0", "--acp"]);
    }

    #[test]
    fn resolve_registry_clears_anthropic_key_for_claude() {
        let e = entry("claude-acp", Some(npx("@agentclientprotocol/claude-agent-acp@0.62.0", &[])));
        let spec = resolve_registry(&e, "/w").unwrap();
        assert_eq!(spec.env.get("ANTHROPIC_API_KEY").map(String::as_str), Some(""));
    }

    #[test]
    fn resolve_registry_spawns_binary_from_platform_target() {
        use crate::agent::registry::RegistryBinaryTarget;
        let mut binary = HashMap::new();
        binary.insert(
            current_platform_key(),
            RegistryBinaryTarget {
                archive: "https://x/a.zip".to_string(),
                cmd: "my-agent".to_string(),
                args: vec!["--acp".to_string()],
                sha256: None,
                env: HashMap::new(),
            },
        );
        let e = RegistryEntry {
            id: "cursor".to_string(),
            name: "Cursor".to_string(),
            version: "1.0.0".to_string(),
            description: String::new(),
            icon: None,
            distribution: RegistryDistribution { binary: Some(binary), npx: None },
        };
        let spec = resolve_registry(&e, "/w").unwrap();
        assert_eq!(spec.program, "my-agent");
        assert_eq!(spec.args, vec!["--acp"]);
    }

    #[test]
    fn resolve_registry_errors_on_missing_platform_target() {
        use crate::agent::registry::RegistryBinaryTarget;
        let mut binary = HashMap::new();
        binary.insert(
            "unsupported-os-arch".to_string(),
            RegistryBinaryTarget {
                archive: "https://x/a.zip".to_string(),
                cmd: "x".to_string(),
                args: vec![],
                sha256: None,
                env: HashMap::new(),
            },
        );
        let e = RegistryEntry {
            id: "cursor".to_string(),
            name: "Cursor".to_string(),
            version: "1.0.0".to_string(),
            description: String::new(),
            icon: None,
            distribution: RegistryDistribution { binary: Some(binary), npx: None },
        };
        let err = resolve_registry(&e, "/w").unwrap_err();
        let msg = format!("{err}");
        assert!(msg.contains("has no binary for platform"), "error should mention missing platform: {msg}");
    }

    #[test]
    fn resolve_custom_splits_command() {
        let spec = resolve_custom("my-agent --acp --verbose", HashMap::new(), "/w").unwrap();
        assert_eq!(spec.program, "my-agent");
        assert_eq!(spec.args, vec!["--acp", "--verbose"]);
    }

    #[test]
    fn resolve_custom_rejects_empty() {
        assert!(resolve_custom("   ", HashMap::new(), "/w").is_err());
    }
}
