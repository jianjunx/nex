//! Open Agent Client Protocol registry client.
//!
//! Nex's available-agent list comes from the **open ACP registry** — the same
//! public, unauthenticated endpoint Zed consumes
//! (`cdn.agentclientprotocol.com`). We never hardcode agent launch commands:
//! each entry carries its own `distribution` (npx package + args + env, or a
//! binary target). The serde shapes below mirror Zed's
//! `crates/project/src/agent_registry_store.rs` wire schema so we stay
//! interoperable with the registry as it evolves.
//!
//! Robustness: the registry is fetched over the network, so we cache the last
//! good parse to disk and load it on startup (offline still shows agents).
//! Entries are parsed one-by-one so a single malformed entry can't blank the
//! whole list.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::error::NexError;

/// Open ACP registry index. Public, no auth headers required.
const REGISTRY_URL: &str = "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";
/// Don't re-fetch more than once per hour (matches Zed's throttle).
const REFRESH_THROTTLE: Duration = Duration::from_secs(60 * 60);
/// Bound a slow/hung fetch so the UI never waits indefinitely.
const FETCH_TIMEOUT: Duration = Duration::from_secs(30);
/// Cache file name inside the app data dir.
const CACHE_FILE: &str = "agent-registry.json";

/// One agent as published in the registry. Serialized to disk as our cache and
/// (via `ServerDescriptor`) surfaced to the frontend dropdown.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct RegistryEntry {
    pub id: String,
    pub name: String,
    pub version: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub icon: Option<String>,
    pub distribution: RegistryDistribution,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct RegistryDistribution {
    #[serde(default)]
    pub binary: Option<HashMap<String, RegistryBinaryTarget>>,
    #[serde(default)]
    pub npx: Option<RegistryNpxDistribution>,
}

/// A downloadable binary for one platform triple (e.g. `windows-x86_64`).
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct RegistryBinaryTarget {
    pub archive: String,
    pub cmd: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub sha256: Option<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
}

/// An `npx`-installable distribution. `package` already embeds the pinned
/// version (e.g. `@agentclientprotocol/claude-agent-acp@0.62.0`).
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct RegistryNpxDistribution {
    pub package: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
}

/// Top-level wire shape. `agents` is kept as raw values and parsed per-entry
/// (see `parse_registry`) so one bad entry doesn't poison the rest.
#[derive(Debug, Deserialize)]
struct RegistryIndex {
    #[serde(default)]
    #[allow(dead_code)]
    version: String,
    #[serde(default)]
    agents: Vec<serde_json::Value>,
}

/// In-memory agent list plus a disk cache and refresh throttle.
pub struct RegistryStore {
    cache_path: PathBuf,
    entries: Mutex<Vec<RegistryEntry>>,
    last_refresh: Mutex<Option<Instant>>,
}

impl RegistryStore {
    /// Creates the store and loads any cached registry from `cache_dir` so the
    /// dropdown is populated even before (or without) a network refresh.
    pub fn new(cache_dir: &Path) -> Self {
        let cache_path = cache_dir.join(CACHE_FILE);
        let store = Self {
            cache_path,
            entries: Mutex::new(Vec::new()),
            last_refresh: Mutex::new(None),
        };
        store.load_cache();
        store
    }

    fn load_cache(&self) {
        let Ok(bytes) = std::fs::read(&self.cache_path) else {
            return;
        };
        match serde_json::from_slice::<Vec<RegistryEntry>>(&bytes) {
            Ok(entries) => *self.entries.lock().unwrap() = entries,
            Err(e) => log::warn!("ignoring unreadable agent registry cache: {e}"),
        }
    }

    /// Snapshot of currently known agents (cache + any in-memory refresh).
    pub fn list(&self) -> Vec<RegistryEntry> {
        self.entries.lock().unwrap().clone()
    }

    pub fn find(&self, id: &str) -> Option<RegistryEntry> {
        self.entries
            .lock()
            .unwrap()
            .iter()
            .find(|e| e.id == id)
            .cloned()
    }

    /// True when we've never refreshed or the last refresh is older than the
    /// throttle window.
    pub fn is_stale(&self) -> bool {
        self.last_refresh
            .lock()
            .unwrap()
            .map(|t| t.elapsed() >= REFRESH_THROTTLE)
            .unwrap_or(true)
    }

    /// Refreshes only when stale; errors are swallowed by callers that treat a
    /// background refresh as best-effort.
    pub async fn refresh_if_stale(&self) -> Result<(), NexError> {
        if self.is_stale() {
            self.refresh().await
        } else {
            Ok(())
        }
    }

    /// Fetches the registry, updates the in-memory list, and persists the
    /// parse to the disk cache. Returns the entries on success.
    pub async fn refresh(&self) -> Result<(), NexError> {
        let client = reqwest::Client::builder()
            .timeout(FETCH_TIMEOUT)
            .build()
            .map_err(|e| NexError::Agent(format!("failed to build http client: {e}")))?;
        let body = client
            .get(REGISTRY_URL)
            .send()
            .await
            .and_then(|r| r.error_for_status())
            .map_err(|e| NexError::Agent(format!("failed to fetch agent registry: {e}")))?
            .text()
            .await
            .map_err(|e| NexError::Agent(format!("failed to read agent registry body: {e}")))?;

        let entries = parse_registry(&body)?;

        // Persist best-effort; a failed write shouldn't fail the refresh.
        if let Some(dir) = self.cache_path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        if let Ok(json) = serde_json::to_vec_pretty(&entries) {
            let _ = std::fs::write(&self.cache_path, json);
        }

        *self.entries.lock().unwrap() = entries;
        *self.last_refresh.lock().unwrap() = Some(Instant::now());
        Ok(())
    }
}

/// Parses the raw registry body into entries, skipping (and logging) any
/// individual entry that fails to deserialize.
fn parse_registry(body: &str) -> Result<Vec<RegistryEntry>, NexError> {
    let index: RegistryIndex = serde_json::from_str(body)
        .map_err(|e| NexError::Agent(format!("failed to parse agent registry: {e}")))?;
    let mut entries = Vec::with_capacity(index.agents.len());
    for value in index.agents {
        match serde_json::from_value::<RegistryEntry>(value) {
            Ok(entry) => entries.push(entry),
            Err(e) => log::warn!("skipping malformed agent registry entry: {e}"),
        }
    }
    Ok(entries)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_npx_entry_with_version_in_package() {
        let body = r#"{
            "version": "1.0.0",
            "agents": [
                {
                    "id": "claude-acp",
                    "name": "Claude Agent",
                    "version": "0.62.0",
                    "description": "ACP wrapper for Anthropic's Claude",
                    "distribution": { "npx": { "package": "@agentclientprotocol/claude-agent-acp@0.62.0" } },
                    "icon": "https://example/claude-acp.svg"
                },
                {
                    "id": "gemini",
                    "name": "Gemini CLI",
                    "version": "0.52.0",
                    "description": "Google's CLI",
                    "distribution": { "npx": { "package": "@google/gemini-cli@0.52.0", "args": ["--acp"] } }
                }
            ]
        }"#;
        let entries = parse_registry(body).unwrap();
        assert_eq!(entries.len(), 2);

        let claude = &entries[0];
        assert_eq!(claude.id, "claude-acp");
        let npx = claude.distribution.npx.as_ref().unwrap();
        assert_eq!(npx.package, "@agentclientprotocol/claude-agent-acp@0.62.0");
        assert!(npx.args.is_empty());
        assert!(claude.distribution.binary.is_none());

        let gemini = &entries[1];
        assert_eq!(
            gemini.distribution.npx.as_ref().unwrap().args,
            vec!["--acp"]
        );
        assert!(gemini.icon.is_none());
    }

    #[test]
    fn parses_binary_entry_and_env() {
        let body = r#"{
            "agents": [
                {
                    "id": "with-env",
                    "name": "Env Agent",
                    "version": "1.0.0",
                    "distribution": {
                        "npx": { "package": "pkg@1.0.0", "env": { "FOO": "bar" } }
                    }
                },
                {
                    "id": "bin-only",
                    "name": "Binary",
                    "version": "2.0.0",
                    "distribution": {
                        "binary": {
                            "windows-x86_64": { "archive": "https://x/a.zip", "cmd": "a.exe", "args": ["acp"] }
                        }
                    }
                }
            ]
        }"#;
        let entries = parse_registry(body).unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(
            entries[0]
                .distribution
                .npx
                .as_ref()
                .unwrap()
                .env
                .get("FOO")
                .map(String::as_str),
            Some("bar")
        );
        let bin = entries[1].distribution.binary.as_ref().unwrap();
        let target = bin.get("windows-x86_64").unwrap();
        assert_eq!(target.cmd, "a.exe");
        assert_eq!(target.args, vec!["acp"]);
        assert!(entries[1].distribution.npx.is_none());
    }

    #[test]
    fn skips_malformed_entry_but_keeps_valid_ones() {
        let body = r#"{
            "agents": [
                { "id": "good", "name": "Good", "version": "1.0.0", "distribution": { "npx": { "package": "p@1.0.0" } } },
                { "name": "missing id and distribution" },
                { "id": "good2", "name": "Good2", "version": "1.0.0", "distribution": {} }
            ]
        }"#;
        let entries = parse_registry(body).unwrap();
        // "good" and "good2" parse; the malformed one is skipped.
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].id, "good");
        assert_eq!(entries[1].id, "good2");
    }
}
