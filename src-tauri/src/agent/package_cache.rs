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
use std::time::Duration;

use async_trait::async_trait;
use serde_json::Value as JsonValue;
use tokio::sync::{Mutex as AsyncMutex, OnceCell};

use super::node_runtime::{NodeRuntime, NodeRuntimeHandle};
use super::registry::{RegistryEntry, RegistryNpxDistribution};
use crate::error::NexError;

/// Hard cap on a single `npm install`. Most installs complete in 5-15s;
/// 120s gives headroom for slow networks without hanging the GUI.
const INSTALL_TIMEOUT: Duration = Duration::from_secs(120);

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
}

type Inflight = Arc<OnceCell<Result<ResolvedNpx, NexError>>>;

/// Production resolver. Constructs an install root per (sanitized id +
/// sanitized package spec) so the same registry entry with a bumped version
/// doesn't collide with a previous install.
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

    /// Actually perform the install. Wipes any prior `install_dir` first
    /// to avoid stale `node_modules` colliding.
    async fn do_install(
        &self,
        install_dir: &Path,
        spec: &str,
        options: &InstallOptions,
        runtime: &Arc<dyn NodeRuntime>,
    ) -> Result<ResolvedNpx, NexError> {
        // Wipe + recreate.
        if install_dir.exists() {
            std::fs::remove_dir_all(install_dir).map_err(|e| NexError::Agent(format!(
                "failed to wipe prior install dir: {e}"
            )))?;
        }
        std::fs::create_dir_all(install_dir).map_err(|e| NexError::Agent(format!(
            "failed to create install dir: {e}"
        )))?;

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

        // npm install flags:
        //   --prefix <install_dir>           install target = cache
        //   --cache  <app_data_dir>/npm-cache
        //   --userconfig /dev/null          shield from user's stray .npmrc
        //   --globalconfig /dev/null
        //   --save-exact                    lock the version
        //   --no-audit --no-fund            skip network probes
        //   [--ignore-scripts]              gated by options
        //   <package>
        let cache_dir = install_dir
            .parent() // .../<spec>
            .and_then(|p| p.parent()) // .../<id>
            .and_then(|p| p.parent()) // .../agent-packages
            .and_then(|p| p.parent()) // .../app_data_dir
            .ok_or_else(|| NexError::Agent("could not derive npm cache dir".into()))?
            .join("npm-cache");

        let mut npm_args: Vec<String> = vec![
            "install".to_string(),
            "--prefix".to_string(),
            install_dir.to_string_lossy().into_owned(),
            "--cache".to_string(),
            cache_dir.to_string_lossy().into_owned(),
            "--userconfig".to_string(),
            "/dev/null".to_string(),
            "--globalconfig".to_string(),
            "/dev/null".to_string(),
            "--save-exact".to_string(),
            "--no-audit".to_string(),
            "--no-fund".to_string(),
        ];
        if options.ignore_install_scripts {
            npm_args.push("--ignore-scripts".to_string());
        }
        npm_args.push(spec.to_string());

        let sub_args: Vec<&str> = npm_args.iter().map(String::as_str).collect();

        // `node <npm-cli.js> <sub_args...>` — no PATH lookup, no shim.
        let mut cmd = tokio::process::Command::new(node_binary);
        cmd.arg(&npm_cli).args(&sub_args);
        cmd.envs(&runtime.npm_command_env());
        cmd.current_dir(install_dir);
        cmd.stdin(std::process::Stdio::null());
        cmd.stdout(std::process::Stdio::piped());
        cmd.stderr(std::process::Stdio::piped());

        let node_path = node_binary.to_path_buf();
        let output = match tokio::time::timeout(INSTALL_TIMEOUT, cmd.output()).await {
            Ok(Ok(o)) => o,
            Ok(Err(e)) => {
                return Err(NexError::Agent(format!(
                    "failed to spawn npm install: {e}"
                )));
            }
            Err(_) => {
                return Err(NexError::AgentNotInstalled {
                    what: "npm package",
                    hint: format!(
                        "`npm install {spec}` did not complete within {}s. \
                         Check your network connection and try again.",
                        INSTALL_TIMEOUT.as_secs()
                    ),
                });
            }
        };

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let stdout = String::from_utf8_lossy(&output.stdout);
            return Err(NexError::Agent(format!(
                "`npm install {spec}` failed (exit {}):\n  stderr: {}\n  stdout: {}",
                output.status,
                stderr.trim(),
                stdout.trim()
            )));
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
        let marker = install_dir.join(".nex-install-ok");

        // Fast path: marker present and the bin file still exists.
        if marker.exists() {
            if let Ok(exec) = read_package_executable_path(&install_dir, &npx.package) {
                if exec.exists() {
                    return Ok(ResolvedNpx {
                        node_path: runtime.binary_path().to_path_buf(),
                        executable_path: exec,
                        first_install: false,
                    });
                }
            }
        }

        // Inflight dedup key: id + spec (both sanitized).
        let key = format!("{}/{}", sanitize(&entry.id), sanitize(&npx.package));
        let cell = {
            let mut map = self.inflight.lock().await;
            map.entry(key.clone())
                .or_insert_with(|| Arc::new(OnceCell::new()))
                .clone()
        };

        let result = cell
            .get_or_init(|| async {
                self.do_install(&install_dir, &npx.package, &InstallOptions::default(), &runtime)
                    .await
            })
            .await;

        // Persist the marker only on success, and only after we've actually
        // written the bin (the read above guarantees it does).
        if result.is_ok() {
            let _ = std::fs::write(&marker, "");
        }
        result.clone()
    }
}

/// Replaces characters that are trouble in filesystem paths. Mirrors
/// `binary.rs::sanitize` but is also exercised on npm package specs
/// (`@scope/name@version`).
pub fn sanitize(s: &str) -> String {
    s.replace(['/', '\\', ':', '*', '?', '"', '<', '>', '|', ' ', '@'], "_")
}

/// Read the `bin` field of a freshly-installed package and return the path
/// to the executable. Mirrors npx's selection rules: a single string `bin`
/// is normalized to `{<name>: <path>}`; when there are multiple bins, the
/// one matching the package's unscoped name wins; otherwise ambiguous.
pub fn read_package_executable_path(
    install_dir: &Path,
    package_spec: &str,
) -> Result<PathBuf, NexError> {
    let dir_name = sanitize(package_spec);
    let pkg_dir = install_dir.join("node_modules").join(&dir_name);
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

    #[test]
    fn read_package_executable_path_string_bin() {
        let dir = tempfile::tempdir().unwrap();
        let pkg = dir.path().join("node_modules").join(sanitize("@scope/foo@1.0.0"));
        std::fs::create_dir_all(&pkg).unwrap();
        std::fs::write(
            pkg.join("package.json"),
            r#"{"name":"@scope/foo","bin":"dist/cli.js"}"#,
        )
        .unwrap();
        let got = read_package_executable_path(dir.path(), "@scope/foo@1.0.0").unwrap();
        assert!(got.ends_with("node_modules/_scope_foo_1.0.0/dist/cli.js"));
    }

    #[test]
    fn read_package_executable_path_object_bin_unscoped_match() {
        let dir = tempfile::tempdir().unwrap();
        let pkg = dir.path().join("node_modules").join(sanitize("@scope/foo@1.0.0"));
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
    fn read_package_executable_path_errors_when_missing() {
        let dir = tempfile::tempdir().unwrap();
        let err = read_package_executable_path(dir.path(), "@scope/missing@1.0.0").unwrap_err();
        assert!(matches!(err, NexError::Agent(_)));
    }
}
