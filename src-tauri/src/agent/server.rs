//! Method-agnostic agent facade.
//!
//! The frontend talks only to `AgentSessionManager`: it asks "what agents are
//! available" (`list_servers`) and "start a session against this target"
//! (`create_session`). Which *transport* a target uses is an implementation
//! detail — v1 routes everything through the ACP-over-stdio adapter
//! (`super::acp_adapter`), but the registry/custom split and the target enum
//! leave room for non-ACP providers later without changing the command surface.
//!
//! Available agents come from two sources, merged into one dropdown list:
//! 1. The **open ACP registry** (`RegistryStore`) — network-fetched + cached.
//! 2. **User-defined custom servers** (`CustomStore`) — persisted to Nex's own
//!    app-data dir. Nex never reads Zed's settings.json; the schema shape is
//!    merely kept compatible so custom servers could be shared in future.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use super::acp_adapter::AcpSessionManager;
use super::binary::BinaryCache;
use super::launch;
use super::node_runtime::{NodeBinaryOptions, NodeRuntimeHandle};
use super::package_cache::{PackageCache, PackageResolver};
use super::registry::{RegistryEntry, RegistryStore};
use super::shell_env::ShellEnv;
use super::types::{CreateSessionResult, PromptBlock};
use crate::error::NexError;

/// Registry agent ids exposed in the New-Conversation picker this phase.
const WHITELISTED_REGISTRY_IDS: &[&str] = &["claude-acp", "codex-acp", "cursor"];

/// File name for the user's custom servers, inside the app data dir.
const CUSTOM_SERVERS_FILE: &str = "custom-servers.json";

/// Which agent a new session should run against. Tagged JSON from the
/// frontend: `{ "type": "registry", "id": "claude-acp" }` or
/// `{ "type": "custom", "id": "<custom server id>" }`. Both resolve by id
/// against a server-side store (registry cache or custom-servers file), so
/// custom commands/env never cross the wire at create time.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum SessionTarget {
    /// A registry agent, resolved by id at creation time.
    Registry { id: String },
    /// A user-defined server, resolved by id from the custom-servers store.
    Custom { id: String },
    /// The built-in in-process Nex native agent (no external process).
    Native,
}

/// One row in the frontend's agent dropdown.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerDescriptor {
    pub id: String,
    pub name: String,
    /// Latest version published in the registry.
    pub version: String,
    /// Version currently cached on disk under
    /// `<app_data>/agent-packages/<id>/.../`, if any. The frontend compares
    /// this against `version` to render an "update available" badge.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub installed_version: Option<String>,
    pub description: String,
    pub icon: Option<String>,
    pub kind: ServerKind,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ServerKind {
    Registry,
    Custom,
    /// The built-in in-process Nex native agent.
    Native,
}

/// Id of the built-in native agent descriptor shown in the agent dropdowns.
pub const NATIVE_AGENT_ID: &str = "nex";

/// A user-defined ACP server (Zed-compatible `type:custom` shape).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomServer {
    pub id: String,
    pub name: String,
    pub command: String,
    #[serde(default)]
    pub env: HashMap<String, String>,
}

/// Persists the user's custom servers to a JSON file in the app data dir.
pub struct CustomStore {
    path: PathBuf,
    servers: Mutex<Vec<CustomServer>>,
}

impl CustomStore {
    pub fn new(dir: &Path) -> Self {
        let path = dir.join(CUSTOM_SERVERS_FILE);
        let servers = match std::fs::read(&path) {
            Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_else(|e| {
                log::warn!("ignoring unreadable custom-servers file: {e}");
                Vec::new()
            }),
            Err(_) => Vec::new(),
        };
        Self { path, servers: Mutex::new(servers) }
    }

    pub fn list(&self) -> Vec<CustomServer> {
        self.servers.lock().unwrap().clone()
    }

    pub fn find(&self, id: &str) -> Option<CustomServer> {
        self.servers.lock().unwrap().iter().find(|s| s.id == id).cloned()
    }

    /// Inserts or replaces (by id) a custom server, then persists.
    pub fn upsert(&self, server: CustomServer) -> Result<(), NexError> {
        {
            let mut servers = self.servers.lock().unwrap();
            if let Some(slot) = servers.iter_mut().find(|s| s.id == server.id) {
                *slot = server;
            } else {
                servers.push(server);
            }
        }
        self.save()
    }

    pub fn delete(&self, id: &str) -> Result<(), NexError> {
        self.servers.lock().unwrap().retain(|s| s.id != id);
        self.save()
    }

    fn save(&self) -> Result<(), NexError> {
        if let Some(dir) = self.path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let json = serde_json::to_vec_pretty(&*self.servers.lock().unwrap())
            .map_err(|e| NexError::Internal(format!("failed to serialize custom servers: {e}")))?;
        std::fs::write(&self.path, json)
            .map_err(|e| NexError::Internal(format!("failed to write custom servers: {e}")))?;
        Ok(())
    }
}

/// The single entry point the Tauri commands use.
pub struct AgentSessionManager {
    registry: Arc<RegistryStore>,
    custom: Arc<CustomStore>,
    binary_cache: BinaryCache,
    acp: AcpSessionManager,
    /// One-shot-resolved Node.js runtime. Held as `Arc` so the background
    /// warm-up task can outlive the `AgentSessionManager::new` call.
    node_runtime: Arc<NodeRuntimeHandle>,
    /// Layered on top of the node runtime; resolves registry `npx`
    /// distributions into `(node, bin)` pairs.
    package_cache: Arc<dyn PackageResolver>,
    /// Cached shell env (PATH, etc.) loaded from the user's login shell.
    shell_env: Arc<ShellEnv>,
    /// Per-cwd env (direnv / nix) layered on top of `shell_env`.
    project_envs: Arc<super::project_env::ProjectEnvCache>,
    /// App data dir; hosts `nex-agent.json` for the built-in native agent.
    app_data_dir: PathBuf,
}

impl AgentSessionManager {
    pub fn new(
        app_data_dir: &Path,
        shell_env: Arc<ShellEnv>,
        project_envs: Arc<super::project_env::ProjectEnvCache>,
    ) -> Self {
        // Shell-env loader must already have been kicked off by the caller
        // (shared with TerminalManager) before node resolution starts.

        // Build the node runtime handle and warm it up in the background.
        // The first `create_session` will block on `get()` if resolution is
        // still in flight, but steady-state callers see a cached result.
        let node_runtime = NodeRuntimeHandle::new(
            NodeBinaryOptions::default(),
            shell_env.clone(),
            app_data_dir.to_path_buf(),
        );
        node_runtime.warm_up();

        // PackageCache awaits `node_runtime.get()` only when an install is
        // actually required (cold cache), so the warm-up race is harmless.
        let package_cache: Arc<dyn PackageResolver> = Arc::new(PackageCache::new(
            app_data_dir,
            node_runtime.clone(),
        ));

        Self {
            registry: Arc::new(RegistryStore::new(app_data_dir)),
            custom: Arc::new(CustomStore::new(app_data_dir)),
            binary_cache: BinaryCache::new(app_data_dir),
            acp: AcpSessionManager::new(),
            node_runtime,
            package_cache,
            shell_env,
            project_envs,
            app_data_dir: app_data_dir.to_path_buf(),
        }
    }

    /// PATH for a project cwd: prefers direnv-enriched capture, else login shell.
    pub async fn path_for_cwd(&self, cwd: &str) -> std::ffi::OsString {
        self.project_envs.path_for_cwd(cwd, &self.shell_env).await
    }

    /// Resolves the target to a concrete launch spec and starts the session.
    /// For registry agents we opportunistically refresh a stale registry first
    /// (best-effort — the cached/loaded list is still usable offline).
    pub async fn create_session(
        &self,
        app: &AppHandle,
        conversation_id: &str,
        target: SessionTarget,
        cwd: &str,
    ) -> Result<CreateSessionResult, NexError> {
        // The built-in native agent runs in-process over a memory ACP pipe;
        // it needs no launch spec, node runtime, or PATH resolution.
        if matches!(target, SessionTarget::Native) {
            return self
                .acp
                .create_native_session(app, conversation_id, cwd, self.app_data_dir.clone())
                .await;
        }
        let spec = match target {
            SessionTarget::Registry { id } => {
                if let Err(e) = self.registry.refresh_if_stale().await {
                    log::warn!("agent registry refresh failed (using cache): {e}");
                }
                let entry: RegistryEntry = self.registry.find(&id).ok_or_else(|| {
                    NexError::Agent(format!(
                        "unknown agent `{id}` — refresh the agent registry and try again"
                    ))
                })?;
                // Block on node runtime resolution if it isn't done yet. This
                // is the one place that intentionally awaits the handle.
                let _ = self.node_runtime.get().await;
                // Prefer project-scoped PATH (direnv) over bare login-shell
                // PATH so agents see the same tools as an interactive shell
                // in this cwd. Falls back to ShellEnv when capture fails.
                let shell_path = self.path_for_cwd(cwd).await;
                launch::resolve_registry(
                    &entry,
                    cwd,
                    &self.binary_cache,
                    &*self.package_cache,
                    &shell_path,
                )
                .await?
            }
            SessionTarget::Custom { id } => {
                let server = self.custom.find(&id).ok_or_else(|| {
                    NexError::Agent(format!("unknown custom server `{id}`"))
                })?;
                let shell_path = self.path_for_cwd(cwd).await;
                launch::resolve_custom(&server.command, server.env.clone(), cwd, &shell_path)?
            }
            SessionTarget::Native => unreachable!("native target handled above"),
        };
        self.acp.create_session(app, conversation_id, spec).await
    }

    /// Registry agents on the whitelist only (Claude Code / Codex / Cursor).
    /// Custom servers are managed in Settings but omitted from the New-
    /// Conversation dropdown this phase.
    pub fn list_servers(&self) -> Vec<ServerDescriptor> {
        let mut out = vec![Self::native_descriptor()];
        for e in self.registry.list() {
            if !WHITELISTED_REGISTRY_IDS.contains(&e.id.as_str()) {
                continue;
            }
            out.push(self.registry_entry_to_descriptor(&e));
        }
        out
    }

    /// Full list including custom servers (Settings page).
    pub fn list_all_servers(&self) -> Vec<ServerDescriptor> {
        let mut out = self.list_servers();
        for c in self.custom.list() {
            out.push(ServerDescriptor {
                id: c.id,
                name: c.name,
                version: String::new(),
                installed_version: None,
                description: c.command.clone(),
                icon: None,
                kind: ServerKind::Custom,
            });
        }
        // Also include non-whitelisted registry agents for settings visibility.
        for e in self.registry.list() {
            if WHITELISTED_REGISTRY_IDS.contains(&e.id.as_str()) {
                continue;
            }
            out.push(self.registry_entry_to_descriptor(&e));
        }
        out
    }

    /// Descriptor for the built-in in-process native agent. Always pinned to
    /// the top of the dropdown; `installed_version` equals `version` so the
    /// UI never shows an update badge for it.
    fn native_descriptor() -> ServerDescriptor {
        let version = env!("CARGO_PKG_VERSION").to_string();
        ServerDescriptor {
            id: NATIVE_AGENT_ID.to_string(),
            name: "Nex Agent".to_string(),
            version: version.clone(),
            installed_version: Some(version),
            description: "内置原生编码 agent（DeepSeek）".to_string(),
            icon: None,
            kind: ServerKind::Native,
        }
    }

    /// Build a `ServerDescriptor` from a `RegistryEntry`, filling the cached
    /// `installed_version` by inspecting `PackageCache`.
    fn registry_entry_to_descriptor(
        &self,
        e: &super::registry::RegistryEntry,
    ) -> ServerDescriptor {
        let installed_version = self.package_cache.newest_installed_version(&e.id);
        ServerDescriptor {
            id: e.id.clone(),
            name: e.name.clone(),
            version: e.version.clone(),
            installed_version,
            description: e.description.clone(),
            icon: e.icon.clone(),
            kind: ServerKind::Registry,
        }
    }

    /// Forces a registry fetch (ignoring the throttle); used by the UI's
    /// refresh action.
    pub async fn refresh_registry(&self) -> Result<(), NexError> {
        self.registry.refresh().await
    }

    pub fn custom_upsert(&self, server: CustomServer) -> Result<(), NexError> {
        self.custom.upsert(server)
    }

    pub fn custom_delete(&self, id: &str) -> Result<(), NexError> {
        self.custom.delete(id)
    }

    // --- Delegates to the ACP transport (session lifecycle) ---

    pub async fn send_prompt(&self, session_id: &str, blocks: Vec<PromptBlock>) -> Result<(), NexError> {
        self.acp.send_prompt(session_id, blocks).await
    }

    pub async fn set_session_mode(&self, session_id: &str, mode_id: &str) -> Result<(), NexError> {
        self.acp.set_session_mode(session_id, mode_id).await
    }

    pub async fn set_session_model(&self, session_id: &str, model_id: &str) -> Result<(), NexError> {
        self.acp.set_session_model(session_id, model_id).await
    }

    pub async fn set_session_config_option(
        &self,
        session_id: &str,
        config_id: &str,
        value: &str,
    ) -> Result<Option<Vec<super::types::SessionConfigOptionDto>>, NexError> {
        self.acp
            .set_session_config_option(session_id, config_id, value)
            .await
    }

    pub async fn cancel(&self, session_id: &str) -> Result<(), NexError> {
        self.acp.cancel(session_id).await
    }

    pub fn respond_permission(&self, request_id: &str, option_id: Option<String>) -> Result<(), NexError> {
        self.acp.respond_permission(request_id, option_id)
    }

    pub fn remove_session(&self, session_id: &str) {
        self.acp.remove_session(session_id);
    }
}
