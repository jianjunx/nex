//! Configuration for the in-process Nex native agent.
//!
//! Persisted as a standalone `nex-agent.json` inside the app data dir. Provider
//! credentials can be referenced through an environment variable so the secret
//! itself never enters the file; legacy inline `api_key` values remain supported
//! for backwards compatibility. The same struct doubles as the Tauri DTO: it
//! serializes to camelCase so the frontend settings panel can read/write it
//! directly.
//!
//! The config supports multiple OpenAI-compatible providers, each with its own
//! model list. Models are referenced across the app by a composite id of the
//! form `<providerId>/<modelId>`.

use std::io::Write;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::error::NexError;

/// File name of the native-agent config inside the app data dir.
pub const NATIVE_CONFIG_FILE: &str = "nex-agent.json";

/// OS-level boundary used for shell tools. `ApprovalOnly` preserves legacy
/// behavior; workspace modes restrict file writes and can additionally remove
/// network access where a native sandbox backend is available.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ShellSandboxMode {
    #[default]
    ApprovalOnly,
    WorkspaceWrite,
    WorkspaceWriteNoNetwork,
}

/// HTTP surface used by an OpenAI-compatible provider. `Auto` keeps existing
/// gateways on Chat Completions while selecting Responses for OpenAI's own
/// endpoint, where typed output items and encrypted reasoning are available.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProviderApiMode {
    #[default]
    Auto,
    ChatCompletions,
    Responses,
}

impl ProviderApiMode {
    pub fn uses_responses(self, base_url: &str) -> bool {
        match self {
            Self::Responses => true,
            Self::ChatCompletions => false,
            Self::Auto => base_url.to_ascii_lowercase().contains("api.openai.com"),
        }
    }
}

/// Whether a model accepts the `reasoning_effort` parameter.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ReasoningSupport {
    /// Not verified yet: send `reasoning_effort` and learn from errors.
    #[default]
    Unknown,
    /// Confirmed to accept `reasoning_effort`.
    Yes,
    /// Confirmed to reject it; the harness skips the parameter.
    No,
}

/// Where the current Composer reasoning ladder came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ReasoningSource {
    /// No controllable reasoning (or not yet classified).
    #[default]
    None,
    /// Family / id heuristics.
    Heuristic,
    /// Declared by the provider `/models` payload (OpenRouter-style).
    Api,
    /// Learned by probing the chat-completions endpoint.
    Probe,
    /// Explicitly set in Settings.
    Manual,
}

/// Static capability flags inferred (or later refined) for a model.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ModelCapabilities {
    pub tools: bool,
    pub vision: bool,
    pub reasoning: bool,
}

impl Default for ModelCapabilities {
    fn default() -> Self {
        Self {
            tools: true,
            vision: false,
            reasoning: false,
        }
    }
}

/// A single model entry inside a provider.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ModelEntry {
    /// Wire model id, e.g. `deepseek-chat`.
    pub id: String,
    /// Runtime-learned reasoning-parameter support.
    pub reasoning_support: ReasoningSupport,
    /// Inferred / detected capability flags.
    pub capabilities: ModelCapabilities,
    /// Composer-selectable reasoning effort ids (e.g. `off`, `low`, `xhigh`).
    /// Empty when the model does not expose controllable reasoning.
    #[serde(default)]
    pub reasoning_levels: Vec<String>,
    /// Per-model context window in tokens. `None` / unset means no limit
    /// (compression off for this model unless the global agent fallback is set).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_window: Option<u32>,
    /// When true, Settings owns reasoning on/off + levels; auto refresh must
    /// not overwrite them (runtime `No` still applies only when not manual).
    #[serde(default)]
    pub reasoning_manual: bool,
    /// Provenance of `reasoning_levels` (drives load-time refresh policy).
    #[serde(default)]
    pub reasoning_source: ReasoningSource,
}

impl Default for ModelEntry {
    fn default() -> Self {
        Self {
            id: String::new(),
            reasoning_support: ReasoningSupport::Unknown,
            capabilities: ModelCapabilities::default(),
            reasoning_levels: Vec::new(),
            context_window: None,
            reasoning_manual: false,
            reasoning_source: ReasoningSource::None,
        }
    }
}

/// One OpenAI-compatible endpoint plus its credentials and model list.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ProviderEntry {
    /// Stable id used in composite model ids (`<providerId>/<modelId>`).
    pub id: String,
    /// Human-readable provider name shown in the UI.
    pub name: String,
    /// OpenAI-compatible base URL (host or `…/v1`; no `/chat/completions`).
    /// Missing `/vN` is injected when building request URLs.
    pub base_url: String,
    /// Legacy inline API key. Prefer `api_key_env` so persisted config contains
    /// only a variable name, not the credential itself.
    pub api_key: String,
    /// Environment variable containing the API key, for example
    /// `OPENAI_API_KEY`. When set it takes precedence over `api_key`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_key_env: Option<String>,
    /// Opaque account id in the operating system credential store.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_key_credential: Option<String>,
    /// Provider protocol. `Auto` uses Responses only for api.openai.com and
    /// otherwise preserves broad Chat Completions compatibility.
    #[serde(default)]
    pub api_mode: ProviderApiMode,
    /// Models offered through this provider.
    pub models: Vec<ModelEntry>,
}

impl Default for ProviderEntry {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: String::new(),
            base_url: "https://api.deepseek.com/v1".to_string(),
            api_key: String::new(),
            api_key_env: None,
            api_key_credential: None,
            api_mode: ProviderApiMode::Auto,
            models: Vec::new(),
        }
    }
}

impl ProviderEntry {
    /// Resolves the provider credential without copying an environment-backed
    /// secret into persisted configuration or returning it to the settings UI.
    pub fn resolve_api_key(&self) -> Result<String, NexError> {
        if let Some(name) = self
            .api_key_env
            .as_deref()
            .map(str::trim)
            .filter(|name| !name.is_empty())
        {
            return std::env::var(name).map_err(|_| {
                NexError::Agent(format!(
                    "provider `{}` requires environment variable `{name}`",
                    self.name
                ))
            });
        }
        if let Some(id) = self
            .api_key_credential
            .as_deref()
            .map(str::trim)
            .filter(|id| !id.is_empty())
        {
            return super::secrets::get(id).map_err(|error| {
                NexError::Agent(format!(
                    "provider `{}` credential is unavailable: {error}",
                    self.name
                ))
            });
        }
        if self.api_key.trim().is_empty() {
            return Err(NexError::Agent(format!(
                "provider `{}` has no API key configured",
                self.name
            )));
        }
        Ok(self.api_key.clone())
    }
}

/// Agent-loop tuning knobs.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AgentParams {
    /// Max tool-call loop iterations per prompt turn. Always positive: a hard
    /// cap is the final safety net when a model keeps making superficially
    /// successful but unproductive calls.
    pub max_steps: u32,
    /// Global fallback context window in tokens when the selected model has no
    /// per-model `contextWindow`. `0` disables compression.
    pub context_window: u32,
    /// Distinguishes "user set 0 to disable compression" from the old factory
    /// default of 0. One-shot: load() lifts unmarked 0 → 200k.
    #[serde(default)]
    pub context_window_migrated: bool,
    /// Synchronous `bash` tool timeout in seconds.
    pub bash_timeout_secs: u64,
    /// Shell process isolation policy. Workspace modes fail closed when the
    /// current platform has no supported sandbox backend.
    pub shell_sandbox: ShellSandboxMode,
    /// Max concurrent subagents launched by the `fleet` tool.
    pub max_subagent_concurrency: u32,
    /// After a turn that mutated the workspace, automatically run `/review`.
    #[serde(default)]
    pub auto_review: bool,
    /// User-owned lifecycle hooks. Repository files cannot add hooks.
    #[serde(default)]
    pub hooks: Vec<super::hooks::HookCommand>,
}

/// An explicit trust decision for one MCP server declared by a project.
///
/// Project MCP files are executable configuration: a stdio entry can spawn an
/// arbitrary command before the model has made a tool call.  Bind approval to
/// both the canonical project path and the exact file bytes so copying a
/// project or changing its `.nex/mcp.json` requires a fresh user decision.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectMcpApproval {
    pub project_path: String,
    pub config_hash: String,
    pub server_name: String,
}

impl Default for AgentParams {
    fn default() -> Self {
        Self {
            // Large enough for multi-file work, finite enough to bound a
            // model/tool loop that keeps reporting nominal success.
            max_steps: 64,
            context_window: 200_000,
            context_window_migrated: true,
            bash_timeout_secs: 120,
            shell_sandbox: ShellSandboxMode::ApprovalOnly,
            max_subagent_concurrency: 6,
            auto_review: false,
            hooks: Vec::new(),
        }
    }
}

/// Root config object for the native agent.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct NativeAgentConfig {
    /// All configured providers.
    pub providers: Vec<ProviderEntry>,
    /// Composite `<providerId>/<modelId>` used for fresh sessions; falls back
    /// to the first model of the first provider when unset or dangling.
    pub default_model: Option<String>,
    pub agent: AgentParams,
    /// Skill folder names skipped when building the session catalog.
    #[serde(default)]
    pub disabled_skills: Vec<String>,
    /// MCP server names skipped when connecting for a session.
    #[serde(default)]
    pub disabled_mcp_servers: Vec<String>,
    /// Explicitly trusted servers from project-local `.nex/mcp.json` files.
    /// Global MCP configuration is managed separately and does not use this
    /// allowlist.
    #[serde(default)]
    pub approved_project_mcp_servers: Vec<ProjectMcpApproval>,
}

impl Default for NativeAgentConfig {
    fn default() -> Self {
        let chat = crate::agent::native::capabilities::detect("deepseek-chat");
        Self {
            providers: vec![ProviderEntry {
                id: "deepseek".to_string(),
                name: "DeepSeek".to_string(),
                base_url: "https://api.deepseek.com/v1".to_string(),
                api_key: String::new(),
                api_key_env: None,
                api_key_credential: None,
                api_mode: ProviderApiMode::Auto,
                models: vec![chat],
            }],
            default_model: None,
            agent: AgentParams::default(),
            disabled_skills: Vec::new(),
            disabled_mcp_servers: Vec::new(),
            approved_project_mcp_servers: Vec::new(),
        }
    }
}

impl NativeAgentConfig {
    /// Loads the config from `dir/nex-agent.json`. Missing or malformed files
    /// fall back to defaults (a fresh install has no config yet). Legacy
    /// single-provider files are migrated in place on read. The old hard-cap
    /// default (`maxSteps: 0` / legacy `40`) is lifted to the bounded v1.1.7
    /// default once.
    pub fn load(dir: &Path) -> Self {
        let path = dir.join(NATIVE_CONFIG_FILE);
        let Ok(bytes) = std::fs::read(&path) else {
            return Self::default();
        };
        let mut cfg = match serde_json::from_slice::<serde_json::Value>(&bytes) {
            Ok(value) => {
                if Self::is_legacy(&value) {
                    log::info!("migrating legacy single-provider native-agent config");
                    Self::migrate_legacy(value)
                } else {
                    serde_json::from_value(value).unwrap_or_else(|e| {
                        log::warn!("ignoring unreadable native-agent config: {e}");
                        Self::default()
                    })
                }
            }
            Err(e) => {
                log::warn!("ignoring unreadable native-agent config: {e}");
                Self::default()
            }
        };
        // Prior defaults allowed an unbounded loop (`0`) or used the old 40
        // step cap. Both are product defaults, not a reliable user intent, so
        // migrate them to the bounded v1.1.7 default.
        if cfg.agent.max_steps == 0 || cfg.agent.max_steps == 40 {
            log::info!(
                "migrating native-agent maxSteps {} → 64 (bounded default)",
                cfg.agent.max_steps
            );
            cfg.agent.max_steps = AgentParams::default().max_steps;
            let _ = cfg.save(dir);
        }
        // Product default used to be 0 (compression off). Lift unmarked
        // zeros to 200k once; a later explicit 0 (migrated=true) stays off.
        if !cfg.agent.context_window_migrated {
            if cfg.agent.context_window == 0 {
                log::info!("migrating native-agent contextWindow 0 → 200000");
                cfg.agent.context_window = 200_000;
            }
            cfg.agent.context_window_migrated = true;
            let _ = cfg.save(dir);
        }
        // Re-apply family heuristics on load for heuristic-sourced entries so
        // Composer ladders stay current when detection rules improve. Manual /
        // API / probe ladders are preserved. Never overwrite a user-/API-set
        // context_window.
        let mut dirty = false;
        for p in &mut cfg.providers {
            for m in &mut p.models {
                let refreshed = crate::agent::native::capabilities::refresh(m);
                if *m != refreshed {
                    *m = refreshed;
                    dirty = true;
                }
            }
        }
        if dirty {
            let _ = cfg.save(dir);
        }
        cfg
    }

    /// Legacy shape: a top-level `provider` object and no `providers` array.
    fn is_legacy(value: &serde_json::Value) -> bool {
        value.get("provider").is_some_and(|p| p.is_object())
            && !value.get("providers").is_some_and(|p| p.is_array())
    }

    /// Converts a legacy single-provider config into the multi-provider shape.
    /// The legacy `reasoning` field is dropped: reasoning effort is now a
    /// per-session choice made in the Composer.
    fn migrate_legacy(value: serde_json::Value) -> Self {
        let provider = value.get("provider").cloned().unwrap_or_default();
        let model_id = provider
            .get("model")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .unwrap_or("deepseek-chat")
            .to_string();
        let entry = ProviderEntry {
            id: "deepseek".to_string(),
            name: "DeepSeek".to_string(),
            base_url: provider
                .get("baseUrl")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .unwrap_or("https://api.deepseek.com/v1")
                .to_string(),
            api_key: provider
                .get("apiKey")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string(),
            api_key_env: None,
            api_key_credential: None,
            api_mode: ProviderApiMode::Auto,
            models: vec![crate::agent::native::capabilities::detect(&model_id)],
        };
        let agent: AgentParams = value
            .get("agent")
            .cloned()
            .and_then(|a| serde_json::from_value(a).ok())
            .unwrap_or_default();
        Self {
            providers: vec![entry],
            default_model: None,
            agent,
            disabled_skills: Vec::new(),
            disabled_mcp_servers: Vec::new(),
            approved_project_mcp_servers: Vec::new(),
        }
    }

    /// Persists the config to `dir/nex-agent.json` (pretty-printed).
    pub fn save(&self, dir: &Path) -> Result<(), NexError> {
        let _ = std::fs::create_dir_all(dir);
        let path = dir.join(NATIVE_CONFIG_FILE);
        let mut persisted = self.clone();
        for provider in &mut persisted.providers {
            if provider
                .api_key_env
                .as_deref()
                .is_some_and(|name| !name.trim().is_empty())
                || provider
                    .api_key_credential
                    .as_deref()
                    .is_some_and(|id| !id.trim().is_empty())
            {
                // A reference-backed provider must never retain a stale inline
                // credential, even when an older/external client sends both.
                provider.api_key.clear();
            }
        }
        let json = serde_json::to_vec_pretty(&persisted).map_err(|e| {
            NexError::Internal(format!("failed to serialize native-agent config: {e}"))
        })?;
        let mut options = std::fs::OpenOptions::new();
        options.create(true).write(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(&path)
            .map_err(|e| NexError::Internal(format!("failed to open native-agent config: {e}")))?;
        file.write_all(&json)
            .map_err(|e| NexError::Internal(format!("failed to write native-agent config: {e}")))?;
        file.sync_all()
            .map_err(|e| NexError::Internal(format!("failed to flush native-agent config: {e}")))?;
        #[cfg(unix)]
        std::fs::set_permissions(&path, {
            use std::os::unix::fs::PermissionsExt;
            std::fs::Permissions::from_mode(0o600)
        })
        .map_err(|e| NexError::Internal(format!("failed to protect native-agent config: {e}")))?;
        Ok(())
    }

    /// Resolves a composite `<providerId>/<modelId>` to its entries.
    pub fn resolve_model(&self, composite: &str) -> Option<(&ProviderEntry, &ModelEntry)> {
        let (pid, mid) = composite.split_once('/')?;
        let provider = self.providers.iter().find(|p| p.id == pid)?;
        let model = provider.models.iter().find(|m| m.id == mid)?;
        Some((provider, model))
    }

    /// The composite id used for fresh sessions: `default_model` when it
    /// resolves, otherwise the first model of the first provider.
    pub fn default_selection(&self) -> Option<String> {
        if let Some(sel) = &self.default_model {
            if self.resolve_model(sel).is_some() {
                return Some(sel.clone());
            }
        }
        for p in &self.providers {
            if let Some(m) = p.models.first() {
                return Some(format!("{}/{}", p.id, m.id));
            }
        }
        None
    }

    /// Records runtime-learned reasoning support for a composite model id.
    /// Returns `true` when the entry existed and was changed.
    pub fn set_reasoning_support(&mut self, composite: &str, support: ReasoningSupport) -> bool {
        let Some((pid, mid)) = composite.split_once('/') else {
            return false;
        };
        for p in self.providers.iter_mut() {
            if p.id != pid {
                continue;
            }
            for m in p.models.iter_mut() {
                if m.id == mid {
                    if m.reasoning_support == support {
                        return false;
                    }
                    m.reasoning_support = support;
                    if support == ReasoningSupport::No {
                        m.capabilities.reasoning = false;
                        m.reasoning_levels.clear();
                        if !m.reasoning_manual {
                            m.reasoning_source = ReasoningSource::None;
                        }
                    }
                    return true;
                }
            }
        }
        false
    }

    /// Reasoning levels exposed in the Composer for a composite model id.
    pub fn reasoning_levels_for(&self, composite: &str) -> Vec<String> {
        match self.resolve_model(composite) {
            Some((_, m)) if m.reasoning_support != ReasoningSupport::No => {
                if m.capabilities.reasoning || !m.reasoning_levels.is_empty() {
                    m.reasoning_levels.clone()
                } else {
                    Vec::new()
                }
            }
            _ => Vec::new(),
        }
    }

    /// Effective context window for a composite model id.
    /// Prefers the model's own `context_window` when set (>0); otherwise the
    /// global `agent.context_window` fallback. `0` means compression off.
    pub fn context_window_for(&self, composite: &str) -> u64 {
        if let Some((_, m)) = self.resolve_model(composite) {
            if let Some(w) = m.context_window {
                if w > 0 {
                    return w as u64;
                }
            }
        }
        self.agent.context_window as u64
    }

    /// Clamp values received from an older or external Settings client before
    /// persisting them. `0` used to mean unlimited and is no longer safe.
    pub fn normalize_agent_limits(&mut self) {
        if self.agent.max_steps == 0 {
            self.agent.max_steps = AgentParams::default().max_steps;
        }
    }

    /// Whether a project-local MCP server is trusted for the exact current
    /// config file. A changed hash deliberately invalidates this decision.
    pub fn project_mcp_is_approved(
        &self,
        project_path: &str,
        config_hash: &str,
        server_name: &str,
    ) -> bool {
        self.approved_project_mcp_servers.iter().any(|approval| {
            approval.project_path == project_path
                && approval.config_hash == config_hash
                && approval.server_name == server_name
        })
    }

    /// Records or revokes approval for one project MCP server. Replacing older
    /// approvals for the same path/name keeps config migration from retaining
    /// stale hashes indefinitely.
    pub fn set_project_mcp_approved(
        &mut self,
        project_path: String,
        config_hash: String,
        server_name: String,
        enabled: bool,
    ) {
        self.approved_project_mcp_servers.retain(|approval| {
            approval.project_path != project_path || approval.server_name != server_name
        });
        if enabled {
            self.approved_project_mcp_servers.push(ProjectMcpApproval {
                project_path,
                config_hash,
                server_name,
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_round_trip() {
        let cfg = NativeAgentConfig::default();
        assert_eq!(cfg.providers.len(), 1);
        assert_eq!(cfg.providers[0].models[0].id, "deepseek-chat");
        assert_eq!(cfg.agent.max_steps, 64);
        assert_eq!(cfg.agent.context_window, 200_000);
        assert_eq!(cfg.agent.shell_sandbox, ShellSandboxMode::ApprovalOnly);
        let json = serde_json::to_string(&cfg).unwrap();
        let back: NativeAgentConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(back.providers[0].base_url, cfg.providers[0].base_url);
    }

    #[test]
    fn load_migrates_old_max_steps_default_to_bounded_limit() {
        let tmp = std::env::temp_dir().join(format!("nex-cfg-maxsteps-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let mut cfg = NativeAgentConfig::default();
        cfg.agent.max_steps = 40;
        cfg.save(&tmp).unwrap();
        let loaded = NativeAgentConfig::load(&tmp);
        assert_eq!(loaded.agent.max_steps, 64);
        // Persisted so the next launch does not re-migrate other intentional values.
        let disk: NativeAgentConfig =
            serde_json::from_slice(&std::fs::read(tmp.join(NATIVE_CONFIG_FILE)).unwrap()).unwrap();
        assert_eq!(disk.agent.max_steps, 64);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn load_migrates_old_zero_context_window_default() {
        let tmp = std::env::temp_dir().join(format!("nex-cfg-ctxwin-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        std::fs::write(
            tmp.join(NATIVE_CONFIG_FILE),
            r#"{"providers":[],"agent":{"maxSteps":0,"contextWindow":0,"bashTimeoutSecs":120,"maxSubagentConcurrency":6}}"#,
        )
        .unwrap();
        let loaded = NativeAgentConfig::load(&tmp);
        assert_eq!(loaded.agent.context_window, 200_000);
        assert!(loaded.agent.context_window_migrated);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn load_preserves_explicit_zero_context_window_after_migration() {
        let tmp = std::env::temp_dir().join(format!("nex-cfg-ctxwin-off-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        std::fs::write(
            tmp.join(NATIVE_CONFIG_FILE),
            r#"{"providers":[],"agent":{"maxSteps":0,"contextWindow":0,"contextWindowMigrated":true,"bashTimeoutSecs":120,"maxSubagentConcurrency":6}}"#,
        )
        .unwrap();
        let loaded = NativeAgentConfig::load(&tmp);
        assert_eq!(loaded.agent.context_window, 0);
        assert!(loaded.agent.context_window_migrated);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn load_missing_returns_default() {
        let tmp = std::env::temp_dir().join(format!("nex-cfg-missing-{}", std::process::id()));
        let cfg = NativeAgentConfig::load(&tmp);
        assert_eq!(cfg.providers[0].base_url, "https://api.deepseek.com/v1");
    }

    #[test]
    fn camelcase_field_names() {
        let cfg = NativeAgentConfig::default();
        let json = serde_json::to_value(&cfg).unwrap();
        assert!(json.get("providers").unwrap().is_array());
        assert!(json.get("agent").unwrap().get("bashTimeoutSecs").is_some());
        assert!(json.get("disabledSkills").unwrap().is_array());
        let p0 = &json["providers"][0];
        assert!(p0.get("baseUrl").is_some());
        assert!(p0.get("apiKey").is_some());
        assert!(p0["models"][0].get("capabilities").is_some());
    }

    #[test]
    fn legacy_config_migrates() {
        let legacy = serde_json::json!({
            "provider": {
                "baseUrl": "https://api.deepseek.com",
                "apiKey": "sk-test",
                "model": "deepseek-chat",
                "reasoning": "high"
            },
            "agent": { "maxSteps": 25, "contextWindow": 0, "bashTimeoutSecs": 60, "maxSubagentConcurrency": 4 }
        });
        let cfg = NativeAgentConfig::migrate_legacy(legacy);
        assert_eq!(cfg.providers.len(), 1);
        let p = &cfg.providers[0];
        assert_eq!(p.name, "DeepSeek");
        assert_eq!(p.api_key, "sk-test");
        assert_eq!(p.models[0].id, "deepseek-chat");
        assert_eq!(cfg.agent.max_steps, 25);
        assert_eq!(
            cfg.default_selection().as_deref(),
            Some("deepseek/deepseek-chat")
        );
    }

    #[test]
    fn resolve_and_selection() {
        let mut cfg = NativeAgentConfig::default();
        cfg.providers.push(ProviderEntry {
            id: "moonshot".to_string(),
            name: "Moonshot".to_string(),
            base_url: "https://api.moonshot.cn/v1".to_string(),
            api_key: "k".to_string(),
            api_key_env: None,
            api_key_credential: None,
            api_mode: ProviderApiMode::Auto,
            models: vec![crate::agent::native::capabilities::detect("kimi-k2")],
        });
        assert!(cfg.resolve_model("deepseek/deepseek-chat").is_some());
        assert!(cfg.resolve_model("moonshot/kimi-k2").is_some());
        assert!(cfg.resolve_model("nope/x").is_none());
        assert!(cfg.resolve_model("deepseek").is_none());

        // Default falls back to the first provider's first model.
        assert_eq!(
            cfg.default_selection().as_deref(),
            Some("deepseek/deepseek-chat")
        );
        cfg.default_model = Some("moonshot/kimi-k2".to_string());
        assert_eq!(cfg.default_selection().as_deref(), Some("moonshot/kimi-k2"));
        // A dangling default falls back instead of erroring.
        cfg.default_model = Some("gone/gone".to_string());
        assert_eq!(
            cfg.default_selection().as_deref(),
            Some("deepseek/deepseek-chat")
        );
    }

    #[test]
    fn set_reasoning_support_updates_entry() {
        let mut cfg = NativeAgentConfig::default();
        // Force a reasoning model first.
        cfg.providers[0].models[0] =
            crate::agent::native::capabilities::detect("deepseek-reasoner");
        assert!(cfg.set_reasoning_support("deepseek/deepseek-reasoner", ReasoningSupport::No));
        let m = cfg.resolve_model("deepseek/deepseek-reasoner").unwrap().1;
        assert_eq!(m.reasoning_support, ReasoningSupport::No);
        assert!(m.reasoning_levels.is_empty());
        assert!(!cfg.set_reasoning_support("deepseek/deepseek-reasoner", ReasoningSupport::No));
        assert!(!cfg.set_reasoning_support("deepseek/missing", ReasoningSupport::No));
        assert!(!cfg.set_reasoning_support("no-slash", ReasoningSupport::No));
    }

    #[test]
    fn old_model_entry_without_capabilities_deserializes() {
        let json = r#"{"providers":[{"id":"p","name":"P","baseUrl":"https://x/v1","apiKey":"k","models":[{"id":"m","reasoningSupport":"unknown"}]}],"agent":{}}"#;
        let cfg: NativeAgentConfig = serde_json::from_str(json).unwrap();
        assert_eq!(cfg.providers[0].models[0].id, "m");
        assert!(cfg.providers[0].models[0].capabilities.tools);
    }

    #[test]
    fn provider_key_can_come_from_environment_without_persisting_secret() {
        let env_name = format!("NEX_TEST_API_KEY_{}", std::process::id());
        std::env::set_var(&env_name, "secret-from-env");
        let provider = ProviderEntry {
            id: "test".into(),
            name: "Test".into(),
            base_url: "https://example.test/v1".into(),
            api_key: String::new(),
            api_key_env: Some(env_name.clone()),
            api_key_credential: None,
            api_mode: ProviderApiMode::Auto,
            models: Vec::new(),
        };
        assert_eq!(provider.resolve_api_key().unwrap(), "secret-from-env");
        let json = serde_json::to_string(&provider).unwrap();
        assert!(json.contains(&env_name));
        assert!(!json.contains("secret-from-env"));
        std::env::remove_var(env_name);
    }

    #[test]
    fn save_scrubs_inline_key_when_environment_reference_is_set() {
        let tmp = tempfile::tempdir().unwrap();
        let mut config = NativeAgentConfig::default();
        config.providers[0].api_key = "must-not-persist".into();
        config.providers[0].api_key_env = Some("DEEPSEEK_API_KEY".into());
        config.save(tmp.path()).unwrap();

        let disk = std::fs::read_to_string(tmp.path().join(NATIVE_CONFIG_FILE)).unwrap();
        assert!(disk.contains("DEEPSEEK_API_KEY"));
        assert!(!disk.contains("must-not-persist"));
    }

    #[cfg(unix)]
    #[test]
    fn saved_config_is_owner_read_write_only() {
        use std::os::unix::fs::PermissionsExt;

        let tmp = tempfile::tempdir().unwrap();
        NativeAgentConfig::default().save(tmp.path()).unwrap();
        let mode = std::fs::metadata(tmp.path().join(NATIVE_CONFIG_FILE))
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o600);
    }
}
