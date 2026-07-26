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
use super::registry::{RegistryEntry, RegistryStore};
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
}

/// One row in the frontend's agent dropdown.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerDescriptor {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    pub icon: Option<String>,
    pub kind: ServerKind,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ServerKind {
    Registry,
    Custom,
}

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
}

impl AgentSessionManager {
    pub fn new(app_data_dir: &Path) -> Self {
        Self {
            registry: Arc::new(RegistryStore::new(app_data_dir)),
            custom: Arc::new(CustomStore::new(app_data_dir)),
            binary_cache: BinaryCache::new(app_data_dir),
            acp: AcpSessionManager::new(),
        }
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
                launch::resolve_registry(&entry, cwd, &self.binary_cache).await?
            }
            SessionTarget::Custom { id } => {
                let server = self.custom.find(&id).ok_or_else(|| {
                    NexError::Agent(format!("unknown custom server `{id}`"))
                })?;
                launch::resolve_custom(&server.command, server.env.clone(), cwd)?
            }
        };
        self.acp.create_session(app, conversation_id, spec).await
    }

    /// Registry agents on the whitelist only (Claude Code / Codex / Cursor).
    /// Custom servers are managed in Settings but omitted from the New-
    /// Conversation dropdown this phase.
    pub fn list_servers(&self) -> Vec<ServerDescriptor> {
        let mut out = Vec::new();
        for e in self.registry.list() {
            if !WHITELISTED_REGISTRY_IDS.contains(&e.id.as_str()) {
                continue;
            }
            out.push(ServerDescriptor {
                id: e.id,
                name: e.name,
                version: e.version,
                description: e.description,
                icon: e.icon,
                kind: ServerKind::Registry,
            });
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
            out.push(ServerDescriptor {
                id: e.id,
                name: e.name,
                version: e.version,
                description: e.description,
                icon: e.icon,
                kind: ServerKind::Registry,
            });
        }
        out
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
