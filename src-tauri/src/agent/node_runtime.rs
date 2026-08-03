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

/// The Node.js release index: a JSON array of every published version,
/// newest first, each entry carrying an `lts` field (`false` for Current
/// releases, the codename string for LTS) and a `files` list of the build
/// artifacts available. Nex uses this to pick the newest LTS supporting
/// the user's platform — no hardcoded version to bump as Node evolves.
const NODE_DIST_INDEX_URL: &str = "https://nodejs.org/dist/index.json";

/// Minimum Node version Nex will accept — both from the system PATH and
/// from the managed download. Modern ACP agents (claude-agent-acp, codex-acp,
/// gemini-cli) rely on `node:fs/promises`, `structuredClone`, and other
/// Node 20+ APIs. **Pinned to Node 22 LTS** because that's the oldest LTS
/// that npm itself still supports without warning.
pub const MIN_NODE_VERSION: &str = ">=22.0.0";

/// Per-(os, arch) sha256 of the Node archive is **not** hardcoded — it's
/// pulled at runtime from `https://nodejs.org/dist/<VERSION>/SHASUMS256.txt`
/// (the same source every Node version manager — nvm, fnm, volta — trusts).
/// The version itself is also discovered at runtime from `index.json`, so
/// there is no "remember to fetch the new hash / bump the pin" step when
/// Node releases. See `ManagedNodeRuntime::install_if_needed`,
/// `discover_node_version`, and `parse_shasums256`.
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

    /// Returns a usable managed Node runtime, downloading one only if needed.
    ///
    /// Strategy, in order:
    /// 1. **Reuse an existing install** under `<app_data>/node/<version>/<platform>/`.
    ///    This is fully offline — a machine that already downloaded Node keeps
    ///    working even with no network. The highest parseable version wins.
    /// 2. **Discover the newest LTS** from `https://nodejs.org/dist/index.json`
    ///    that publishes an archive for the current platform. Node evolves
    ///    continuously, so Nex never hardcodes a version; `index.json` is the
    ///    same source nvm/fnm consult. Versions below `MIN_NODE_VERSION` are
    ///    skipped (defensive — every published LTS already satisfies it).
    /// 3. **Download + verify + extract** that version. The SHA-256 comes from
    ///    the per-version `SHASUMS256.txt` fetched at the same time, so both
    ///    the version and its checksum track nodejs.org automatically.
    pub async fn install_if_needed(
        app_data_dir: &Path,
        http: &reqwest::Client,
    ) -> Result<Self, NexError> {
        let platform = current_platform_key();
        let node_root = app_data_dir.join("node");

        // 1) Offline-first: reuse whatever is already on disk.
        if let Some((version_dir_name, install_root)) =
            find_existing_managed_install(&node_root, &platform)
        {
            let node_path = node_binary_path(&install_root);
            if resolve_npm_cli(&install_root).is_ok() {
                if let Ok(version) = read_node_version(&node_path).await {
                    log::info!(
                        "reusing managed Node {version_dir_name} at {}",
                        install_root.display()
                    );
                    return Ok(Self {
                        node: node_path,
                        install_path: install_root,
                        version,
                    });
                }
            }
            log::warn!(
                "existing managed Node at {} is unusable; re-discovering a version to download",
                install_root.display()
            );
        }

        // 2) Ask nodejs.org which LTS to install.
        let version = discover_node_version(http, &platform).await?;
        let install_root = node_root.join(&version).join(&platform);
        let node_path = node_binary_path(&install_root);

        // 3) Fetch SHA-256 from the same release's SHASUMS256.txt, download,
        // verify, extract. Trust model mirrors nvm/fnm/volta: TLS to
        // nodejs.org pins the channel; the checksum file is additionally
        // GPG-signed upstream (SHASUMS256.txt.asc), though Nex does not
        // verify the signature itself.
        let archive_url = managed_node_url(&version, &platform);
        let expected_sha = fetch_expected_sha256(http, &version, &archive_url).await?;

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

        verify_sha256(&bytes, &expected_sha)?;

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
///
/// The strings match the official Node.js release triples at
/// <https://nodejs.org/dist/>:
/// - `darwin-arm64`, `darwin-x64`
/// - `linux-arm64`, `linux-x64`, `linux-ppc64le`, `linux-s390x`
/// - `win-arm64`, `win-x64`
///
/// Rust's `consts::OS` returns `"macos"` (not `darwin`) and `"windows"`
/// (not `win`); we remap both so the resulting URL points at a real Node
/// release archive.
pub fn current_platform_key() -> String {
    let (os, arch) = match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => ("darwin", "arm64"),
        ("macos", "x86_64") => ("darwin", "x64"),
        ("windows", "aarch64") => ("win", "arm64"),
        ("windows", "x86_64") => ("win", "x64"),
        ("linux", "aarch64") => ("linux", "arm64"),
        ("linux", "x86_64") => ("linux", "x64"),
        ("linux", "powerpc64") => ("linux", "ppc64le"),
        (other, other_arch) => (other, other_arch),
    };
    format!("{}-{}", os, arch)
}

fn managed_node_url(version: &str, platform: &str) -> String {
    let ext = if platform.starts_with("win") { "zip" } else { "tar.gz" };
    format!("https://nodejs.org/dist/{version}/node-{version}-{platform}.{ext}")
}

fn shasums_url(version: &str) -> String {
    format!("https://nodejs.org/dist/{version}/SHASUMS256.txt")
}

/// Map our archive platform key (node release naming, e.g. `darwin-arm64`)
/// to the corresponding entry in `index.json`'s `files` array. The index
/// uses artifact-specific names — `osx-arm64-tar`, `win-x64-zip` — that
/// encode both the platform and the archive format we download.
fn files_key_for_platform(platform: &str) -> String {
    match platform {
        "darwin-arm64" => "osx-arm64-tar".to_string(),
        "darwin-x64" => "osx-x64-tar".to_string(),
        "win-x64" => "win-x64-zip".to_string(),
        "win-arm64" => "win-arm64-zip".to_string(),
        // Linux artifact names in the index match the release naming
        // verbatim (`linux-x64`, `linux-arm64`, `linux-ppc64le`, ...).
        other => other.to_string(),
    }
}

/// Pick the version to download from a `nodejs.org/dist/index.json` body.
///
/// Walks entries newest-first (the index's native order) and returns the
/// first version that is an LTS (`lts` is a non-false codename), publishes
/// the required archive (`files_key` present in `files`), and satisfies
/// `min_version`. Returns `None` when nothing qualifies.
pub fn parse_node_index(body: &str, files_key: &str, min_version: &VersionReq) -> Option<String> {
    #[derive(serde::Deserialize)]
    struct IndexEntry {
        version: String,
        #[serde(default)]
        files: Vec<String>,
        #[serde(default)]
        lts: serde_json::Value,
    }
    let entries: Vec<IndexEntry> = serde_json::from_str(body).ok()?;
    for entry in &entries {
        // LTS only: `lts` is `false` for Current releases and a codename
        // string ("Krypton", "Jod", ...) for LTS.
        let is_lts = match &entry.lts {
            serde_json::Value::String(s) => !s.is_empty(),
            _ => false,
        };
        if !is_lts {
            continue;
        }
        if !entry.files.iter().any(|f| f == files_key) {
            continue;
        }
        let v = entry.version.trim_start_matches('v');
        let Ok(sem) = Version::parse(v) else {
            continue;
        };
        if !min_version.matches(&sem) {
            continue;
        }
        return Some(entry.version.clone());
    }
    None
}

/// Query `nodejs.org/dist/index.json` and pick the newest LTS for the
/// current platform. The returned version string keeps its leading `v`
/// (e.g. `v24.18.1`) so it can be used directly in download URLs and
/// install-dir names.
async fn discover_node_version(http: &reqwest::Client, platform: &str) -> Result<String, NexError> {
    log::info!("discovering managed Node version from {NODE_DIST_INDEX_URL}");
    let response = http
        .get(NODE_DIST_INDEX_URL)
        .send()
        .await
        .map_err(|e| NexError::AgentNotInstalled {
            what: "managed node",
            hint: format!(
                "Nex could not reach nodejs.org to determine which Node.js to \
                 install (network error: {e}). Install Node 22+ from \
                 https://nodejs.org, or via `fnm install 22` / \
                 `volta install node@22`, then restart Nex."
            ),
        })?;
    let status = response.status();
    if !status.is_success() {
        return Err(NexError::AgentNotInstalled {
            what: "managed node",
            hint: format!(
                "Fetching the Node.js release index returned HTTP {status}. \
                 Install Node 22+ manually from https://nodejs.org and restart Nex."
            ),
        });
    }
    let body = response.text().await.map_err(|e| NexError::AgentNotInstalled {
        what: "managed node",
        hint: format!("Failed to read the Node.js release index body: {e}"),
    })?;

    let files_key = files_key_for_platform(platform);
    let min = VersionReq::parse(MIN_NODE_VERSION)
        .expect("MIN_NODE_VERSION is a static, parseable requirement");
    parse_node_index(&body, &files_key, &min).ok_or_else(|| NexError::AgentNotInstalled {
        what: "managed node",
        hint: format!(
            "nodejs.org publishes no Node.js LTS with a `{files_key}` archive \
             that satisfies {MIN_NODE_VERSION}. Install Node 22+ manually from \
             https://nodejs.org and restart Nex."
        ),
    })
}

/// Scan `<app_data>/node/` for a previously-downloaded Node that matches
/// `platform`. Returns `(version_dir_name, install_root)` for the highest
/// parseable version, or `None` when nothing usable is on disk. Fully
/// offline — this is what keeps Nex working without network once Node has
/// been downloaded once.
fn find_existing_managed_install(node_root: &Path, platform: &str) -> Option<(String, PathBuf)> {
    let mut best: Option<(Version, String, PathBuf)> = None;
    let Ok(entries) = std::fs::read_dir(node_root) else {
        return None;
    };
    for entry in entries.flatten() {
        let install_root = entry.path().join(platform);
        if !node_binary_path(&install_root).exists() {
            continue;
        }
        let dir_name = entry.file_name().to_string_lossy().into_owned();
        let Ok(sem) = Version::parse(dir_name.trim_start_matches('v')) else {
            continue;
        };
        match &best {
            Some((prev, _, _)) if *prev >= sem => {}
            _ => best = Some((sem, dir_name, install_root)),
        }
    }
    best.map(|(_, dir_name, install_root)| (dir_name, install_root))
}

/// The bare file name (no path) of the archive we're verifying, used to
/// look up the matching line in `SHASUMS256.txt`.
fn managed_node_archive_name(version: &str, platform: &str) -> String {
    let ext = if platform.starts_with("win") { "zip" } else { "tar.gz" };
    format!("node-{version}-{platform}.{ext}")
}

/// Download the SHASUMS256.txt for a given Node version and extract the
/// SHA-256 of the platform-specific archive. Returns a lowercase hex string
/// ready to feed into `verify_sha256`.
async fn fetch_expected_sha256(
    http: &reqwest::Client,
    version: &str,
    archive_url: &str,
) -> Result<String, NexError> {
    let archive_name = managed_node_archive_name(
        version,
        current_platform_key().as_str(),
    );
    let url = shasums_url(version);
    log::info!("fetching Node checksum manifest from {url}");

    let response = http
        .get(&url)
        .send()
        .await
        .map_err(|e| NexError::AgentNotInstalled {
            what: "managed node",
            hint: format!(
                "Could not fetch Node.js checksum manifest from nodejs.org ({e}). \
                 Install Node 22+ manually from https://nodejs.org."
            ),
        })?;
    if !response.status().is_success() {
        return Err(NexError::AgentNotInstalled {
            what: "managed node",
            hint: format!(
                "Fetching {url} returned HTTP {}. The Node version `{version}` \
                 may not exist on nodejs.org, or the release index is stale. \
                 Install Node 22+ manually from https://nodejs.org.",
                response.status()
            ),
        });
    }
    let body = response
        .text()
        .await
        .map_err(|e| NexError::AgentNotInstalled {
            what: "managed node",
            hint: format!("Could not read SHASUMS256.txt body: {e}"),
        })?;

    let sha = parse_shasums256(&body, &archive_name).ok_or_else(|| {
        NexError::AgentNotInstalled {
            what: "managed node",
            hint: format!(
                "Node.js {version} has no entry for `{archive_name}` in its \
                 SHASUMS256.txt. The Node release may not support this platform \
                 — install Node 22+ manually from https://nodejs.org. \
                 (Archive URL was {archive_url}.)"
            ),
        }
    })?;
    Ok(sha)
}

fn node_binary_path(install_root: &Path) -> PathBuf {
    if cfg!(windows) {
        install_root.join("node.exe")
    } else {
        install_root.join("bin").join("node")
    }
}

/// Derive the Node install root from a `node` binary path. On Unix,
/// `node` sits in `<root>/bin/node`; on Windows, `node.exe` sits at
/// `<root>/node.exe`.
pub fn install_root_from_node(node_binary: &Path) -> Result<PathBuf, NexError> {
    let parent = node_binary.parent().ok_or_else(|| NexError::Agent(format!(
        "could not determine Node install root from `{}` (no parent directory)",
        node_binary.display()
    )))?;
    if cfg!(windows) {
        // <root>/node.exe → <root>
        Ok(parent.to_path_buf())
    } else {
        // <root>/bin/node → <root>
        parent.parent().map(Path::to_path_buf).ok_or_else(|| {
            NexError::Agent(format!(
                "could not determine Node install root from `{}` (no grandparent directory)",
                node_binary.display()
            ))
        })
    }
}

/// Resolve the absolute path to `npm-cli.js` for a given Node install root.
///
/// Different Node distributions place `npm-cli.js` under different paths:
/// - **Windows (zip / installer)**: `<root>/node_modules/npm/bin/npm-cli.js`
/// - **macOS / Linux (official tarball, nvm, fnm, volta, Homebrew)**:
///   `<root>/lib/node_modules/npm/bin/npm-cli.js`
///
/// We try the layouts we know about in priority order and return the first
/// one that actually exists on disk. A clear error lists all attempted
/// locations if none resolve, so the user can see why a custom Node build
/// (e.g. stripped-down) won't work with Nex.
pub fn resolve_npm_cli(install_root: &Path) -> Result<PathBuf, NexError> {
    let candidates: Vec<PathBuf> = if cfg!(windows) {
        vec![
            install_root.join("node_modules").join("npm").join("bin").join("npm-cli.js"),
            install_root.join("node_modules").join("npm").join("bin").join("npm.cmd"),
        ]
    } else {
        vec![
            // Most common: official tarball / nvm / fnm / volta / Homebrew.
            install_root.join("lib").join("node_modules").join("npm").join("bin").join("npm-cli.js"),
            // Fallback for custom builds that skip the `lib/` prefix.
            install_root.join("node_modules").join("npm").join("bin").join("npm-cli.js"),
        ]
    };
    for candidate in &candidates {
        if candidate.exists() {
            return Ok(candidate.clone());
        }
    }
    let tried = candidates
        .iter()
        .map(|p| format!("- {}", p.display()))
        .collect::<Vec<_>>()
        .join("\n  ");
    Err(NexError::Agent(format!(
        "Could not locate npm-cli.js for Node at `{}`. Tried:\n  {}\n\
         This usually means the Node installation is missing npm, or it uses \
         an unsupported layout. Try installing Node 22+ from https://nodejs.org.",
        install_root.display(),
        tried
    )))
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
                 This may indicate a corrupted download or a man-in-the-middle."
            ),
        });
    }
    Ok(())
}

/// Parse a `SHASUMS256.txt` body and return the hex hash for `archive_name`,
/// or `None` if no matching line exists.
///
/// Format (one line per file):
/// ```text
/// <64-hex-sha>  node-v24.11.0-darwin-arm64.tar.gz
/// <64-hex-sha> *node-v24.11.0-darwin-arm64.tar.gz   ← "*" = binary mode
/// ```
pub fn parse_shasums256(body: &str, archive_name: &str) -> Option<String> {
    for line in body.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        // Split on the first run of whitespace (` ` or `  `), then peel off
        // an optional leading `*` that marks binary mode in `sha256sum -b`.
        let mut parts = line.splitn(2, char::is_whitespace);
        let hash = parts.next()?.trim();
        let raw_rest = parts.next()?.trim();
        if hash.len() != 64 || !hash.chars().all(|c| c.is_ascii_hexdigit()) {
            continue;
        }
        // `sha256sum -b` prefixes the filename with `*`; strip it.
        let rest = raw_rest.strip_prefix('*').unwrap_or(raw_rest);
        if rest == archive_name {
            return Some(hash.to_ascii_lowercase());
        }
    }
    None
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
    // The path differs by platform — see `resolve_npm_cli` for the full
    // list of candidate layouts.
    let install_root = install_root_from_node(node_binary)?;
    let npm_cli = resolve_npm_cli(&install_root)?;

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

    // ---- parse_shasums256 ---------------------------------------------

    /// A trimmed excerpt of a real SHASUMS256.txt (values invented, format
    /// matches what nodejs.org publishes). All three of nodejs.org's common
    /// line formats are exercised: double-space, binary-mode `*`, and a
    /// comments line that must be skipped.
    const SAMPLE_SHASUMS: &str = "\
# Node.js v24.11.0 SHASUMS256.txt
\
aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  node-v24.11.0-darwin-arm64.tar.gz
bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb  node-v24.11.0-darwin-x64.tar.gz
cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc *node-v24.11.0-linux-x64.tar.gz
dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd *node-v24.11.0-windows-x64.zip
";

    #[test]
    fn parse_shasums256_double_space_separator() {
        let got = parse_shasums256(SAMPLE_SHASUMS, "node-v24.11.0-darwin-arm64.tar.gz");
        assert_eq!(got, Some("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_string()));
    }

    #[test]
    fn parse_shasums256_binary_mode_prefix() {
        let got = parse_shasums256(SAMPLE_SHASUMS, "node-v24.11.0-linux-x64.tar.gz");
        assert_eq!(got, Some("cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc".to_string()));
    }

    #[test]
    fn parse_shasums256_windows_zip() {
        let got = parse_shasums256(SAMPLE_SHASUMS, "node-v24.11.0-windows-x64.zip");
        assert_eq!(got, Some("dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd".to_string()));
    }

    #[test]
    fn parse_shasums256_missing_entry() {
        let got = parse_shasums256(SAMPLE_SHASUMS, "node-v24.11.0-darwin-arm64.zip");
        assert_eq!(got, None);
    }

    #[test]
    fn parse_shasums256_ignores_comments_and_blank_lines() {
        let body = "\n# header comment\n\nffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff  node-v24.11.0-linux-arm64.tar.gz\n";
        let got = parse_shasums256(body, "node-v24.11.0-linux-arm64.tar.gz");
        assert!(got.is_some());
    }

    #[test]
    fn parse_shasums256_skips_lines_with_non_hex_hash() {
        // Some `sha256sum` invocations prefix with `./` or wrap in spaces;
        // a malformed line (e.g. a non-hex "hash") must be skipped, not
        // panic. The next valid line should still resolve.
        let body = "\
garbage-not-a-hash                                       some-other-file.tar.gz
eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee  node-v24.11.0-linux-arm64.tar.gz
";
        let got = parse_shasums256(body, "node-v24.11.0-linux-arm64.tar.gz");
        assert_eq!(got, Some("eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee".to_string()));
    }

    #[test]
    fn parse_shasums256_normalizes_uppercase_hex() {
        let body = "ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789  node-v24.11.0-darwin-arm64.tar.gz\n";
        let got = parse_shasums256(body, "node-v24.11.0-darwin-arm64.tar.gz");
        assert_eq!(
            got,
            Some("abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789".to_string())
        );
    }

    // ---- index.json version discovery --------------------------------
    //
    // Fixture mirrors the real shape of https://nodejs.org/dist/index.json:
    // newest first, Current releases carry `"lts": false`, LTS releases carry
    // a codename string, and `files` uses artifact-specific names
    // (`osx-arm64-tar`, `win-x64-zip`, ...).

    const SAMPLE_INDEX: &str = r#"[
        {"version":"v26.5.1","files":["osx-arm64-tar","win-x64-zip","linux-x64"],"lts":false},
        {"version":"v26.0.0","files":["osx-arm64-tar","win-x64-zip","linux-x64"],"lts":false},
        {"version":"v24.18.1","files":["osx-arm64-tar","win-x64-zip","linux-x64"],"lts":"Krypton"},
        {"version":"v24.10.0","files":["osx-arm64-tar","win-x64-zip","linux-x64"],"lts":"Krypton"},
        {"version":"v22.20.0","files":["osx-arm64-tar","win-x64-zip","linux-x64"],"lts":"Jod"},
        {"version":"v18.20.8","files":["osx-arm64-tar","win-x64-zip","linux-x64"],"lts":"Hydrogen"}
    ]"#;

    fn min_req() -> VersionReq {
        VersionReq::parse(MIN_NODE_VERSION).unwrap()
    }

    #[test]
    fn parse_node_index_picks_newest_lts() {
        // v26.x entries are Current (`lts: false`) and must be skipped even
        // though they're newer and have the right files.
        let got = parse_node_index(SAMPLE_INDEX, "osx-arm64-tar", &min_req());
        assert_eq!(got.as_deref(), Some("v24.18.1"));
    }

    #[test]
    fn parse_node_index_respects_files_key() {
        // No entry publishes a `win-arm64-zip` in the fixture.
        let got = parse_node_index(SAMPLE_INDEX, "win-arm64-zip", &min_req());
        assert_eq!(got, None);
    }

    #[test]
    fn parse_node_index_min_version_filters_old_lts() {
        // With a floor of >=23, only the Krypton line qualifies; the older
        // Jod (22.x) and Hydrogen (18.x) LTSes are filtered out.
        let req = VersionReq::parse(">=23.0.0").unwrap();
        let got = parse_node_index(SAMPLE_INDEX, "linux-x64", &req);
        assert_eq!(got.as_deref(), Some("v24.18.1"));

        // And a floor above everything yields nothing.
        let req = VersionReq::parse(">=99.0.0").unwrap();
        assert_eq!(parse_node_index(SAMPLE_INDEX, "linux-x64", &req), None);
    }

    #[test]
    fn parse_node_index_malformed_json_returns_none() {
        assert_eq!(parse_node_index("not json", "win-x64-zip", &min_req()), None);
        assert_eq!(parse_node_index("{}", "win-x64-zip", &min_req()), None);
        assert_eq!(parse_node_index("", "win-x64-zip", &min_req()), None);
    }

    #[test]
    fn parse_node_index_unparseable_version_skipped() {
        let body = r#"[
            {"version":"v99.99.99-weird","files":["win-x64-zip"],"lts":"Odd"},
            {"version":"v24.18.1","files":["win-x64-zip"],"lts":"Krypton"}
        ]"#;
        assert_eq!(
            parse_node_index(body, "win-x64-zip", &min_req()).as_deref(),
            Some("v24.18.1")
        );
    }

    #[test]
    fn files_key_maps_to_index_artifact_names() {
        assert_eq!(files_key_for_platform("darwin-arm64"), "osx-arm64-tar");
        assert_eq!(files_key_for_platform("darwin-x64"), "osx-x64-tar");
        assert_eq!(files_key_for_platform("win-x64"), "win-x64-zip");
        assert_eq!(files_key_for_platform("win-arm64"), "win-arm64-zip");
        // Linux artifact names match the release naming verbatim.
        assert_eq!(files_key_for_platform("linux-x64"), "linux-x64");
        assert_eq!(files_key_for_platform("linux-arm64"), "linux-arm64");
        assert_eq!(files_key_for_platform("linux-ppc64le"), "linux-ppc64le");
    }

    /// Build a fake managed install at `<root>/<version>/<platform>/` with
    /// the platform-appropriate binary name.
    fn make_fake_managed_node(root: &Path, version: &str, platform: &str) -> PathBuf {
        let install_root = root.join(version).join(platform);
        let bin = node_binary_path(&install_root);
        std::fs::create_dir_all(bin.parent().unwrap()).unwrap();
        std::fs::write(&bin, "").unwrap();
        install_root
    }

    #[test]
    fn find_existing_managed_install_picks_highest_version() {
        let dir = tempfile::tempdir().unwrap();
        let platform = current_platform_key();
        make_fake_managed_node(dir.path(), "v22.11.0", &platform);
        make_fake_managed_node(dir.path(), "v24.18.1", &platform);
        make_fake_managed_node(dir.path(), "v24.10.0", &platform);

        let got = find_existing_managed_install(dir.path(), &platform).unwrap();
        assert_eq!(got.0, "v24.18.1");
        assert_eq!(got.1, dir.path().join("v24.18.1").join(&platform));
    }

    #[test]
    fn find_existing_managed_install_ignores_other_platforms_and_junk() {
        let dir = tempfile::tempdir().unwrap();
        // A different platform's dir has its own platform subdir — ours
        // (`<version>/<our_platform>/bin/node`) doesn't exist for it.
        make_fake_managed_node(dir.path(), "v24.18.1", "some-other-platform");
        // A junk dir name that isn't semver at all.
        std::fs::create_dir_all(dir.path().join("not-a-version")).unwrap();

        assert!(find_existing_managed_install(dir.path(), &current_platform_key()).is_none());
    }

    #[test]
    fn find_existing_managed_install_missing_root_is_none() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("node-does-not-exist");
        assert!(find_existing_managed_install(&missing, "darwin-arm64").is_none());
    }

    // ---- install_root_from_node + resolve_npm_cli --------------------
    //
    // Regression coverage for the macOS nvm bug: a Node at
    // `/Users/x/.nvm/versions/node/v24.15.0/bin/node` must resolve npm to
    // `<...>/v24.15.0/lib/node_modules/npm/bin/npm-cli.js`, NOT
    // `<...>/v24.15.0/node_modules/npm/bin/npm-cli.js`. The Windows layout
    // puts `node.exe` at the root and `node_modules/` directly under it.

    #[test]
    fn install_root_unix_strips_bin() {
        if cfg!(windows) {
            return;
        }
        let node = Path::new("/Users/x/.nvm/versions/node/v24.15.0/bin/node");
        let root = install_root_from_node(node).unwrap();
        assert_eq!(root, Path::new("/Users/x/.nvm/versions/node/v24.15.0"));
    }

    #[test]
    fn install_root_windows_stays_at_parent() {
        if !cfg!(windows) {
            return;
        }
        let node = Path::new(r"C:\nodejs\node.exe");
        let root = install_root_from_node(node).unwrap();
        assert_eq!(root, Path::new(r"C:\nodejs"));
    }

    #[test]
    fn install_root_unix_errors_on_bare_binary() {
        if cfg!(windows) {
            return;
        }
        // `node` with no parent: there's no `bin/`, so we can't derive
        // an install root. This shouldn't happen in practice, but the
        // error path is what protects us from silent nonsense.
        let node = Path::new("node");
        let err = install_root_from_node(node).unwrap_err();
        assert!(matches!(err, NexError::Agent(_)));
    }

    #[test]
    fn resolve_npm_cli_unix_prefers_lib_layout() {
        if cfg!(windows) {
            return;
        }
        // Create a fake Unix Node install:
        //   <root>/bin/node              (we don't actually need the file)
        //   <root>/lib/node_modules/npm/bin/npm-cli.js
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let npm_cli = root.join("lib/node_modules/npm/bin/npm-cli.js");
        std::fs::create_dir_all(npm_cli.parent().unwrap()).unwrap();
        std::fs::write(&npm_cli, "// fake").unwrap();

        let resolved = resolve_npm_cli(root).unwrap();
        assert_eq!(resolved, npm_cli,
            "Unix layout must find npm-cli.js under lib/node_modules/, got: {resolved:?}");
    }

    #[test]
    fn resolve_npm_cli_unix_falls_back_when_no_lib() {
        if cfg!(windows) {
            return;
        }
        // A non-standard Node that puts npm directly under <root>/node_modules/.
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let npm_cli = root.join("node_modules/npm/bin/npm-cli.js");
        std::fs::create_dir_all(npm_cli.parent().unwrap()).unwrap();
        std::fs::write(&npm_cli, "// fake").unwrap();

        let resolved = resolve_npm_cli(root).unwrap();
        assert_eq!(resolved, npm_cli);
    }

    #[test]
    fn resolve_npm_cli_lists_attempted_paths_in_error() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let err = resolve_npm_cli(root).unwrap_err();
        match err {
            NexError::Agent(msg) => {
                assert!(msg.contains("Could not locate npm-cli.js"));
                if cfg!(windows) {
                    assert!(msg.contains("node_modules"));
                } else {
                    assert!(msg.contains("/lib/node_modules/npm/bin/npm-cli.js"),
                        "error must list the lib/ candidate: {msg}");
                }
            }
            other => panic!("expected NexError::Agent, got {other:?}"),
        }
    }

    #[test]
    fn resolve_npm_cli_handles_real_nvm_layout() {
        if cfg!(windows) {
            return;
        }
        // Mirror the exact path layout the user reported:
        //   /Users/jj/.nvm/versions/node/v24.15.0/lib/node_modules/npm/bin/npm-cli.js
        let dir = tempfile::tempdir().unwrap();
        let nvm_root = dir.path().join("versions/node/v24.15.0");
        let npm_cli = nvm_root.join("lib/node_modules/npm/bin/npm-cli.js");
        std::fs::create_dir_all(npm_cli.parent().unwrap()).unwrap();
        std::fs::write(&npm_cli, "// fake").unwrap();

        let bin = nvm_root.join("bin/node");
        let resolved_install_root = install_root_from_node(&bin).unwrap();
        assert_eq!(resolved_install_root, nvm_root);
        let resolved_npm = resolve_npm_cli(&resolved_install_root).unwrap();
        assert_eq!(resolved_npm, npm_cli);
    }
}
