//! Agent process launch — turning a registry entry (or a user's custom server)
//! into a concrete OS command, then spawning it.
//!
//! Clean-room port of the launch *mechanism* from Zed's
//! `crates/project/src/{external_agents,agent_server_store}.rs` and
//! `crates/agent_servers/src/custom.rs`. Two material deviations from the
//! original Zed design:
//!
//! - We do **not** shell out to `npx`. Registry `npx` entries are turned into
//!   `(node, bin)` pairs by `PackageCache::resolve_npx`, and the agent is
//!   spawned as `<node> <bin-path> <args...>`. This dodges the GUI-PATH problem
//!   on macOS where the user's login shell env is invisible to `.app` bundles.
//! - We manage our own Node runtime (newest LTS discovered from
//!   `nodejs.org/dist/index.json`, downloaded on first use), so the user
//!   does not need a system Node just to run Nex.

use std::collections::HashMap;
use std::ffi::OsStr;
use std::io;
use std::path::{Path, PathBuf};

use super::package_cache::PackageResolver;
use super::registry::RegistryEntry;
use super::binary::BinaryCache;
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
/// For `npx` distributions we install the package into a per-agent cache
/// dir (via `PackageResolver::resolve_npx`) and emit a `LaunchSpec` that
/// runs `<node> <bin-path> <args...>` directly. For `binary` distributions
/// we reuse the existing `BinaryCache` download/extract path.
///
/// `shell_path` is the user's login-shell PATH (from `ShellEnv`). Packaged
/// GUI apps inherit a stripped process PATH that omits Homebrew / nvm /
/// etc.; agents need the real PATH so tools like `git` resolve.
pub async fn resolve_registry(
    entry: &RegistryEntry,
    cwd: &str,
    binary_cache: &BinaryCache,
    package_resolver: &dyn PackageResolver,
    shell_env: &HashMap<String, String>,
) -> Result<LaunchSpec, NexError> {
    if let Some(npx) = &entry.distribution.npx {
        let resolved = package_resolver.resolve_npx(entry, npx).await?;
        let mut args = Vec::with_capacity(1 + npx.args.len());
        args.push(resolved.executable_path.to_string_lossy().into_owned());
        args.extend(npx.args.iter().cloned());

        let mut env = npx.env.clone();
        // Per-agent env override (e.g. clear ANTHROPIC_API_KEY for claude-acp)
        // is applied at the **final** spawn env, never during `npm install`.
        apply_per_id_env(&entry.id, &mut env);
        // Layer the full shell/project env first so credentials such as
        // `CODEX_API_KEY` survive the GUI boundary, then prepend the managed
        // Node dir onto PATH so agents also see our runtime.
        apply_shell_env(&mut env, shell_env);
        env.extend(node_path_env_overlay(
            &resolved.node_path,
            shell_env
                .get("PATH")
                .map(OsStr::new)
                .unwrap_or_else(|| OsStr::new("")),
        ));

        log::info!(
            "resolved npx agent `{}`: {} {}",
            entry.id,
            resolved.node_path.display(),
            args.join(" ")
        );
        return Ok(LaunchSpec {
            program: resolved.node_path.to_string_lossy().into_owned(),
            args,
            env,
            cwd: cwd.to_string(),
        });
    }

    if let Some(binaries) = &entry.distribution.binary {
        let key = registry_platform_key();
        if let Some(target) = binaries.get(&key) {
            let exe_path = binary_cache
                .ensure_installed(entry, target, &key)
                .await?;
            let program = exe_path.to_string_lossy().to_string();
            let args = target.args.clone();
            let mut env = target.env.clone();
            apply_per_id_env(&entry.id, &mut env);
            // Binary agents (e.g. Cursor) also need the login-shell PATH —
            // without it `git: command not found` in packaged builds.
            apply_shell_env(&mut env, shell_env);
            log::info!(
                "resolved binary agent `{}`: {} {}",
                entry.id,
                program,
                args.join(" ")
            );
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

/// Build the env map used when spawning `<node> <bin> <args>`.
/// Prepends the node-managed dir onto the login-shell PATH (not a PATH that
/// contains only the node dir — that made `git` invisible in .app builds).
fn node_path_env_overlay(node_path: &Path, shell_path: &OsStr) -> HashMap<String, String> {
    super::node_runtime::npm_command_env_with_base(node_path, Some(shell_path))
}

/// Layer the captured login/project shell env under any per-agent overrides.
///
/// Existing keys in `env` win (the agent's explicit config should override the
/// shell), but any missing variables from the captured shell snapshot are
/// copied through. This is what lets GUI-spawned agents inherit credentials
/// such as `CODEX_API_KEY` / `OPENAI_API_KEY` in addition to PATH.
fn apply_shell_env(env: &mut HashMap<String, String>, shell_env: &HashMap<String, String>) {
    for (k, v) in shell_env {
        env.entry(k.clone()).or_insert_with(|| v.clone());
    }
}

/// Platform key used to index `distribution.binary` in the shared ACP
/// registry (same schema as Zed). Distinct from Node's release triples
/// (`darwin-arm64` / `win-x64` in `node_runtime::current_platform_key`).
///
/// Registry examples: `darwin-aarch64`, `darwin-x86_64`, `linux-aarch64`,
/// `linux-x86_64`, `windows-aarch64`, `windows-x86_64`.
pub fn registry_platform_key() -> String {
    let (os, arch) = match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => ("darwin", "aarch64"),
        ("macos", "x86_64") => ("darwin", "x86_64"),
        ("windows", "aarch64") => ("windows", "aarch64"),
        ("windows", "x86_64") => ("windows", "x86_64"),
        ("linux", "aarch64") => ("linux", "aarch64"),
        ("linux", "x86_64") => ("linux", "x86_64"),
        (other, other_arch) => (other, other_arch),
    };
    format!("{os}-{arch}")
}

/// Resolves a user-defined custom server (a raw command string) into a launch
/// spec. Unlike registry agents this string is the *user's* input, not a Nex
/// guess, so splitting it on whitespace is appropriate.
pub fn resolve_custom(
    command: &str,
    mut env: HashMap<String, String>,
    cwd: &str,
    shell_env: &HashMap<String, String>,
) -> Result<LaunchSpec, NexError> {
    let mut parts = command.split_whitespace();
    let program = parts
        .next()
        .ok_or_else(|| NexError::Agent("empty agent command".to_string()))?
        .to_string();
    let args: Vec<String> = parts.map(str::to_string).collect();
    apply_shell_env(&mut env, shell_env);
    Ok(LaunchSpec { program, args, env, cwd: cwd.to_string() })
}

/// Per-agent env overrides, mirroring Zed's `custom.rs`.
fn apply_per_id_env(agent_id: &str, env: &mut HashMap<String, String>) {
    if agent_id == CLAUDE_AGENT_ID {
        env.insert("ANTHROPIC_API_KEY".to_string(), String::new());
    }
}

/// True when `program` is an npm/node shim that Windows can only run through a
/// shell (`npx`/`npm`/`node` resolve to `.cmd` batch files; `CreateProcess`
/// cannot execute those directly). Absolute `node.exe` paths are NOT wrapped
/// — the comparison is against the entire string, so `/opt/homebrew/bin/node`
/// and `C:\nodejs\node.exe` both fall through to direct spawn.
fn needs_shell(program: &str) -> bool {
    let p = program.to_ascii_lowercase();
    p == "npx" || p == "npm" || p == "node" || p.ends_with(".cmd") || p.ends_with(".bat")
}

/// Computes the real `(program, args)` to hand the OS, wrapping shell shims in
/// `cmd /c` on Windows.
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
    let program_path = PathBuf::from(&program);

    let mut cmd = tokio::process::Command::new(&program);
    cmd.args(&args);
    configure(&mut cmd, spec);

    match cmd.spawn() {
        Ok(child) => Ok(child),
        // A custom command on Windows may be a shim `needs_shell` didn't catch;
        // retry through `cmd /c` before giving up.
        Err(e) if e.kind() == io::ErrorKind::NotFound && windows && !needs_shell(&spec.program) => {
            let mut via_cmd = tokio::process::Command::new("cmd");
            via_cmd.arg("/c").arg(&spec.program).args(&spec.args);
            configure(&mut via_cmd, spec);
            via_cmd.spawn().map_err(|e2| classify_spawn_error(&program_path, &e2))
        }
        Err(e) => Err(classify_spawn_error(&program_path, &e)),
    }
}

/// Map a low-level `io::Error` from `Command::spawn` into a user-actionable
/// `NexError`. Distinguishes "node missing" from "bin missing" so the UI
/// can guide the user to the right remediation.
pub fn classify_spawn_error(program: &Path, err: &io::Error) -> NexError {
    if err.kind() == io::ErrorKind::NotFound {
        if path_targets_node(program) {
            return NexError::AgentNotInstalled {
                what: "node",
                hint: format!(
                    "Nex could not find a usable Node.js runtime at `{}`. \
                     Install Node 22+ from https://nodejs.org, or via \
                     `fnm install 22` / `volta install node@22`, then restart Nex.",
                    program.display()
                ),
            };
        }
        return NexError::AgentNotInstalled {
            what: "agent executable",
            hint: format!(
                "Could not locate the agent executable at `{}`. \
                 The npm package may have failed to install; check the Nex log for npm errors.",
                program.display()
            ),
        };
    }
    NexError::Agent(format!("failed to spawn `{}`: {}", program.display(), err))
}

/// Heuristic: does `program` look like a Node binary? Splits on both `/`
/// and `\` so the test (and any future Windows path that comes through
/// `Path::new` on a non-Windows host) still detects the right tail.
fn path_targets_node(program: &Path) -> bool {
    let path_str = program.to_string_lossy();
    let last = path_str
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or("");
    let lower = last.to_ascii_lowercase();
    lower == "node" || lower == "node.exe" || lower.starts_with("node-")
}

/// Common spawn configuration shared by the direct and `cmd /c` paths: piped
/// stdio, working dir, extra env, kill-on-drop, and (Windows) no console window.
fn configure(cmd: &mut tokio::process::Command, spec: &LaunchSpec) {
    cmd.current_dir(&spec.cwd)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .envs(&spec.env);

    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::package_cache::ResolvedNpx;
    use crate::agent::registry::{RegistryDistribution, RegistryNpxDistribution};
    use async_trait::async_trait;
    use std::path::PathBuf;

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

    fn test_cache() -> BinaryCache {
        BinaryCache::new(&std::env::temp_dir().join("nex-test-binary-cache"))
    }

    /// Login-shell PATH stand-in used by resolve_* tests.
    fn test_shell_path() -> &'static OsStr {
        OsStr::new("/opt/homebrew/bin:/usr/bin:/bin")
    }

    /// Full shell/project env stand-in used by resolve_* tests.
    fn test_shell_env() -> HashMap<String, String> {
        let mut env = HashMap::new();
        env.insert("PATH".to_string(), test_shell_path().to_string_lossy().into_owned());
        env.insert("CODEX_API_KEY".to_string(), "test-key".to_string());
        env
    }

    /// Test double for `PackageResolver` that returns a canned `ResolvedNpx`
    /// without ever touching the filesystem. The optional `installed_version`
    /// field lets tests pin what `newest_installed_version` reports.
    struct FakePackageResolver {
        resolved: Result<ResolvedNpx, NexError>,
        installed_version: Option<String>,
    }

    impl FakePackageResolver {
        fn ok(resolved: ResolvedNpx) -> Self {
            Self { resolved: Ok(resolved), installed_version: None }
        }
        fn err(err: NexError) -> Self {
            Self { resolved: Err(err), installed_version: None }
        }
        #[allow(dead_code)]
        fn with_installed(mut self, ver: Option<&str>) -> Self {
            self.installed_version = ver.map(String::from);
            self
        }
    }

    #[async_trait]
    impl PackageResolver for FakePackageResolver {
        async fn resolve_npx(
            &self,
            _entry: &RegistryEntry,
            _npx: &RegistryNpxDistribution,
        ) -> Result<ResolvedNpx, NexError> {
            match &self.resolved {
                Ok(r) => Ok(ResolvedNpx {
                    node_path: r.node_path.clone(),
                    executable_path: r.executable_path.clone(),
                    first_install: r.first_install,
                }),
                Err(e) => Err(match e {
                    NexError::Agent(s) => NexError::Agent(s.clone()),
                    NexError::AgentNotInstalled { what, hint } => NexError::AgentNotInstalled {
                        what,
                        hint: hint.clone(),
                    },
                    other => NexError::Agent(other.to_string()),
                }),
            }
        }

        fn newest_installed_version(&self, _agent_id: &str) -> Option<String> {
            self.installed_version.clone()
        }
    }

    fn fake_resolved(node: &str, bin: &str) -> ResolvedNpx {
        ResolvedNpx {
            node_path: PathBuf::from(node),
            executable_path: PathBuf::from(bin),
            first_install: true,
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
    fn shell_argv_does_not_wrap_absolute_node() {
        let (program, _) = shell_argv("/opt/homebrew/bin/node", &["x".into()], true);
        assert_eq!(program, "/opt/homebrew/bin/node");
    }

    #[test]
    fn shell_argv_does_not_wrap_absolute_node_exe() {
        let (program, _) = shell_argv(r"C:\nodejs\node.exe", &["x".into()], true);
        assert_eq!(program, r"C:\nodejs\node.exe");
    }

    #[test]
    fn shell_argv_wraps_cmd_shim() {
        let (program, _) = shell_argv("mytool.cmd", &[], true);
        assert_eq!(program, "cmd");
    }

    #[test]
    fn needs_shell_does_not_match_absolute_node() {
        assert!(!needs_shell("/opt/homebrew/bin/node"));
        assert!(!needs_shell(r"C:\Program Files\nodejs\node.exe"));
    }

    #[tokio::test]
    async fn resolve_registry_uses_resolver_for_npx() {
        let e = entry("codex-acp", Some(npx("@agentclientprotocol/codex-acp@1.1.7", &[])));
        let resolver = FakePackageResolver::ok(fake_resolved(
            "/opt/homebrew/bin/node",
            "/cache/agent-packages/_codex-acp/_pkg_1.1.7/node-/node_modules/.../cli.js",
        ));
        let spec = resolve_registry(&e, "/work", &test_cache(), &resolver, &test_shell_env()).await.unwrap();
        assert_eq!(spec.program, "/opt/homebrew/bin/node");
        assert!(spec.args[0].ends_with("cli.js"));
        assert_eq!(spec.cwd, "/work");
        assert!(!spec.env.contains_key("ANTHROPIC_API_KEY"));
        let path = spec.env.get("PATH").expect("PATH set for agent");
        assert!(
            path.starts_with("/opt/homebrew/bin"),
            "node dir should lead PATH: {path}"
        );
        assert!(
            path.contains("/usr/bin"),
            "login-shell PATH must be preserved so git resolves: {path}"
        );
    }

    #[tokio::test]
    async fn resolve_registry_appends_entry_args() {
        let e = entry("gemini", Some(npx("@google/gemini-cli@0.52.0", &["--acp"])));
        let resolver = FakePackageResolver::ok(fake_resolved("/usr/bin/node", "/cache/bin"));
        let spec = resolve_registry(&e, "/w", &test_cache(), &resolver, &test_shell_env()).await.unwrap();
        // args: [bin, --acp]
        assert_eq!(spec.args.len(), 2);
        assert_eq!(spec.args[0], "/cache/bin");
        assert_eq!(spec.args[1], "--acp");
    }

    #[tokio::test]
    async fn resolve_registry_clears_anthropic_key_for_claude() {
        let e = entry("claude-acp", Some(npx("@agentclientprotocol/claude-agent-acp@0.62.0", &[])));
        let resolver = FakePackageResolver::ok(fake_resolved("/usr/bin/node", "/cache/bin"));
        let spec = resolve_registry(&e, "/w", &test_cache(), &resolver, &test_shell_env()).await.unwrap();
        assert_eq!(spec.env.get("ANTHROPIC_API_KEY").map(String::as_str), Some(""));
    }

    #[tokio::test]
    async fn resolve_registry_propagates_package_resolver_error() {
        let e = entry("claude-acp", Some(npx("@agentclientprotocol/claude-agent-acp@0.62.0", &[])));
        let resolver = FakePackageResolver::err(NexError::AgentNotInstalled {
            what: "npm package",
            hint: "synthetic failure".into(),
        });
        let err = resolve_registry(&e, "/w", &test_cache(), &resolver, &test_shell_env()).await.unwrap_err();
        match err {
            NexError::AgentNotInstalled { what, hint } => {
                assert_eq!(what, "npm package");
                assert_eq!(hint, "synthetic failure");
            }
            other => panic!("expected AgentNotInstalled, got {other:?}"),
        }
    }

    #[test]
    fn registry_platform_key_uses_darwin_on_macos() {
        let key = registry_platform_key();
        assert!(
            !key.starts_with("macos-"),
            "registry key must not use Rust's macos OS name: {key}"
        );
        #[cfg(target_os = "macos")]
        {
            assert!(
                key.starts_with("darwin-"),
                "macOS should map to darwin-*: {key}"
            );
            assert!(
                key.ends_with("-aarch64") || key.ends_with("-x86_64"),
                "unexpected arch in registry platform key: {key}"
            );
            // Must NOT use Node release naming (arm64/x64) — ACP registry
            // keys are aarch64/x86_64 (see shared registry.json).
            assert!(
                !key.contains("arm64") && !key.ends_with("-x64"),
                "registry key must not use Node triples, got: {key}"
            );
        }
    }

    /// Binary agents look up `distribution.binary` with ACP/Zed triples,
    /// not Node CDN names. Mixing them yields
    /// `has no binary for platform darwin-arm64 (available: [..., darwin-aarch64])`.
    #[test]
    fn registry_platform_key_matches_acp_triples() {
        let key = registry_platform_key();
        assert!(
            matches!(
                key.as_str(),
                "darwin-aarch64"
                    | "darwin-x86_64"
                    | "linux-aarch64"
                    | "linux-x86_64"
                    | "windows-aarch64"
                    | "windows-x86_64"
            ),
            "registry platform key `{key}` doesn't match any ACP binary triple"
        );
    }

    /// Guards against reusing Node's `win-x64` naming for registry lookup.
    #[cfg(windows)]
    #[test]
    fn registry_platform_key_uses_windows_prefix_on_windows() {
        let key = registry_platform_key();
        assert!(
            key.starts_with("windows-"),
            "Windows registry key should use `windows-` prefix, got: {key}"
        );
        assert!(
            !key.starts_with("win-"),
            "Windows registry key must NOT use Node's `win-` prefix: {key}"
        );
    }

    #[tokio::test]
    async fn resolve_registry_errors_on_missing_platform_target() {
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
        let resolver = FakePackageResolver::ok(fake_resolved("/usr/bin/node", "/cache/bin"));
        let err = resolve_registry(&e, "/w", &test_cache(), &resolver, &test_shell_env()).await.unwrap_err();
        let msg = format!("{err}");
        assert!(msg.contains("has no binary for platform"), "error should mention missing platform: {msg}");
    }

    #[test]
    fn resolve_custom_splits_command() {
        let spec = resolve_custom("my-agent --acp --verbose", HashMap::new(), "/w", &test_shell_env()).unwrap();
        assert_eq!(spec.program, "my-agent");
        assert_eq!(spec.args, vec!["--acp", "--verbose"]);
        assert_eq!(
            spec.env.get("PATH").map(String::as_str),
            Some("/opt/homebrew/bin:/usr/bin:/bin")
        );
    }

    #[test]
    fn resolve_custom_inherits_shell_credentials() {
        let spec = resolve_custom("my-agent --acp", HashMap::new(), "/w", &test_shell_env()).unwrap();
        assert_eq!(spec.env.get("CODEX_API_KEY").map(String::as_str), Some("test-key"));
        assert!(spec.env.contains_key("PATH"));
    }

    #[tokio::test]
    async fn resolve_registry_inherits_shell_credentials_for_npx_agents() {
        let e = entry("codex-acp", Some(npx("@agentclientprotocol/codex-acp@1.1.14", &[])));
        let resolver = FakePackageResolver::ok(fake_resolved(
            "/opt/homebrew/bin/node",
            "/cache/agent-packages/_codex-acp/_pkg_1.1.14/node_modules/@agentclientprotocol/codex-acp/dist/index.js",
        ));
        let spec = resolve_registry(&e, "/work", &test_cache(), &resolver, &test_shell_env()).await.unwrap();
        assert_eq!(spec.env.get("CODEX_API_KEY").map(String::as_str), Some("test-key"));
        assert!(spec.env.contains_key("PATH"));
    }

    #[test]
    fn resolve_custom_rejects_empty() {
        assert!(resolve_custom("   ", HashMap::new(), "/w", &test_shell_env()).is_err());
    }

    #[test]
    fn classify_spawn_error_known_node_path() {
        let err = io::Error::new(io::ErrorKind::NotFound, "nope");
        let program = Path::new("/opt/homebrew/bin/node");
        let classified = classify_spawn_error(program, &err);
        match classified {
            NexError::AgentNotInstalled { what, .. } => assert_eq!(what, "node"),
            other => panic!("expected AgentNotInstalled(node), got {other:?}"),
        }
    }

    #[test]
    fn classify_spawn_error_known_node_exe() {
        let err = io::Error::new(io::ErrorKind::NotFound, "nope");
        let program = Path::new(r"C:\nodejs\node.exe");
        let classified = classify_spawn_error(program, &err);
        match classified {
            NexError::AgentNotInstalled { what, .. } => assert_eq!(what, "node"),
            other => panic!("expected AgentNotInstalled(node), got {other:?}"),
        }
    }

    #[test]
    fn classify_spawn_error_unknown_binary() {
        let err = io::Error::new(io::ErrorKind::NotFound, "nope");
        let program = Path::new("/cache/agent-packages/_x/.../bin.js");
        let classified = classify_spawn_error(program, &err);
        match classified {
            NexError::AgentNotInstalled { what, .. } => assert_eq!(what, "agent executable"),
            other => panic!("expected AgentNotInstalled(agent executable), got {other:?}"),
        }
    }

    #[test]
    fn classify_spawn_error_other_kind() {
        let err = io::Error::new(io::ErrorKind::PermissionDenied, "nope");
        let program = Path::new("/usr/bin/node");
        let classified = classify_spawn_error(program, &err);
        assert!(matches!(classified, NexError::Agent(_)));
    }
}
