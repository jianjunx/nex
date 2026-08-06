//! Configuration for the in-process Nex native agent.
//!
//! Persisted as a standalone `nex-agent.json` inside the app data dir (the user
//! explicitly chose the config-file approach, accepting that `api_key` is stored
//! in plaintext). The same struct doubles as the Tauri DTO: it serializes to
//! camelCase so the frontend settings panel can read/write it directly.
//!
//! The config supports multiple OpenAI-compatible providers, each with its own
//! model list. Models are referenced across the app by a composite id of the
//! form `<providerId>/<modelId>`.

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::error::NexError;

/// File name of the native-agent config inside the app data dir.
pub const NATIVE_CONFIG_FILE: &str = "nex-agent.json";

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

/// A single model entry inside a provider.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ModelEntry {
    /// Wire model id, e.g. `deepseek-chat`.
    pub id: String,
    /// Runtime-learned reasoning-parameter support.
    pub reasoning_support: ReasoningSupport,
}

impl Default for ModelEntry {
    fn default() -> Self {
        Self { id: String::new(), reasoning_support: ReasoningSupport::Unknown }
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
    /// OpenAI-compatible base URL (no trailing `/chat/completions`).
    pub base_url: String,
    /// API key. Stored in plaintext on disk (accepted trade-off).
    pub api_key: String,
    /// Models offered through this provider.
    pub models: Vec<ModelEntry>,
}

impl Default for ProviderEntry {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: String::new(),
            base_url: "https://api.deepseek.com".to_string(),
            api_key: String::new(),
            models: Vec::new(),
        }
    }
}

/// Agent-loop tuning knobs.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AgentParams {
    /// Max tool-call loop iterations per prompt turn.
    pub max_steps: u32,
    /// Context window in tokens; `0` disables compression (Phase 2).
    pub context_window: u32,
    /// Synchronous `bash` tool timeout in seconds.
    pub bash_timeout_secs: u64,
    /// Max concurrent subagents launched by the `fleet` tool.
    pub max_subagent_concurrency: u32,
}

impl Default for AgentParams {
    fn default() -> Self {
        Self {
            max_steps: 40,
            context_window: 0,
            bash_timeout_secs: 120,
            max_subagent_concurrency: 6,
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
}

impl Default for NativeAgentConfig {
    fn default() -> Self {
        Self {
            providers: vec![ProviderEntry {
                id: "deepseek".to_string(),
                name: "DeepSeek".to_string(),
                base_url: "https://api.deepseek.com".to_string(),
                api_key: String::new(),
                models: vec![ModelEntry {
                    id: "deepseek-chat".to_string(),
                    reasoning_support: ReasoningSupport::Unknown,
                }],
            }],
            default_model: None,
            agent: AgentParams::default(),
        }
    }
}

impl NativeAgentConfig {
    /// Loads the config from `dir/nex-agent.json`. Missing or malformed files
    /// fall back to defaults (a fresh install has no config yet). Legacy
    /// single-provider files are migrated in place on read.
    pub fn load(dir: &Path) -> Self {
        let path = dir.join(NATIVE_CONFIG_FILE);
        let Ok(bytes) = std::fs::read(&path) else { return Self::default() };
        match serde_json::from_slice::<serde_json::Value>(&bytes) {
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
        }
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
        let entry = ProviderEntry {
            id: "deepseek".to_string(),
            name: "DeepSeek".to_string(),
            base_url: provider
                .get("baseUrl")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .unwrap_or("https://api.deepseek.com")
                .to_string(),
            api_key: provider
                .get("apiKey")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string(),
            models: vec![ModelEntry {
                id: provider
                    .get("model")
                    .and_then(|v| v.as_str())
                    .filter(|s| !s.is_empty())
                    .unwrap_or("deepseek-chat")
                    .to_string(),
                reasoning_support: ReasoningSupport::Unknown,
            }],
        };
        let agent: AgentParams = value
            .get("agent")
            .cloned()
            .and_then(|a| serde_json::from_value(a).ok())
            .unwrap_or_default();
        Self { providers: vec![entry], default_model: None, agent }
    }

    /// Persists the config to `dir/nex-agent.json` (pretty-printed).
    pub fn save(&self, dir: &Path) -> Result<(), NexError> {
        let _ = std::fs::create_dir_all(dir);
        let path = dir.join(NATIVE_CONFIG_FILE);
        let json = serde_json::to_vec_pretty(self)
            .map_err(|e| NexError::Internal(format!("failed to serialize native-agent config: {e}")))?;
        std::fs::write(&path, json)
            .map_err(|e| NexError::Internal(format!("failed to write native-agent config: {e}")))?;
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
    pub fn set_reasoning_support(
        &mut self,
        composite: &str,
        support: ReasoningSupport,
    ) -> bool {
        let Some((pid, mid)) = composite.split_once('/') else { return false };
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
                    return true;
                }
            }
        }
        false
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
        assert_eq!(cfg.agent.max_steps, 40);
        let json = serde_json::to_string(&cfg).unwrap();
        let back: NativeAgentConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(back.providers[0].base_url, cfg.providers[0].base_url);
    }

    #[test]
    fn load_missing_returns_default() {
        let tmp = std::env::temp_dir().join(format!("nex-cfg-missing-{}", std::process::id()));
        let cfg = NativeAgentConfig::load(&tmp);
        assert_eq!(cfg.providers[0].base_url, "https://api.deepseek.com");
    }

    #[test]
    fn camelcase_field_names() {
        let cfg = NativeAgentConfig::default();
        let json = serde_json::to_value(&cfg).unwrap();
        assert!(json.get("providers").unwrap().is_array());
        assert!(json.get("agent").unwrap().get("bashTimeoutSecs").is_some());
        let p0 = &json["providers"][0];
        assert!(p0.get("baseUrl").is_some());
        assert!(p0.get("apiKey").is_some());
        assert_eq!(p0["models"][0]["reasoningSupport"], "unknown");
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
        assert_eq!(cfg.default_selection().as_deref(), Some("deepseek/deepseek-chat"));
    }

    #[test]
    fn resolve_and_selection() {
        let mut cfg = NativeAgentConfig::default();
        cfg.providers.push(ProviderEntry {
            id: "moonshot".to_string(),
            name: "Moonshot".to_string(),
            base_url: "https://api.moonshot.cn/v1".to_string(),
            api_key: "k".to_string(),
            models: vec![ModelEntry { id: "kimi-k2".to_string(), reasoning_support: ReasoningSupport::No }],
        });
        assert!(cfg.resolve_model("deepseek/deepseek-chat").is_some());
        assert!(cfg.resolve_model("moonshot/kimi-k2").is_some());
        assert!(cfg.resolve_model("nope/x").is_none());
        assert!(cfg.resolve_model("deepseek").is_none());

        // Default falls back to the first provider's first model.
        assert_eq!(cfg.default_selection().as_deref(), Some("deepseek/deepseek-chat"));
        cfg.default_model = Some("moonshot/kimi-k2".to_string());
        assert_eq!(cfg.default_selection().as_deref(), Some("moonshot/kimi-k2"));
        // A dangling default falls back instead of erroring.
        cfg.default_model = Some("gone/gone".to_string());
        assert_eq!(cfg.default_selection().as_deref(), Some("deepseek/deepseek-chat"));
    }

    #[test]
    fn set_reasoning_support_updates_entry() {
        let mut cfg = NativeAgentConfig::default();
        assert!(cfg.set_reasoning_support("deepseek/deepseek-chat", ReasoningSupport::No));
        assert_eq!(
            cfg.resolve_model("deepseek/deepseek-chat").unwrap().1.reasoning_support,
            ReasoningSupport::No
        );
        // Same value again is a no-op.
        assert!(!cfg.set_reasoning_support("deepseek/deepseek-chat", ReasoningSupport::No));
        assert!(!cfg.set_reasoning_support("deepseek/missing", ReasoningSupport::No));
        assert!(!cfg.set_reasoning_support("no-slash", ReasoningSupport::No));
    }
}
