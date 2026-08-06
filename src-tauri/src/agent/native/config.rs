//! Configuration for the in-process Nex native agent.
//!
//! Persisted as a standalone `nex-agent.json` inside the app data dir (the user
//! explicitly chose the config-file approach, accepting that `api_key` is stored
//! in plaintext). The same struct doubles as the Tauri DTO: it serializes to
//! camelCase so the frontend settings panel can read/write it directly.

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::error::NexError;

/// File name of the native-agent config inside the app data dir.
pub const NATIVE_CONFIG_FILE: &str = "nex-agent.json";

/// DeepSeek-compatible endpoint + credentials.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ProviderConfig {
    /// OpenAI-compatible base URL (no trailing `/chat/completions`).
    pub base_url: String,
    /// API key. Stored in plaintext on disk (accepted trade-off).
    pub api_key: String,
    /// Model id, e.g. `deepseek-chat` or `deepseek-reasoner`.
    pub model: String,
    /// Reasoning effort hint forwarded to the provider (`off|low|medium|high`).
    pub reasoning: String,
}

impl Default for ProviderConfig {
    fn default() -> Self {
        Self {
            base_url: "https://api.deepseek.com".to_string(),
            api_key: String::new(),
            model: "deepseek-chat".to_string(),
            reasoning: "off".to_string(),
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
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct NativeAgentConfig {
    pub provider: ProviderConfig,
    pub agent: AgentParams,
}

impl NativeAgentConfig {
    /// Loads the config from `dir/nex-agent.json`. Missing or malformed files
    /// fall back to defaults (a fresh install has no config yet).
    pub fn load(dir: &Path) -> Self {
        let path = dir.join(NATIVE_CONFIG_FILE);
        match std::fs::read(&path) {
            Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_else(|e| {
                log::warn!("ignoring unreadable native-agent config: {e}");
                Self::default()
            }),
            Err(_) => Self::default(),
        }
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
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_round_trip() {
        let cfg = NativeAgentConfig::default();
        assert_eq!(cfg.provider.model, "deepseek-chat");
        assert_eq!(cfg.agent.max_steps, 40);
        let json = serde_json::to_string(&cfg).unwrap();
        let back: NativeAgentConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(back.provider.base_url, cfg.provider.base_url);
    }

    #[test]
    fn load_missing_returns_default() {
        let tmp = std::env::temp_dir().join(format!("nex-cfg-{}", std::process::id()));
        let cfg = NativeAgentConfig::load(&tmp);
        assert_eq!(cfg.provider.base_url, "https://api.deepseek.com");
    }

    #[test]
    fn camelcase_field_names() {
        let cfg = NativeAgentConfig::default();
        let json = serde_json::to_value(&cfg).unwrap();
        assert!(json.get("provider").unwrap().get("baseUrl").is_some());
        assert!(json.get("provider").unwrap().get("apiKey").is_some());
        assert!(json.get("agent").unwrap().get("bashTimeoutSecs").is_some());
    }
}
