//! Node.js runtime resolution and management.
//!
//! Nex does not depend on the user's shell PATH to find `node` / `npm`.
//! Instead it resolves a Node runtime in this order:
//!
//! 1. `use_paths` — explicit absolute paths supplied by settings (no settings
//!    UI yet; reserved for the follow-up PR).
//! 2. `allow_path_lookup` — `which::which_in` against the PATH loaded by
//!    `ShellEnv` (the user's login shell PATH, which is invisible to GUI
//!    apps). Falls back to the process PATH if shell env is still loading.
//! 3. `allow_binary_download` — download an official Node v24.x tarball
//!    from `nodejs.org` to `app_data_dir/node/<version>/` and extract.
//! 4. `UnavailableNodeRuntime` — every call returns a clear
//!    `NexError::AgentNotInstalled` with a user-actionable hint.
//!
//! Mirrors the design in Zed's `crates/node_runtime/src/node_runtime.rs` but
//! adapts it to Nex's smaller surface (no settings hot-reload, so resolution
//! is one-shot and frozen for the process lifetime).
//!
//! The runtime is held by `NodeRuntimeHandle`, a `tokio::sync::OnceCell`
//! wrapper that triggers resolution on first call (or eagerly in
//! `AgentSessionManager::new` via `tauri::async_runtime::spawn`).

use std::collections::HashMap;
use std::env;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use semver::{Version, VersionReq};
use serde::{Deserialize, Serialize};
use tokio::sync::OnceCell;

use super::shell_env::ShellEnv;
use crate::error::NexError;

const NODE_CA_CERTS_ENV_VAR: &str = "NODE_EXTRA_CA_CERTS";

/// Pin a specific Node version so cache keys and managed downloads are
/// deterministic. Bumping this requires re-verifying the sha256 table below.
pub const MANAGED_NODE_VERSION: &str = "v24.11.0";

/// Minimum Node version Nex will accept — both from the system PATH and
/// from the managed download. Modern ACP agents (claude-agent-acp, codex-acp,
/// gemini-cli) rely on `node:fs/promises`, `structuredClone`, and other
/// Node 20+ APIs. **Pinned to Node 22 LTS** because that's the oldest LTS
/// that npm itself still supports without warning.
pub const MIN_NODE_VERSION: &str = ">=22.0.0";

/// Per-(os, arch) sha256 of the Node `tar.gz` / `zip` archive. `None` entries
/// are not yet populated — `ManagedNodeRuntime::install_if_needed` will fail
/// fast with a clear message on those platforms.
fn managed_node_sha256(os_arch: &str) -> Option<&'static str> {
    match os_arch {
        // Populated from https://nodejs.org/dist/<VERSION>/SHASUMS256.txt
        // TODO(launch): fetch + verify before any release.
        "darwin-aarch64" => None,
        "darwin-x86_64" => None,
        "linux-aarch64" => None,
        "linux-x86_64" => None,
        "windows-x86_64" => None,
        _ => None,
    }
}

/// Knobs controlling how Nex picks a Node runtime.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct NodeBinaryOptions {
    /// Look up `node` on the (shell) PATH before falling back to download.
    pub allow_path_lookup: bool,
    /// If PATH lookup fails, download a managed Node from `nodejs.org`.
    pub allow_binary_download: bool,
    /// Hard-coded `(node, npm)` paths; bypasses both lookup and download.
    /// `npm` is currently unused (we invoke `node npm-cli.js` directly) but
    /// kept for symmetry with Zed's `use_paths`.
    pub use_paths: Option<(PathBuf, PathBuf)>,
    /// Forwarded to `npm install --ignore-scripts`. **Default `false`** —
    /// some agents (e.g. `@google/gemini-cli`) need postinstall hooks.
    pub ignore_install_scripts: bool,
}

impl Default for NodeBinaryOptions {
    fn default() -> Self {
        Self {
            allow_path_lookup: true,
            allow_binary_download: true,
            use_paths: None,
            ignore_install_scripts: false,
        }
    }
}

/// The single, ergonomic Node runtime that downstream code interacts with.
#[async_trait]
pub trait NodeRuntime: Send + Sync {
    /// Absolute path to the `node` binary. Cheap synchronous read.
    fn binary_path(&self) -> &Path;

    /// Node version (`24.11.0`). Used to key install caches. Returned as
    /// a borrowed `&Version` so callers can either format it (`{}`) or
    /// compare it semantically.
    fn version(&self) -> &Version;

    /// Run an npm subcommand. `subcommand` is e.g. `"install"`, `"info"`.
    /// `args` are passed verbatim after the subcommand. `dir` is the cwd.
    ///
    /// The runtime spawns `<node> <node_dir>/node_modules/npm/bin/npm-cli.js
    /// <subcommand> <args>` directly — never via PATH lookup, never via the
    /// `npm` / `npm.cmd` shim.
    async fn run_npm_subcommand(
        &self,
        dir: Option<&Path>,
        subcommand: &str,
        args: &[&str],
    ) -> Result<(), NexError>;

    /// Build an env map for child processes that should see the Node-managed
    /// `node` / `npm` on PATH. Per-agent overrides are layered on top by
    /// `launch::resolve_registry`, not here.
    fn npm_command_env(&self) -> HashMap<String, String>;
}

// -- SystemNodeRuntime ---------------------------------------------------

/// A Node runtime that uses a node binary already on the user's system,
/// either from `use_paths` or found via `which_in`.
#[derive(Debug)]
pub struct SystemNodeRuntime {
    node: PathBuf,
    version: Version,
}

impl SystemNodeRuntime {
    /// Locate a usable Node on PATH, preferring the shell env's PATH if
    /// already loaded. Verifies the binary exists and reports a version.
    pub async fn detect(shell_env: &ShellEnv) -> Result<Self, NexError> {
        // Give the shell env a chance to load (but cap the wait — see plan).
        let _ = shell_env.wait_loaded(Duration::from_secs(10)).await;
        let path_value = shell_env.path();
        // `which_in` searches the given PATH (or the process PATH if `None`)
        // for the binary. We pass `Some(path_value)` so the shell-loaded PATH
        // takes precedence when available. CWD falls back to "/" so the
        // search doesn't accidentally exclude system dirs.
        let node = which::which_in("node", Some(path_value), Path::new("/"))
            .map_err(|_e| NexError::AgentNotInstalled {
                what: "node",
                hint: "Nex could not find a `node` binary on the system PATH. \
                     Install Node 22+ from https://nodejs.org, or via \
                     `fnm install 22` / `volta install node@22`, then restart Nex."
                    .into(),
            })?;
        Self::new(node).await
    }

    /// Validate that `node` exists, runs, and reports a Node version that
    /// meets `MIN_NODE_VERSION`. Older versions are rejected with a clear
    /// remediation hint so the user can either upgrade or rely on
    /// `ManagedNodeRuntime` (if enabled) for a fallback.
    pub async fn new(node: PathBuf) -> Result<Self, NexError> {
        let version = read_node_version(&node).await?;
        let req = VersionReq::parse(MIN_NODE_VERSION)
            .expect("MIN_NODE_VERSION is a static, parseable version requirement");
        if !req.matches(&version) {
            return Err(NexError::AgentNotInstalled {
                what: "node",
                hint: format!(
                    "`{}` reports Node {version}, but Nex requires {req}. \
                     Install Node 22+ from https://nodejs.org, or via \
                     `fnm install 22` / `volta install node@22`, then restart Nex. \
                     Alternatively, enable automatic Node download in Settings.",
                    node.display()
                ),
            });
        }
        Ok(Self { node, version })
    }
}

#[async_trait]
impl NodeRuntime for SystemNodeRuntime {
    fn binary_path(&self) -> &Path {
        &self.node
    }

    fn version(&self) -> &Version {
        &self.version
    }

    async fn run_npm_subcommand(
        &self,
        dir: Option<&Path>,
        subcommand: &str,
        args: &[&str],
    ) -> Result<(), NexError> {
        run_npm_subcommand_with(&self.node, dir, subcommand, args, &self.npm_command_env()).await
    }

    fn npm_command_env(&self) -> HashMap<String, String> {
        npm_command_env(&self.node)
    }
}

// -- ManagedNodeRuntime --------------------------------------------------

/// A Node runtime downloaded by Nex on first use.
#[derive(Debug)]
pub struct ManagedNodeRuntime {
    /// The path to the `node` binary. Cached at construction so `binary_path`
    /// can return `&Path` without recomputing or leaking.
    node: PathBuf,
    /// The directory that holds the unpacked Node distribution (the parent
    /// of `bin/`).
    install_path: PathBuf,
    version: Version,
}

impl ManagedNodeRuntime {
    pub fn install_path(&self) -> &Path {
        &self.install_path
    }

    /// Download, verify, and extract the managed Node tarball/zip. Idempotent:
    /// re-runs are no-ops if a usable binary is already on disk.
    pub async fn install_if_needed(
        app_data_dir: &Path,
        http: &reqwest::Client,
    ) -> Result<Self, NexError> {
        let version = MANAGED_NODE_VERSION;
        let platform = current_platform_key();
        let os_arch = &*platform;
        let install_root = app_data_dir.join("node").join(version).join(&platform);
        let node_path = node_binary_path(&install_root);
        let npm_cli_path = npm_cli_path(&install_root);

        if node_path.exists() && npm_cli_path.exists() {
            // Validate the cached binary still works (corruption / half-extract).
            if let Ok(version) = read_node_version(&node_path).await {
                return Ok(Self {
                    node: node_path,
                    install_path: install_root,
                    version,
                });
            }
        }

        let sha = managed_node_sha256(os_arch).ok_or_else(|| NexError::AgentNotInstalled {
            what: "managed node",
            hint: format!(
                "Nex does not have a SHA-256 pinned for the managed Node \
                 download on `{os_arch}`. Pin a hash in `node_runtime.rs::\
                 managed_node_sha256` or install Node 22+ manually."
            ),
        })?;

        let archive_url = managed_node_url(version, &platform);
        log::info!("downloading managed Node {version} for {platform} from {archive_url}");

        let response = http
            .get(&archive_url)
            .send()
            .await
            .map_err(|e| NexError::AgentNotInstalled {
                what: "managed node",
                hint: format!(
                    "Nex could not download Node.js (network error: {e}). \
                     Install Node 22+ from https://nodejs.org, or via \
                     `fnm install 22` / `volta install node@22`, then restart Nex."
                ),
            })?;
        let status = response.status();
        if !status.is_success() {
            return Err(NexError::AgentNotInstalled {
                what: "managed node",
                hint: format!(
                    "Downloading Node.js from nodejs.org returned HTTP {status}. \
                     Check your network connection or install Node 22+ manually \
                     from https://nodejs.org."
                ),
            });
        }
        let bytes = response
            .bytes()
            .await
            .map_err(|e| NexError::AgentNotInstalled {
                what: "managed node",
                hint: format!("Failed to read Node download body: {e}"),
            })?;

        verify_sha256(&bytes, sha)?;

        // Wipe any partial extract.
        if install_root.exists() {
            let _ = std::fs::remove_dir_all(&install_root);
        }
        std::fs::create_dir_all(&install_root).map_err(|e| NexError::AgentNotInstalled {
            what: "managed node",
            hint: format!("Failed to create managed Node install dir: {e}"),
        })?;

        extract_node_archive(&bytes, &archive_url, &install_root)?;

        let version = read_node_version(&node_path).await?;
        Ok(Self {
            node: node_path,
            install_path: install_root,
            version,
        })
    }
}

#[async_trait]
impl NodeRuntime for ManagedNodeRuntime {
    fn binary_path(&self) -> &Path {
        &self.node
    }

    fn version(&self) -> &Version {
        &self.version
    }

    async fn run_npm_subcommand(
        &self,
        dir: Option<&Path>,
        subcommand: &str,
        args: &[&str],
    ) -> Result<(), NexError> {
        run_npm_subcommand_with(self.binary_path(), dir, subcommand, args, &self.npm_command_env()).await
    }

    fn npm_command_env(&self) -> HashMap<String, String> {
        npm_command_env(self.binary_path())
    }
}

// -- UnavailableNodeRuntime ----------------------------------------------

/// Runtime for the "we tried everything and there is no Node" case.
#[derive(Debug)]
pub struct UnavailableNodeRuntime {
    hint: String,
    /// A placeholder version. `0.0.0` ensures callers that try to build
    /// cache keys off this see a clearly invalid value.
    version: Version,
}

impl UnavailableNodeRuntime {
    pub fn new(hint: impl Into<String>) -> Self {
        Self {
            hint: hint.into(),
            version: Version::new(0, 0, 0),
        }
    }
}

#[async_trait]
impl NodeRuntime for UnavailableNodeRuntime {
    fn binary_path(&self) -> &Path {
        Path::new("")
    }

    fn version(&self) -> &Version {
        &self.version
    }

    async fn run_npm_subcommand(
        &self,
        _dir: Option<&Path>,
        _subcommand: &str,
        _args: &[&str],
    ) -> Result<(), NexError> {
        Err(NexError::AgentNotInstalled {
            what: "node",
            hint: self.hint.clone(),
        })
    }

    fn npm_command_env(&self) -> HashMap<String, String> {
        HashMap::new()
    }
}

// -- NodeRuntimeHandle (one-shot async resolution) -----------------------

/// One-shot async wrapper that resolves the chosen `NodeRuntime` on first
/// use and caches the result forever. Mirrors `tokio::sync::OnceCell`'s
/// "resolve exactly once" guarantee.
pub struct NodeRuntimeHandle {
    cell: OnceCell<Arc<dyn NodeRuntime>>,
    options: NodeBinaryOptions,
    shell_env: Arc<ShellEnv>,
    app_data_dir: PathBuf,
    http: reqwest::Client,
}

impl NodeRuntimeHandle {
    pub fn new(
        options: NodeBinaryOptions,
        shell_env: Arc<ShellEnv>,
        app_data_dir: PathBuf,
    ) -> Arc<Self> {
        Arc::new(Self {
            cell: OnceCell::new(),
            options,
            shell_env,
            app_data_dir,
            http: reqwest::Client::new(),
        })
    }

    /// Get the resolved runtime, blocking the first caller if resolution is
    /// still in flight.
    pub async fn get(self: &Arc<Self>) -> Arc<dyn NodeRuntime> {
        self.cell
            .get_or_init(|| async {
                resolve_node_runtime(&self.options, &self.shell_env, &self.app_data_dir, &self.http).await
            })
            .await
            .clone()
    }

    /// Kick off resolution in the background. The first `get()` after this
    /// returns immediately if it's already done, or awaits if not.
    pub fn warm_up(self: &Arc<Self>) {
        let me = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            let _ = me.get().await;
        });
    }
}

/// Walk through the option priority list and return the first runtime that
/// works.
pub async fn resolve_node_runtime(
    options: &NodeBinaryOptions,
    shell_env: &ShellEnv,
    app_data_dir: &Path,
    http: &reqwest::Client,
) -> Arc<dyn NodeRuntime> {
    // 1) Explicit `use_paths` overrides everything.
    if let Some((node, _npm)) = &options.use_paths {
        if node.exists() {
            match SystemNodeRuntime::new(node.clone()).await {
                Ok(rt) => return Arc::new(rt),
                Err(e) => {
                    log::warn!(
                        "NodeBinaryOptions::use_paths points at `{}` but it is not usable: {e}",
                        node.display()
                    );
                }
            }
        } else {
            log::warn!(
                "NodeBinaryOptions::use_paths points at `{}` but that path does not exist; falling through",
                node.display()
            );
        }
    }

    // 2) PATH lookup.
    if options.allow_path_lookup {
        match SystemNodeRuntime::detect(shell_env).await {
            Ok(rt) => return Arc::new(rt),
            Err(e) => log::info!("PATH lookup for node failed: {e}"),
        }
    }

    // 3) Managed download.
    if options.allow_binary_download {
        match ManagedNodeRuntime::install_if_needed(app_data_dir, http).await {
            Ok(rt) => return Arc::new(rt),
            Err(e) => log::warn!("managed Node install failed: {e}"),
        }
    }

    Arc::new(UnavailableNodeRuntime::new(
        "Nex could not find a usable Node.js runtime and automatic \
         download is disabled. Install Node 22+ from https://nodejs.org \
         and restart Nex, or enable automatic download in Settings."
            .to_string(),
    ))
}

// -- Helpers --------------------------------------------------------------

/// Build the env map for child processes that should see the Node-managed
/// `node` / `npm` on PATH. Prepends the node binary's parent dir to PATH
/// (so any npm-installed shim resolves back to *our* node).
pub fn npm_command_env(node_binary: &Path) -> HashMap<String, String> {
    let mut env_map = HashMap::new();
    let env_path = path_with_node_binary_prepended(node_binary).unwrap_or_default();
    let path_value = env_path.to_string_lossy().into_owned();
    env_map.insert("PATH".to_string(), path_value.clone());
    // Windows: also set "Path" to match the system's casing.
    #[cfg(windows)]
    {
        env_map.insert("Path".to_string(), path_value);
        if let Ok(val) = env::var("SYSTEMROOT") {
            env_map.insert("SYSTEMROOT".to_string(), val);
        }
        if let Ok(val) = env::var("ComSpec") {
            env_map.insert("ComSpec".to_string(), val);
        }
    }
    if let Ok(certs) = env::var(NODE_CA_CERTS_ENV_VAR) {
        if !certs.is_empty() {
            env_map.insert(NODE_CA_CERTS_ENV_VAR.to_string(), certs);
        }
    }
    env_map
}

fn path_with_node_binary_prepended(node_binary: &Path) -> Option<OsString> {
    let existing = env::var_os("PATH");
    let node_dir = node_binary.parent().map(|p| p.as_os_str());
    match (existing, node_dir) {
        (Some(existing), Some(node_dir)) => env::join_paths(
            [PathBuf::from(node_dir)]
                .into_iter()
                .chain(env::split_paths(&existing)),
        )
        .ok(),
        (Some(existing), None) => Some(existing),
        (None, Some(node_dir)) => Some(node_dir.to_owned()),
        (None, None) => None,
    }
}

/// Returns the platform key used in archive URLs and directory names.
pub fn current_platform_key() -> String {
    let os = match std::env::consts::OS {
        "macos" => "darwin",
        other => other,
    };
    format!("{}-{}", os, std::env::consts::ARCH)
}

fn managed_node_url(version: &str, platform: &str) -> String {
    let ext = if platform.starts_with("windows") { "zip" } else { "tar.gz" };
    format!("https://nodejs.org/dist/{version}/node-{version}-{platform}.{ext}")
}

fn node_binary_path(install_root: &Path) -> PathBuf {
    if cfg!(windows) {
        install_root.join("node.exe")
    } else {
        install_root.join("bin").join("node")
    }
}

fn npm_cli_path(install_root: &Path) -> PathBuf {
    install_root.join("node_modules").join("npm").join("bin").join("npm-cli.js")
}

/// Spawn `<node_binary> --version` and parse the output as a `semver::Version`.
/// Tolerates the leading `v` (`v24.11.0`) and strips surrounding whitespace.
async fn read_node_version(node_binary: &Path) -> Result<Version, NexError> {
    let output = tokio::process::Command::new(node_binary)
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await
        .map_err(|e| NexError::AgentNotInstalled {
            what: "node",
            hint: format!("Failed to run `{node_binary:?} --version`: {e}"),
        })?;
    if !output.status.success() {
        return Err(NexError::AgentNotInstalled {
            what: "node",
            hint: format!(
                "`{node_binary:?} --version` exited with status {}: {}",
                output.status,
                String::from_utf8_lossy(&output.stderr)
            ),
        });
    }
    let raw = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stripped = raw.trim_start_matches('v');
    Version::parse(stripped).map_err(|e| NexError::AgentNotInstalled {
        what: "node",
        hint: format!(
            "`{node_binary:?} --version` returned `{raw}`, which is not a parseable semver version: {e}"
        ),
    })
}

fn verify_sha256(data: &[u8], expected_hex: &str) -> Result<(), NexError> {
    use sha2::{Digest, Sha256};
    let actual = format!("{:x}", Sha256::digest(data));
    if !actual.eq_ignore_ascii_case(expected_hex) {
        return Err(NexError::AgentNotInstalled {
            what: "managed node",
            hint: format!(
                "Managed Node archive checksum mismatch.\n  expected: {expected_hex}\n  actual:   {actual}\n\
                 This may indicate a corrupted download or a pinned hash that needs updating."
            ),
        });
    }
    Ok(())
}

fn extract_node_archive(data: &[u8], url: &str, dest: &Path) -> Result<(), NexError> {
    let lower = url.to_lowercase();
    if lower.ends_with(".zip") {
        extract_zip(data, dest)
    } else if lower.ends_with(".tar.gz") || lower.ends_with(".tgz") {
        extract_tar_gz(data, dest)
    } else {
        Err(NexError::AgentNotInstalled {
            what: "managed node",
            hint: format!("Unsupported Node archive format: {url}"),
        })
    }
}

fn extract_zip(data: &[u8], dest: &Path) -> Result<(), NexError> {
    let cursor = std::io::Cursor::new(data);
    let mut archive = zip::ZipArchive::new(cursor).map_err(|e| NexError::AgentNotInstalled {
        what: "managed node",
        hint: format!("Invalid Node zip: {e}"),
    })?;
    for i in 0..archive.len() {
        let mut file = archive.by_index(i).map_err(|e| NexError::AgentNotInstalled {
            what: "managed node",
            hint: format!("zip entry {i}: {e}"),
        })?;
        let Some(rel) = file.enclosed_name() else { continue };
        // Node tarballs nest under `node-vX.Y.Z-<platform>/`; strip that prefix
        // so `install_root` contains the bare `bin/`, `include/`, `lib/`, ...
        let stripped = rel
            .components()
            .skip(1) // drop the leading versioned directory
            .collect::<PathBuf>();
        if stripped.as_os_str().is_empty() {
            continue;
        }
        let out_path = dest.join(&stripped);
        if file.is_dir() {
            std::fs::create_dir_all(&out_path).map_err(|e| NexError::AgentNotInstalled {
                what: "managed node",
                hint: format!("mkdir: {e}"),
            })?;
        } else {
            if let Some(parent) = out_path.parent() {
                std::fs::create_dir_all(parent).map_err(|e| NexError::AgentNotInstalled {
                    what: "managed node",
                    hint: format!("mkdir: {e}"),
                })?;
            }
            let mut out = std::fs::File::create(&out_path).map_err(|e| NexError::AgentNotInstalled {
                what: "managed node",
                hint: format!("create file: {e}"),
            })?;
            std::io::copy(&mut file, &mut out).map_err(|e| NexError::AgentNotInstalled {
                what: "managed node",
                hint: format!("write file: {e}"),
            })?;
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if let Some(mode) = file.unix_mode() {
                let _ = std::fs::set_permissions(&out_path, std::fs::Permissions::from_mode(mode | 0o100));
            }
        }
    }
    Ok(())
}

fn extract_tar_gz(data: &[u8], dest: &Path) -> Result<(), NexError> {
    // `flate2` and `tar` are sync; since the surrounding function is `async`
    // and the data is already in memory, we just call them inline. (The
    // surrounding `install_if_needed` is the only caller and it's already
    // off the hot path.)
    let gz = flate2::read::GzDecoder::new(std::io::Cursor::new(data));
    let mut archive = tar::Archive::new(gz);
    let entries = archive.entries().map_err(|e| NexError::AgentNotInstalled {
        what: "managed node",
        hint: format!("tar read: {e}"),
    })?;
    for entry in entries {
        let mut entry = entry.map_err(|e| NexError::AgentNotInstalled {
            what: "managed node",
            hint: format!("tar entry: {e}"),
        })?;
        let path = entry
            .path()
            .map_err(|e| NexError::AgentNotInstalled {
                what: "managed node",
                hint: format!("tar path: {e}"),
            })?
            .into_owned();
        // Strip the leading `node-vX.Y.Z-<platform>/` so files land directly
        // under `dest` rather than under a nested versioned dir.
        let stripped: PathBuf = path.components().skip(1).collect();
        if stripped.as_os_str().is_empty() {
            continue;
        }
        let out_path = dest.join(&stripped);
        if entry.header().entry_type().is_dir() {
            std::fs::create_dir_all(&out_path).map_err(|e| NexError::AgentNotInstalled {
                what: "managed node",
                hint: format!("mkdir: {e}"),
            })?;
        } else {
            if let Some(parent) = out_path.parent() {
                std::fs::create_dir_all(parent).map_err(|e| NexError::AgentNotInstalled {
                    what: "managed node",
                    hint: format!("mkdir: {e}"),
                })?;
            }
            entry.unpack(&out_path).map_err(|e| NexError::AgentNotInstalled {
                what: "managed node",
                hint: format!("tar unpack: {e}"),
            })?;
        }
    }
    Ok(())
}

/// Run npm via the managed node + bundled `npm-cli.js`. Synchronous wrt the
/// command's exit; streams stdout to log, captures stderr into the error.
async fn run_npm_subcommand_with(
    node_binary: &Path,
    dir: Option<&Path>,
    subcommand: &str,
    args: &[&str],
    env_map: &HashMap<String, String>,
) -> Result<(), NexError> {
    // The Node distribution ships its own `npm-cli.js` next to the binary.
    let install_root = node_binary
        .parent()                        // .../bin
        .and_then(|p| p.parent())        // .../<node-vX.Y.Z-platform>
        .ok_or_else(|| NexError::Agent(format!(
            "could not determine Node install root from `{}`",
            node_binary.display()
        )))?;
    let npm_cli = install_root.join("node_modules/npm/bin/npm-cli.js");

    let mut cmd = tokio::process::Command::new(node_binary);
    cmd.arg(&npm_cli).arg(subcommand).args(args);
    cmd.envs(env_map);
    if let Some(d) = dir {
        cmd.current_dir(d);
    }
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    let output = cmd.output().await.map_err(|e| NexError::Agent(format!(
        "failed to spawn npm (via {}): {e}",
        node_binary.display()
    )))?;
    if !output.status.success() {
        return Err(NexError::Agent(format!(
            "npm {subcommand} failed (status {}):\n  stderr: {}\n  stdout: {}",
            output.status,
            String::from_utf8_lossy(&output.stderr).trim(),
            String::from_utf8_lossy(&output.stdout).trim(),
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::shell_env::ShellEnv;

    #[test]
    fn path_with_node_binary_prepended_unix() {
        let node = PathBuf::from("/opt/homebrew/bin/node");
        let result = path_with_node_binary_prepended(&node).unwrap();
        let joined = result.to_string_lossy();
        // node's dir should be at the front.
        assert!(
            joined.starts_with("/opt/homebrew/bin"),
            "node dir should be first: {joined}"
        );
        // And the original PATH should follow.
        if let Some(existing) = std::env::var_os("PATH") {
            let existing_str = existing.to_string_lossy();
            assert!(
                joined.contains(&*existing_str) || existing_str.is_empty(),
                "existing PATH should be preserved: {joined}"
            );
        }
    }

    #[test]
    fn npm_command_env_includes_path_and_node_dir() {
        let node = if cfg!(windows) {
            PathBuf::from(r"C:\nodejs\node.exe")
        } else {
            PathBuf::from("/opt/homebrew/bin/node")
        };
        let env_map = npm_command_env(&node);
        let path = env_map.get("PATH").expect("PATH set");
        let path_str = path.to_string();
        let prefix = if cfg!(windows) { r"C:\nodejs" } else { "/opt/homebrew/bin" };
        assert!(
            path_str.starts_with(prefix),
            "PATH should start with node dir, got: {path_str}"
        );
    }

    #[test]
    #[cfg(windows)]
    fn npm_command_env_sets_path_key_for_windows() {
        let node = PathBuf::from(r"C:\nodejs\node.exe");
        let env_map = npm_command_env(&node);
        assert!(env_map.contains_key("Path"));
        assert!(env_map.contains_key("PATH"));
    }

    #[test]
    fn default_options_are_user_friendly() {
        let opts = NodeBinaryOptions::default();
        assert!(opts.allow_path_lookup);
        assert!(opts.allow_binary_download);
        assert!(!opts.ignore_install_scripts);
        assert!(opts.use_paths.is_none());
    }

    #[tokio::test]
    async fn unavailable_runtime_errors_on_npm() {
        let rt = UnavailableNodeRuntime::new("custom hint");
        let err = rt.run_npm_subcommand(None, "install", &[]).await.unwrap_err();
        match err {
            NexError::AgentNotInstalled { what, hint } => {
                assert_eq!(what, "node");
                assert_eq!(hint, "custom hint");
            }
            other => panic!("expected AgentNotInstalled, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn handle_resolves_unavailable_when_all_paths_fail() {
        // No use_paths, no system node on PATH (we are in CI), no download.
        let opts = NodeBinaryOptions {
            allow_path_lookup: false,
            allow_binary_download: false,
            use_paths: None,
            ignore_install_scripts: false,
        };
        let shell_env = ShellEnv::new();
        let handle = NodeRuntimeHandle::new(
            opts,
            shell_env,
            std::env::temp_dir().join("nex-test-no-node"),
        );
        let rt = handle.get().await;
        // Should be UnavailableNodeRuntime.
        assert_eq!(rt.version(), &Version::new(0, 0, 0));
        assert!(rt.binary_path().as_os_str().is_empty());
    }

    /// Build a fake `node` executable in a tempdir that echoes the given
    /// version string and exits 0. Returns the path to the binary.
    fn fake_node(version: &str) -> PathBuf {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(if cfg!(windows) { "node.exe" } else { "node" });
        let body = if cfg!(windows) {
            format!("@echo off\r\necho {version}\r\n")
        } else {
            format!("#!/bin/sh\necho '{version}'\n")
        };
        std::fs::write(&path, body).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        // Hold the tempdir open for the test's lifetime by leaking it.
        std::mem::forget(dir);
        path
    }

    #[tokio::test]
    async fn system_node_runtime_accepts_supported_version() {
        let node = fake_node("v24.11.0");
        let rt = SystemNodeRuntime::new(node).await.expect("24.x is supported");
        assert_eq!(rt.version(), &Version::parse("24.11.0").unwrap());
    }

    #[tokio::test]
    async fn system_node_runtime_accepts_minimum_supported_version() {
        let node = fake_node("v22.0.0");
        let rt = SystemNodeRuntime::new(node).await.expect("22.0.0 is the floor");
        assert_eq!(rt.version(), &Version::parse("22.0.0").unwrap());
    }

    #[tokio::test]
    async fn system_node_runtime_rejects_below_minimum() {
        let node = fake_node("v20.18.0");
        let err = SystemNodeRuntime::new(node).await.unwrap_err();
        match err {
            NexError::AgentNotInstalled { what, hint } => {
                assert_eq!(what, "node");
                assert!(
                    hint.contains("20.18.0") && hint.contains(">=22.0.0"),
                    "hint should name the actual and required versions: {hint}"
                );
            }
            other => panic!("expected AgentNotInstalled, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn system_node_runtime_rejects_very_old_node() {
        let node = fake_node("v14.21.3");
        let err = SystemNodeRuntime::new(node).await.unwrap_err();
        assert!(matches!(err, NexError::AgentNotInstalled { what, .. } if what == "node"));
    }

    #[tokio::test]
    async fn system_node_runtime_rejects_unparseable_version() {
        // A binary that claims to be node but reports a nonsense version.
        let node = fake_node("weird-custom-build");
        let err = SystemNodeRuntime::new(node).await.unwrap_err();
        match err {
            NexError::AgentNotInstalled { what, hint } => {
                assert_eq!(what, "node");
                assert!(hint.contains("not a parseable semver version"));
            }
            other => panic!("expected AgentNotInstalled, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn system_node_runtime_rejects_missing_binary() {
        let node = PathBuf::from("/definitely/does/not/exist/node");
        let err = SystemNodeRuntime::new(node).await.unwrap_err();
        assert!(matches!(err, NexError::AgentNotInstalled { what, .. } if what == "node"));
    }
}
