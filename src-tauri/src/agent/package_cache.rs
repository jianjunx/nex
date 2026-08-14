//! npm package cache and install orchestration.
//!
//! Registry `npx` entries are turned into a fully-resolved `(node, bin)`
//! pair: install the package into a per-agent subdir of `app_data_dir` via
//! `npm install`, then read the package's `bin` field directly. The agent
//! itself is spawned as `<node> <bin-path>` — no `npx` in the picture.
//!
//! Mirrors `binary.rs`'s shape (cache root + version-keyed subdirs +
//! `.nex-install-ok` marker) so the existing convention of "first-use install,
//! forever-reuse" applies here too.
//!
//! Inflight dedup: concurrent `resolve_npx` calls for the same package
//! spec share a single `npm install` via a `tokio::sync::OnceCell` — this
//! is the **one** place Nex uses `tokio::sync::Mutex` (an acceptable
//! exception to the "std::sync::Mutex only" house style, since deduping
//! across awaits requires an async-aware lock).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use serde_json::Value as JsonValue;
use tokio::sync::{Mutex as AsyncMutex, OnceCell};

use super::node_runtime::{NodeRuntime, NodeRuntimeHandle};
use super::registry::{RegistryEntry, RegistryNpxDistribution};
use crate::error::NexError;

/// Total hard cap for one package install, including registry fallback.
const INSTALL_TIMEOUT: Duration = Duration::from_secs(10 * 60);
/// Leave half of the total budget for npmjs if the mirror stalls completely.
const MIRROR_ATTEMPT_TIMEOUT: Duration = Duration::from_secs(5 * 60);

/// Prefer the China-friendly mirror. npmjs remains the automatic fallback
/// when the mirror is unreachable or has not synced a new package yet.
const NPM_MIRROR_REGISTRY: &str = "https://registry.npmmirror.com";
const NPM_OFFICIAL_REGISTRY: &str = "https://registry.npmjs.org";

/// Keep this many recent spec versions per agent id when sweeping old
/// caches. The newest is always the live install; older ones are kept just
/// in case a downgrade is requested. Three strikes a balance between disk
/// footprint and rollback flexibility.
const KEEP_RECENT_VERSIONS: usize = 3;

/// Write a pair of empty npmrc files used as `--userconfig` / `--globalconfig`.
///
/// Isolates the install from the host's stray `.npmrc`. The two paths **must**
/// be distinct: modern npm (`@npmcli/config`) refuses to load the same file
/// as both user and global ("double-loading config"). Null devices are not
/// used — on Windows relative `NUL` resolves under cwd to
/// `<install_dir>\NUL`, and pointing both flags at that path trips the
/// double-load check; `/dev/null` also fails with ENOENT on Windows.
fn write_empty_npmrc_pair(dir: &Path) -> Result<(PathBuf, PathBuf), NexError> {
    let user_rc = dir.join(".nex-npmrc-user");
    let global_rc = dir.join(".nex-npmrc-global");
    std::fs::write(&user_rc, "").map_err(|e| {
        NexError::Agent(format!("failed to write empty user npmrc: {e}"))
    })?;
    std::fs::write(&global_rc, "").map_err(|e| {
        NexError::Agent(format!("failed to write empty global npmrc: {e}"))
    })?;
    Ok((user_rc, global_rc))
}

/// A fully-resolved `npx` distribution: the absolute node path to use as
/// the process, and the absolute path to the package's bin script.
#[derive(Clone, Debug)]
pub struct ResolvedNpx {
    pub node_path: PathBuf,
    pub executable_path: PathBuf,
    /// True if this call actually performed (or waited for) the install;
    /// false if the cache marker was already present. Used by the ACP layer
    /// to choose between a short and a long handshake timeout.
    pub first_install: bool,
}

/// Indirection so `launch.rs` can take a `&dyn PackageResolver` and tests
/// can pass a fake.
#[async_trait]
pub trait PackageResolver: Send + Sync {
    async fn resolve_npx(
        &self,
        entry: &RegistryEntry,
        npx: &RegistryNpxDistribution,
    ) -> Result<ResolvedNpx, NexError>;

    /// Version of the most-recently-used cached install for `agent_id`, or
    /// `None` if no install is cached. Surfaced to the UI so it can render
    /// an "update available" badge against the registry's latest version.
    fn newest_installed_version(&self, agent_id: &str) -> Option<String>;
}

type Inflight = Arc<OnceCell<Result<ResolvedNpx, NexError>>>;

/// Production resolver. Constructs an install root per (sanitized id +
/// sanitized package spec) so the same registry entry with a bumped version
/// doesn't collide with a previous install.
#[derive(Clone)]
pub struct PackageCache {
    root: PathBuf,
    /// Lazily-resolved Node runtime. We hold the *handle* (not a resolved
    /// `Arc<dyn NodeRuntime>`) because the runtime may not be available at
    /// construction time — `PackageCache` blocks on `handle.get().await` only
    /// when an actual install is required.
    node_runtime: Arc<NodeRuntimeHandle>,
    /// Per-spec in-flight cell map. Mutated only on first call for a given
    /// key; thereafter the `OnceCell` short-circuits.
    inflight: Arc<AsyncMutex<HashMap<String, Inflight>>>,
}

impl PackageCache {
    pub fn new(app_data_dir: &Path, node_runtime: Arc<NodeRuntimeHandle>) -> Self {
        Self {
            root: app_data_dir.join("agent-packages"),
            node_runtime,
            inflight: Arc::new(AsyncMutex::new(HashMap::new())),
        }
    }

    /// Root for this specific `(id, spec)` pair, with node version as the
    /// leaf so Node major upgrades invalidate the cache automatically.
    async fn install_dir(&self, id: &str, spec: &str) -> Result<PathBuf, NexError> {
        let node_version = self.node_runtime.get().await;
        Ok(self
            .root
            .join(sanitize(id))
            .join(sanitize(spec))
            .join(format!("node-{node_version}", node_version = node_version.version())))
    }

    /// Installs exactly the registry version, deduplicating concurrent work.
    /// Failed attempts are evicted from the inflight map so retrying does not
    /// require restarting Nex.
    async fn ensure_current_install(
        &self,
        agent_id: &str,
        spec: &str,
        runtime: &Arc<dyn NodeRuntime>,
    ) -> Result<ResolvedNpx, NexError> {
        let install_dir = self.install_dir(agent_id, spec).await?;
        let marker = install_dir.join(".nex-install-ok");
        let version_file = install_dir.join(".nex-version");
        let key = format!("{}/{}", sanitize(agent_id), sanitize(spec));
        let cell = {
            let mut map = self.inflight.lock().await;
            map.entry(key.clone())
                .or_insert_with(|| Arc::new(OnceCell::new()))
                .clone()
        };

        let result = cell
            .get_or_init(|| async {
                self.do_install(&install_dir, spec, &InstallOptions::default(), runtime)
                    .await
            })
            .await
            .clone();

        if result.is_ok() {
            let _ = std::fs::write(&marker, "");
            if let Some(ver) = version_from_spec(spec) {
                let _ = std::fs::write(&version_file, ver);
            }
            let root = self.root.clone();
            tokio::spawn(async move {
                if let Err(e) = sweep_lru(&root, KEEP_RECENT_VERSIONS).await {
                    log::warn!("agent cache LRU sweep failed: {e}");
                }
            });
        } else {
            let mut map = self.inflight.lock().await;
            if map
                .get(&key)
                .map(|current| Arc::ptr_eq(current, &cell))
                .unwrap_or(false)
            {
                map.remove(&key);
            }
        }
        result
    }

    fn prefetch_current(&self, agent_id: String, spec: String, runtime: Arc<dyn NodeRuntime>) {
        let cache = self.clone();
        tokio::spawn(async move {
            match cache.ensure_current_install(&agent_id, &spec, &runtime).await {
                Ok(_) => log::info!("silently installed agent update `{agent_id}` ({spec})"),
                Err(e) => log::warn!(
                    "silent agent update failed for `{agent_id}` ({spec}); keeping cached version: {e}"
                ),
            }
        });
    }

    /// Installs through npmmirror first and retries eligible registry/network
    /// failures through npmjs. Both attempts share the ten-minute deadline.
    async fn do_install(
        &self,
        install_dir: &Path,
        spec: &str,
        options: &InstallOptions,
        runtime: &Arc<dyn NodeRuntime>,
    ) -> Result<ResolvedNpx, NexError> {
        let node_binary = runtime.binary_path();
        if node_binary.as_os_str().is_empty() {
            return Err(NexError::AgentNotInstalled {
                what: "node",
                hint: "No usable Node.js runtime. Install Node 22+ and restart Nex.".into(),
            });
        }
        // The Node distribution ships `npm-cli.js` next to its own `bin/node`
        // (Unix) or directly under `<root>/node_modules/` (Windows). The
        // exact path depends on the Node layout — see `resolve_npm_cli` for
        // the full list of candidate locations.
        let install_root = super::node_runtime::install_root_from_node(node_binary)?;
        let npm_cli = super::node_runtime::resolve_npm_cli(&install_root)?;

        let cache_dir = install_dir
            .parent() // .../<spec>
            .and_then(|p| p.parent()) // .../<id>
            .and_then(|p| p.parent()) // .../agent-packages
            .and_then(|p| p.parent()) // .../app_data_dir
            .ok_or_else(|| NexError::Agent("could not derive npm cache dir".into()))?
            .join("npm-cache");

        let deadline = Instant::now() + INSTALL_TIMEOUT;
        let node_path = node_binary.to_path_buf();
        let registries = [NPM_MIRROR_REGISTRY, NPM_OFFICIAL_REGISTRY];
        let mut mirror_failure: Option<String> = None;
        for (index, registry) in registries.iter().enumerate() {
            prepare_install_dir(install_dir)?;
            let (user_rc, global_rc) = write_empty_npmrc_pair(install_dir)?;
            let npm_args = npm_install_args(
                install_dir,
                &cache_dir,
                &user_rc,
                &global_rc,
                spec,
                registry,
                options,
            );
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(install_timeout_error(spec));
            }
            let attempt_timeout = if index == 0 {
                remaining.min(MIRROR_ATTEMPT_TIMEOUT)
            } else {
                remaining
            };

            match run_npm_install(
                node_binary,
                &npm_cli,
                &npm_args,
                install_dir,
                runtime,
                attempt_timeout,
            ).await {
                Ok(()) => break,
                Err(failure)
                    if index == 0
                        && failure.should_fallback_to_official()
                        && Instant::now() < deadline =>
                {
                    let detail = failure.summary();
                    log::warn!(
                        "npm mirror install failed for `{spec}` ({detail}); retrying via {NPM_OFFICIAL_REGISTRY}"
                    );
                    mirror_failure = Some(detail);
                }
                Err(failure) => {
                    return Err(failure.into_nex_error(spec, registry, mirror_failure.as_deref()));
                }
            }
        }

        // Read the bin from the freshly-installed package.json.
        let executable_path = read_package_executable_path(install_dir, spec)?;
        Ok(ResolvedNpx {
            node_path,
            executable_path,
            first_install: true,
        })
    }
}

fn prepare_install_dir(install_dir: &Path) -> Result<(), NexError> {
    if install_dir.exists() {
        std::fs::remove_dir_all(install_dir).map_err(|e| NexError::Agent(format!(
            "failed to wipe prior install dir: {e}"
        )))?;
    }
    std::fs::create_dir_all(install_dir).map_err(|e| NexError::Agent(format!(
        "failed to create install dir: {e}"
    )))
}

#[allow(clippy::too_many_arguments)]
fn npm_install_args(
    install_dir: &Path,
    cache_dir: &Path,
    user_rc: &Path,
    global_rc: &Path,
    spec: &str,
    registry: &str,
    options: &InstallOptions,
) -> Vec<String> {
    let mut args = vec![
        "install".to_string(),
        "--prefix".to_string(),
        install_dir.to_string_lossy().into_owned(),
        "--cache".to_string(),
        cache_dir.to_string_lossy().into_owned(),
        "--userconfig".to_string(),
        user_rc.to_string_lossy().into_owned(),
        "--globalconfig".to_string(),
        global_rc.to_string_lossy().into_owned(),
        "--registry".to_string(),
        registry.to_string(),
        "--save-exact".to_string(),
        "--no-audit".to_string(),
        "--no-fund".to_string(),
    ];
    if options.ignore_install_scripts {
        args.push("--ignore-scripts".to_string());
    }
    args.push(spec.to_string());
    args
}

#[derive(Debug)]
enum NpmInstallFailure {
    Spawn(std::io::Error),
    Timeout,
    Exit {
        status: std::process::ExitStatus,
        stdout: String,
        stderr: String,
    },
}

impl NpmInstallFailure {
    fn should_fallback_to_official(&self) -> bool {
        match self {
            Self::Timeout => true,
            Self::Spawn(_) => false,
            Self::Exit { stdout, stderr, .. } => {
                is_registry_failure_output(&format!("{stdout}\n{stderr}"))
            }
        }
    }

    fn summary(&self) -> String {
        match self {
            Self::Spawn(e) => format!("spawn error: {e}"),
            Self::Timeout => "timed out".to_string(),
            Self::Exit { status, stderr, stdout } => {
                let detail = if stderr.trim().is_empty() { stdout } else { stderr };
                format!("exit {status}: {}", detail.trim())
            }
        }
    }

    fn into_nex_error(
        self,
        spec: &str,
        registry: &str,
        mirror_failure: Option<&str>,
    ) -> NexError {
        match self {
            Self::Spawn(e) => NexError::Agent(format!("failed to spawn npm install: {e}")),
            Self::Timeout => install_timeout_error(spec),
            Self::Exit { status, stdout, stderr } => {
                let fallback = mirror_failure
                    .map(|detail| format!("\n  mirror failure: {detail}"))
                    .unwrap_or_default();
                NexError::Agent(format!(
                    "`npm install {spec}` via {registry} failed (exit {status}):\n  stderr: {}\n  stdout: {}{fallback}",
                    stderr.trim(),
                    stdout.trim(),
                ))
            }
        }
    }
}

fn is_registry_failure_output(output: &str) -> bool {
    let text = output.to_ascii_lowercase();
    [
        "eai_again", "enotfound", "econnreset", "econnrefused", "etimedout",
        "econnaborted", "err_socket", "err_ssl", "err_tls", "certificate",
        "self signed", "unable_to_verify", "socket hang up", "fetch failed",
        "network request", "network error", "e403", "403 forbidden", "e404",
        "404 not found", "e429", "429 too many requests", "e502", "e503",
        "e504", "bad gateway", "service unavailable", "gateway timeout",
        "eintegrity", "etarget", "no matching version",
    ]
    .iter()
    .any(|needle| text.contains(needle))
}

fn install_timeout_error(spec: &str) -> NexError {
    NexError::AgentNotInstalled {
        what: "npm package",
        hint: format!(
            "`npm install {spec}` did not complete within {}s. Check your network connection and try again.",
            INSTALL_TIMEOUT.as_secs()
        ),
    }
}

async fn run_npm_install(
    node_binary: &Path,
    npm_cli: &Path,
    npm_args: &[String],
    install_dir: &Path,
    runtime: &Arc<dyn NodeRuntime>,
    timeout: Duration,
) -> Result<(), NpmInstallFailure> {
    let mut cmd = tokio::process::Command::new(node_binary);
    cmd.arg(npm_cli).args(npm_args);
    cmd.envs(&runtime.npm_command_env());
    super::node_runtime::strip_inherited_npm_config_env(&mut cmd);
    cmd.current_dir(install_dir);
    cmd.stdin(std::process::Stdio::null());
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    crate::win_process::no_window_tokio(&mut cmd);
    cmd.kill_on_drop(true);

    let output = tokio::time::timeout(timeout, cmd.output())
        .await
        .map_err(|_| NpmInstallFailure::Timeout)?
        .map_err(NpmInstallFailure::Spawn)?;
    if output.status.success() {
        return Ok(());
    }
    Err(NpmInstallFailure::Exit {
        status: output.status,
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
    })
}

#[derive(Default, Clone)]
struct InstallOptions {
    ignore_install_scripts: bool,
}

#[async_trait]
impl PackageResolver for PackageCache {
    async fn resolve_npx(
        &self,
        entry: &RegistryEntry,
        npx: &RegistryNpxDistribution,
    ) -> Result<ResolvedNpx, NexError> {
        // Resolve the node runtime first. If it isn't available, every
        // downstream step (including the cache-marker fast path) would fail
        // anyway, so propagating the error here gives the user a clear
        // remediation.
        let runtime = self.node_runtime.get().await;
        let install_dir = self.install_dir(&entry.id, &npx.package).await?;

        // Fast path: marker present and the bin file still exists.
        if let Some(cached) = resolved_npx_at(&install_dir, &npx.package, runtime.binary_path()) {
            let _ = touch_marker(&install_dir.join(".nex-install-ok"));
            return Ok(cached);
        }

        // Registry updates never block a working cached agent. Install the
        // latest version silently; the exact-version fast path above switches
        // future sessions only after its success marker has been written.
        if let Some((cached, marker)) = newest_usable_npx_install(
            &self.root,
            &entry.id,
            &npx.package,
            runtime.binary_path(),
        ) {
            let _ = touch_marker(&marker);
            self.prefetch_current(entry.id.clone(), npx.package.clone(), runtime);
            return Ok(cached);
        }

        // Cold install: no usable version exists, so wait for installation.
        self.ensure_current_install(&entry.id, &npx.package, &runtime).await
    }

    fn newest_installed_version(&self, agent_id: &str) -> Option<String> {
        newest_installed_version(&self.root, agent_id)
    }
}

/// Returns the version of the most-recently-used installed spec for
/// `agent_id`, or `None` if no install is cached. Reads the `.nex-version`
/// sidecar written by `resolve_npx`. Used by the UI to decide whether
/// to render an "update available" badge against the registry's latest
/// version.
pub fn newest_installed_version(root: &Path, agent_id: &str) -> Option<String> {
    let agent_dir = root.join(sanitize(agent_id));
    if !agent_dir.is_dir() {
        return None;
    }
    // Current caches place markers in a `node-<version>/` child. Accept the
    // legacy direct layout too.
    let mut newest: Option<(std::time::SystemTime, PathBuf)> = None;
    if let Ok(entries) = std::fs::read_dir(&agent_dir) {
        for entry in entries.flatten() {
            if !entry.path().is_dir() {
                continue;
            }
            for install_dir in install_dirs_for_spec(&entry.path()) {
                let marker = install_dir.join(".nex-install-ok");
                let Ok(mtime) = std::fs::metadata(&marker).and_then(|m| m.modified()) else {
                    continue;
                };
                match &newest {
                    Some((prev, _)) if *prev >= mtime => {}
                    _ => newest = Some((mtime, install_dir)),
                }
            }
        }
    }
    let (_, install_dir) = newest?;
    let version_path = install_dir.join(".nex-version");
    std::fs::read_to_string(&version_path)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn resolved_npx_at(
    install_dir: &Path,
    package_spec: &str,
    node_binary: &Path,
) -> Option<ResolvedNpx> {
    if !install_dir.join(".nex-install-ok").is_file() {
        return None;
    }
    let executable_path = read_package_executable_path(install_dir, package_spec).ok()?;
    if !executable_path.is_file() {
        return None;
    }
    Some(ResolvedNpx {
        node_path: node_binary.to_path_buf(),
        executable_path,
        first_install: false,
    })
}

fn newest_usable_npx_install(
    root: &Path,
    agent_id: &str,
    package_spec: &str,
    node_binary: &Path,
) -> Option<(ResolvedNpx, PathBuf)> {
    let entries = std::fs::read_dir(root.join(sanitize(agent_id))).ok()?;
    let mut newest: Option<(std::time::SystemTime, ResolvedNpx, PathBuf)> = None;
    for spec_entry in entries.flatten() {
        if !spec_entry.path().is_dir() {
            continue;
        }
        for install_dir in install_dirs_for_spec(&spec_entry.path()) {
            let marker = install_dir.join(".nex-install-ok");
            let Ok(mtime) = std::fs::metadata(&marker).and_then(|m| m.modified()) else {
                continue;
            };
            let Some(resolved) = resolved_npx_at(&install_dir, package_spec, node_binary) else {
                continue;
            };
            match &newest {
                Some((previous, _, _)) if *previous >= mtime => {}
                _ => newest = Some((mtime, resolved, marker)),
            }
        }
    }
    newest.map(|(_, resolved, marker)| (resolved, marker))
}

fn install_dirs_for_spec(spec_dir: &Path) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if spec_dir.join(".nex-install-ok").is_file() {
        dirs.push(spec_dir.to_path_buf());
    }
    if let Ok(entries) = std::fs::read_dir(spec_dir) {
        dirs.extend(entries.flatten().filter_map(|entry| {
            let path = entry.path();
            let is_node_dir = entry.file_name().to_string_lossy().starts_with("node-");
            (is_node_dir && path.is_dir()).then_some(path)
        }));
    }
    dirs
}

/// Replaces characters that are trouble in filesystem paths. Mirrors
/// `binary.rs::sanitize` but is also exercised on npm package specs
/// (`@scope/name@version`).
///
/// **Don't use this for the actual `node_modules/<pkg>` directory name** —
/// npm preserves the `@scope/` prefix verbatim. Use
/// `package_name_from_spec` for that. This is OK for the *cache key*
/// (different `spec` strings get distinct cache subdirs), but a bug if
/// you ever pass it to `node_modules.join(...)`.
pub fn sanitize(s: &str) -> String {
    s.replace(['/', '\\', ':', '*', '?', '"', '<', '>', '|', ' ', '@'], "_")
}

/// Extract the npm package name (with `@scope/` preserved, `@version`
/// stripped) from an install spec. This is what npm uses as the directory
/// name under `node_modules/`:
///
/// - `pkg@1.0.0` → `pkg`
/// - `@scope/name@0.64.2` → `@scope/name`
/// - `pkg` (no version) → `pkg`
/// - `@scope/name` (no version) → `@scope/name`
///
/// The `package.json` and the `bin` script both live under this directory.
pub fn package_name_from_spec(spec: &str) -> &str {
    if let Some(stripped) = spec.strip_prefix('@') {
        // Scoped package: "@scope/name@version". We need the LAST "@" (the
        // one before the version), not the leading scope marker.
        if let Some(idx) = stripped.find('@') {
            &spec[..1 + idx]
        } else {
            spec
        }
    } else {
        // Unscoped: "name@version" or just "name".
        if let Some(idx) = spec.find('@') {
            &spec[..idx]
        } else {
            spec
        }
    }
}

/// Extract a parseable version suffix from an install spec. Returns `None`
/// when the spec has no `@version` or the suffix isn't a valid semver.
///
/// - `pkg@1.0.0` → `Some("1.0.0")`
/// - `@scope/name@0.64.2` → `Some("0.64.2")`
/// - `pkg` → `None`
/// - `@scope/name` → `None`
/// - `weird@not.a.version` → `None`
///
/// Used to write the `.nex-version` sidecar so the UI can show "you have
/// 0.64.2, registry says 0.65.0" without re-parsing the spec.
pub fn version_from_spec(spec: &str) -> Option<String> {
    use semver::Version;
    // The version is the last `@`-separated piece. `rsplit` gives us that
    // without manual scanning, and works for both `@scope/name@version`
    // and unscoped `name@version`.
    spec.rsplit('@')
        .next()
        .filter(|v| !v.is_empty())
        .filter(|v| Version::parse(v).is_ok())
        .map(String::from)
}

/// Update a file's mtime to "now". Used to bump `.nex-install-ok` on every
/// fast-path cache hit, so the LRU sweeper can sort by last-used.
///
/// We deliberately don't use the `filetime` crate to avoid adding another
/// dep — opening for write is enough to update mtime on Unix and macOS.
fn touch_marker(path: &Path) -> std::io::Result<()> {
    use std::io::Write;
    let mut f = std::fs::OpenOptions::new().write(true).open(path)?;
    f.write_all(b"")?;
    f.sync_data()?;
    Ok(())
}

/// Sweep agent caches under `root`, keeping only the `keep_recent` most
/// recently used spec dirs per agent id. Returns the number of dirs
/// removed. Best-effort: errors on individual dirs are logged but do not
/// abort the sweep.
async fn sweep_lru(root: &Path, keep_recent: usize) -> std::io::Result<usize> {
    // Move blocking I/O to a blocking task so we don't tie up the runtime.
    let root = root.to_path_buf();
    tokio::task::spawn_blocking(move || -> std::io::Result<usize> {
        if !root.exists() {
            return Ok(0);
        }
        let mut removed = 0usize;
        for agent_entry in std::fs::read_dir(&root)? {
            let agent_entry = agent_entry?;
            let agent_path = agent_entry.path();
            if !agent_path.is_dir() {
                continue;
            }
            // Markers live inside `node-<version>/` for current caches (or
            // directly in the spec dir for legacy caches).
            let mut specs: Vec<(std::time::SystemTime, PathBuf)> = Vec::new();
            for spec_entry in std::fs::read_dir(&agent_path)? {
                let spec_entry = spec_entry?;
                let spec_path = spec_entry.path();
                if !spec_path.is_dir() {
                    continue;
                }
                let newest_marker = install_dirs_for_spec(&spec_path)
                    .into_iter()
                    .filter_map(|dir| {
                        std::fs::metadata(dir.join(".nex-install-ok"))
                            .and_then(|m| m.modified())
                            .ok()
                    })
                    .max();
                if let Some(mtime) = newest_marker {
                    specs.push((mtime, spec_path));
                }
            }
            // Newest first.
            specs.sort_by_key(|(mtime, _)| std::cmp::Reverse(*mtime));
            for (_, stale_path) in specs.into_iter().skip(keep_recent) {
                match std::fs::remove_dir_all(&stale_path) {
                    Ok(()) => {
                        log::info!(
                            "evicted old agent cache: {}",
                            stale_path.display()
                        );
                        removed += 1;
                    }
                    Err(e) => {
                        log::warn!(
                            "failed to evict {}: {e}",
                            stale_path.display()
                        );
                    }
                }
            }
        }
        Ok(removed)
    })
    .await
    .map_err(|e| std::io::Error::other(format!("LRU sweep join error: {e}")))?
}

/// Read the `bin` field of a freshly-installed package and return the path
/// to the executable. Mirrors npx's selection rules: a single string `bin`
/// is normalized to `{<name>: <path>}`; when there are multiple bins, the
/// one matching the package's unscoped name wins; otherwise ambiguous.
///
/// `package_spec` is the install spec (`@scope/name@version`); only its
/// package-name portion is used to find the directory under `node_modules/`,
/// because npm strips the `@version` suffix when laying out the install.
pub fn read_package_executable_path(
    install_dir: &Path,
    package_spec: &str,
) -> Result<PathBuf, NexError> {
    let pkg_dir_name = package_name_from_spec(package_spec);
    let pkg_dir = install_dir.join("node_modules").join(pkg_dir_name);
    let pkg_json_path = pkg_dir.join("package.json");
    let raw = std::fs::read_to_string(&pkg_json_path).map_err(|e| NexError::Agent(format!(
        "missing package.json at {}: {e}",
        pkg_json_path.display()
    )))?;
    let pkg_json: JsonValue = serde_json::from_str(&raw).map_err(|e| NexError::Agent(format!(
        "invalid package.json at {}: {e}",
        pkg_json_path.display()
    )))?;
    let name = pkg_json
        .get("name")
        .and_then(|v| v.as_str())
        .ok_or_else(|| NexError::Agent(format!(
            "package.json at {} has no `name`",
            pkg_json_path.display()
        )))?
        .to_string();
    let bin_value = pkg_json.get("bin").ok_or_else(|| NexError::Agent(format!(
        "package `{name}` declares no `bin`"
    )))?;

    let bins: HashMap<String, String> = match bin_value {
        JsonValue::String(p) => {
            // npm normalizes "bin": "<path>" to { <name>: <path> }.
            HashMap::from([(name.clone(), p.clone())])
        }
        JsonValue::Object(obj) => obj
            .iter()
            .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
            .collect(),
        _ => return Err(NexError::Agent(format!(
            "package `{name}` has a malformed `bin` field"
        ))),
    };

    let selected = select_npx_bin(&bins, &name)?;
    Ok(pkg_dir.join(selected))
}

/// Mirror npx's bin-selection logic. Returns the relative bin path to run.
fn select_npx_bin(
    bins: &HashMap<String, String>,
    package_name: &str,
) -> Result<String, NexError> {
    match bins.len() {
        0 => Err(NexError::Agent(format!(
            "package `{package_name}` declares an empty `bin` map"
        ))),
        1 => Ok(bins.values().next().unwrap().clone()),
        _ => {
            // npx: 1) bin matching the package's unscoped name; 2) an alias
            // (a key whose value is shared with another key); 3) error.
            let unscoped = package_name
                .strip_prefix('@')
                .and_then(|s| s.split('/').nth(1))
                .unwrap_or(package_name);
            if let Some(p) = bins.get(unscoped) {
                return Ok(p.clone());
            }
            // Look for any two keys with the same value (alias).
            let mut by_value: HashMap<&String, Vec<&String>> = HashMap::new();
            for (k, v) in bins {
                by_value.entry(v).or_default().push(k);
            }
            for (_, ks) in by_value {
                if ks.len() > 1 {
                    return Ok(bins.get(ks[0]).unwrap().clone());
                }
            }
            Err(NexError::Agent(format!(
                "package `{package_name}` has ambiguous bin ({} keys, no unscoped match)",
                bins.len()
            )))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_replaces_troublesome_chars() {
        assert_eq!(sanitize("@scope/name@1.2.3"), "_scope_name_1.2.3");
        assert_eq!(sanitize("plain"), "plain");
        assert_eq!(sanitize("a/b\\c:d"), "a_b_c_d");
    }

    #[test]
    fn select_npx_bin_single_entry() {
        let mut bins = HashMap::new();
        bins.insert("claude".to_string(), "dist/cli.js".to_string());
        assert_eq!(
            select_npx_bin(&bins, "@scope/claude").unwrap(),
            "dist/cli.js"
        );
    }

    #[test]
    fn select_npx_bin_unscoped_name_match() {
        let mut bins = HashMap::new();
        bins.insert("claude".to_string(), "dist/claude.js".to_string());
        bins.insert("helper".to_string(), "dist/helper.js".to_string());
        assert_eq!(
            select_npx_bin(&bins, "@scope/claude").unwrap(),
            "dist/claude.js"
        );
    }

    #[test]
    fn select_npx_bin_alias_takes_precedence_over_ambiguity() {
        let mut bins = HashMap::new();
        bins.insert("foo".to_string(), "dist/cli.js".to_string());
        bins.insert("bar".to_string(), "dist/cli.js".to_string());
        // Two keys share a value -> alias, pick either (deterministic: the
        // first one in iteration order; in practice, npx does the same).
        let selected = select_npx_bin(&bins, "@scope/anything").unwrap();
        assert_eq!(selected, "dist/cli.js");
    }

    #[test]
    fn select_npx_bin_ambiguous_errors() {
        let mut bins = HashMap::new();
        bins.insert("foo".to_string(), "dist/foo.js".to_string());
        bins.insert("bar".to_string(), "dist/bar.js".to_string());
        // Package name doesn't match either key and there's no alias.
        let err = select_npx_bin(&bins, "@scope/other").unwrap_err();
        assert!(matches!(err, NexError::Agent(_)));
    }

    // ---- package_name_from_spec -------------------------------------

    #[test]
    fn package_name_strips_version_unscoped() {
        assert_eq!(package_name_from_spec("pkg@1.0.0"), "pkg");
        assert_eq!(package_name_from_spec("claude-code@2.3.4"), "claude-code");
    }

    #[test]
    fn package_name_preserves_scoped_form() {
        assert_eq!(
            package_name_from_spec("@agentclientprotocol/claude-agent-acp@0.64.2"),
            "@agentclientprotocol/claude-agent-acp"
        );
        assert_eq!(
            package_name_from_spec("@google/gemini-cli@0.52.0"),
            "@google/gemini-cli"
        );
    }

    #[test]
    fn package_name_handles_no_version() {
        assert_eq!(package_name_from_spec("pkg"), "pkg");
        assert_eq!(package_name_from_spec("@scope/name"), "@scope/name");
    }

    #[test]
    fn package_name_handles_pre_release_version() {
        assert_eq!(
            package_name_from_spec("foo@1.0.0-beta.1"),
            "foo"
        );
        assert_eq!(
            package_name_from_spec("@scope/name@2.0.0-rc.3+build.42"),
            "@scope/name"
        );
    }

    // ---- write_empty_npmrc_pair --------------------------------------

    #[test]
    fn write_empty_npmrc_pair_creates_distinct_empty_files() {
        let dir = tempfile::tempdir().unwrap();
        let (user_rc, global_rc) = write_empty_npmrc_pair(dir.path()).unwrap();
        assert_ne!(user_rc, global_rc);
        assert!(user_rc.is_file());
        assert!(global_rc.is_file());
        assert_eq!(std::fs::read_to_string(&user_rc).unwrap(), "");
        assert_eq!(std::fs::read_to_string(&global_rc).unwrap(), "");
        // Absolute-ish: parent is the install dir (not a bare "NUL" relative name).
        assert_eq!(user_rc.parent(), Some(dir.path()));
        assert_eq!(global_rc.parent(), Some(dir.path()));
    }

    #[test]
    fn npm_install_args_pin_requested_registry() {
        let dir = tempfile::tempdir().unwrap();
        let user_rc = dir.path().join("user.npmrc");
        let global_rc = dir.path().join("global.npmrc");
        let args = npm_install_args(
            dir.path(),
            &dir.path().join("cache"),
            &user_rc,
            &global_rc,
            "@scope/agent@1.2.3",
            NPM_MIRROR_REGISTRY,
            &InstallOptions::default(),
        );
        let registry_index = args.iter().position(|arg| arg == "--registry").unwrap();
        assert_eq!(args[registry_index + 1], NPM_MIRROR_REGISTRY);
        assert_eq!(args.last().map(String::as_str), Some("@scope/agent@1.2.3"));
    }

    #[test]
    fn registry_failures_trigger_official_fallback() {
        assert!(is_registry_failure_output("npm error code ENOTFOUND"));
        assert!(is_registry_failure_output("404 Not Found - package not synced"));
        assert!(is_registry_failure_output("504 Gateway Timeout"));
        assert!(is_registry_failure_output("ETARGET No matching version found"));
        assert!(!is_registry_failure_output("postinstall script exited with code 1"));
    }

    #[test]
    fn install_timeout_is_ten_minutes_with_mirror_budget() {
        assert_eq!(INSTALL_TIMEOUT, Duration::from_secs(600));
        assert_eq!(MIRROR_ATTEMPT_TIMEOUT, Duration::from_secs(300));
    }

    // ---- read_package_executable_path --------------------------------
    //
    // These tests mirror npm's actual layout: package.json goes under
    // `node_modules/<package-name>/`, where `<package-name>` is the unscoped
    // (or @scope/name) form, NOT the sanitized full spec. The earlier version
    // of these tests wrote to the wrong path because they pre-dated the
    // `package_name_from_spec` helper — see the fix for the nvm-on-macOS
    // layout bug.

    #[test]
    fn read_package_executable_path_unscoped_string_bin() {
        let dir = tempfile::tempdir().unwrap();
        let pkg = dir.path().join("node_modules").join("foo");
        std::fs::create_dir_all(&pkg).unwrap();
        std::fs::write(
            pkg.join("package.json"),
            r#"{"name":"foo","bin":"dist/cli.js"}"#,
        )
        .unwrap();
        let got = read_package_executable_path(dir.path(), "foo@1.0.0").unwrap();
        assert!(got.ends_with("node_modules/foo/dist/cli.js"), "got: {got:?}");
    }

    #[test]
    fn read_package_executable_path_scoped_string_bin() {
        // @scope/foo@1.0.0 → node_modules/@scope/foo/  (NOT node_modules/_scope_foo_1.0.0/)
        let dir = tempfile::tempdir().unwrap();
        let pkg = dir.path().join("node_modules/@scope/foo");
        std::fs::create_dir_all(&pkg).unwrap();
        std::fs::write(
            pkg.join("package.json"),
            r#"{"name":"@scope/foo","bin":"dist/cli.js"}"#,
        )
        .unwrap();
        let got = read_package_executable_path(dir.path(), "@scope/foo@1.0.0").unwrap();
        assert!(got.ends_with("node_modules/@scope/foo/dist/cli.js"), "got: {got:?}");
    }

    #[test]
    fn read_package_executable_path_scoped_object_bin_unscoped_match() {
        let dir = tempfile::tempdir().unwrap();
        let pkg = dir.path().join("node_modules/@scope/foo");
        std::fs::create_dir_all(&pkg).unwrap();
        std::fs::write(
            pkg.join("package.json"),
            r#"{"name":"@scope/foo","bin":{"foo":"dist/foo.js","helper":"dist/helper.js"}}"#,
        )
        .unwrap();
        let got = read_package_executable_path(dir.path(), "@scope/foo@1.0.0").unwrap();
        assert!(got.ends_with("dist/foo.js"));
    }

    #[test]
    fn read_package_executable_path_reports_real_npm_layout() {
        // Mirror exactly the path layout npm produces for a real install:
        //   /tmp/.../node_modules/@agentclientprotocol/claude-agent-acp/package.json
        let dir = tempfile::tempdir().unwrap();
        let pkg = dir.path().join("node_modules/@agentclientprotocol/claude-agent-acp");
        std::fs::create_dir_all(&pkg).unwrap();
        std::fs::write(
            pkg.join("package.json"),
            r#"{"name":"@agentclientprotocol/claude-agent-acp","bin":"dist/cli.js"}"#,
        )
        .unwrap();
        let got = read_package_executable_path(dir.path(), "@agentclientprotocol/claude-agent-acp@0.64.2").unwrap();
        assert!(got.ends_with("node_modules/@agentclientprotocol/claude-agent-acp/dist/cli.js"));
    }

    #[test]
    fn read_package_executable_path_errors_when_missing() {
        let dir = tempfile::tempdir().unwrap();
        let err = read_package_executable_path(dir.path(), "@scope/missing@1.0.0").unwrap_err();
        assert!(matches!(err, NexError::Agent(_)));
    }

    // ---- version_from_spec --------------------------------------------

    #[test]
    fn version_from_spec_extracts_unscoped() {
        assert_eq!(version_from_spec("pkg@1.0.0").as_deref(), Some("1.0.0"));
    }

    #[test]
    fn version_from_spec_extracts_scoped() {
        assert_eq!(
            version_from_spec("@agentclientprotocol/claude-agent-acp@0.64.2").as_deref(),
            Some("0.64.2")
        );
    }

    #[test]
    fn version_from_spec_handles_prerelease() {
        assert_eq!(version_from_spec("foo@1.0.0-beta.1").as_deref(), Some("1.0.0-beta.1"));
        assert_eq!(
            version_from_spec("@scope/name@2.0.0-rc.3").as_deref(),
            Some("2.0.0-rc.3")
        );
    }

    #[test]
    fn version_from_spec_returns_none_without_version() {
        assert_eq!(version_from_spec("pkg"), None);
        assert_eq!(version_from_spec("@scope/name"), None);
    }

    #[test]
    fn version_from_spec_returns_none_for_unparseable() {
        // rsplit takes the last segment, which must parse as semver.
        assert_eq!(version_from_spec("pkg@not-a-version"), None);
    }

    // ---- newest_installed_version -------------------------------------

    /// Helper: create a fake current-layout install under
    /// `agent_packages_root/<id>/<spec>/node-test/`.
    fn make_fake_install(
        root: &Path,
        id: &str,
        spec: &str,
        version: &str,
        marker_mtime_offset_secs: i64,
    ) -> PathBuf {
        let dir = root.join(sanitize(id)).join(sanitize(spec)).join("node-test");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(".nex-install-ok"), "").unwrap();
        std::fs::write(dir.join(".nex-version"), version).unwrap();
        // Backdate or forward-date the marker so we can assert ordering.
        // Negative offsets mean "older than now"; cap to ±1 day.
        let offset = marker_mtime_offset_secs.clamp(-86_400, 86_400);
        let now = std::time::SystemTime::now();
        let mtime = if offset >= 0 {
            now + std::time::Duration::from_secs(offset as u64)
        } else {
            now - std::time::Duration::from_secs(offset.unsigned_abs())
        };
        let _ = filetime_set(&dir.join(".nex-install-ok"), mtime);
        dir
    }

    fn make_fake_executable(install_dir: &Path, package_name: &str) -> PathBuf {
        let package_dir = install_dir.join("node_modules").join(package_name);
        let executable = package_dir.join("dist/cli.js");
        std::fs::create_dir_all(executable.parent().unwrap()).unwrap();
        std::fs::write(
            package_dir.join("package.json"),
            format!(r#"{{"name":"{package_name}","bin":"dist/cli.js"}}"#),
        )
        .unwrap();
        std::fs::write(&executable, "#!/usr/bin/env node").unwrap();
        executable
    }

    /// Set a file's mtime to `t`. Uses `std::fs::File::set_modified` (stable
    /// since Rust 1.75) so we don't pull in the `filetime` crate.
    fn filetime_set(path: &Path, t: std::time::SystemTime) -> std::io::Result<()> {
        let f = std::fs::OpenOptions::new().write(true).open(path)?;
        f.set_modified(t)
    }

    #[tokio::test]
    async fn newest_installed_version_returns_none_when_cache_empty() {
        let dir = tempfile::tempdir().unwrap();
        let cache = PackageCache::new(
            dir.path(),
            crate::agent::node_runtime::NodeRuntimeHandle::new(
                crate::agent::node_runtime::NodeBinaryOptions::default(),
                crate::agent::shell_env::ShellEnv::new(),
                dir.path().to_path_buf(),
            ),
        );
        assert_eq!(cache.newest_installed_version("claude-acp"), None);
    }

    #[tokio::test]
    async fn newest_installed_version_picks_newest_marker() {
        let dir = tempfile::tempdir().unwrap();
        let cache = PackageCache::new(
            dir.path(),
            crate::agent::node_runtime::NodeRuntimeHandle::new(
                crate::agent::node_runtime::NodeBinaryOptions::default(),
                crate::agent::shell_env::ShellEnv::new(),
                dir.path().to_path_buf(),
            ),
        );
        // Three installs: 0.64.0 (old), 0.65.0 (older), 0.66.0 (newest).
        // Mtimes are: -3600, -60, 0 seconds from now.
        make_fake_install(&cache.root, "claude-acp", "@scope/claude@0.64.0", "0.64.0", -3600);
        make_fake_install(&cache.root, "claude-acp", "@scope/claude@0.66.0", "0.66.0", 0);
        make_fake_install(&cache.root, "claude-acp", "@scope/claude@0.65.0", "0.65.0", -60);
        assert_eq!(cache.newest_installed_version("claude-acp").as_deref(), Some("0.66.0"));
    }

    #[test]
    fn cached_fallback_ignores_partial_new_version() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("agent-packages");
        let old = make_fake_install(
            &root,
            "claude-acp",
            "@agentclientprotocol/claude-agent-acp@0.66.0",
            "0.66.0",
            0,
        );
        let old_executable = make_fake_executable(
            &old,
            "@agentclientprotocol/claude-agent-acp",
        );

        let partial = root
            .join("claude-acp")
            .join("_agentclientprotocol_claude-agent-acp_0.67.0")
            .join("node-test");
        let _ = make_fake_executable(
            &partial,
            "@agentclientprotocol/claude-agent-acp",
        );
        // No success marker on the new version: it must never be selected.
        let (resolved, _) = newest_usable_npx_install(
            &root,
            "claude-acp",
            "@agentclientprotocol/claude-agent-acp@0.67.0",
            Path::new("/usr/bin/node"),
        )
        .expect("old complete cache should remain usable");
        assert_eq!(resolved.executable_path, old_executable);
        assert_eq!(resolved.node_path, PathBuf::from("/usr/bin/node"));
        assert!(!resolved.first_install);
    }

    #[tokio::test]
    async fn newest_installed_version_ignores_dirs_without_version_sidecar() {
        // An older cache that hasn't written `.nex-version` yet — should
        // not surface anything (we don't know which version it is).
        let dir = tempfile::tempdir().unwrap();
        let cache = PackageCache::new(
            dir.path(),
            crate::agent::node_runtime::NodeRuntimeHandle::new(
                crate::agent::node_runtime::NodeBinaryOptions::default(),
                crate::agent::shell_env::ShellEnv::new(),
                dir.path().to_path_buf(),
            ),
        );
        let spec_dir = cache.root.join("claude-acp/_scope_claude_0.64.0");
        std::fs::create_dir_all(&spec_dir).unwrap();
        std::fs::write(spec_dir.join(".nex-install-ok"), "").unwrap();
        // No .nex-version file.
        assert_eq!(cache.newest_installed_version("claude-acp"), None);
    }
}
