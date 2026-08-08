use crate::agent::native::{bundled, home, mcp, skills};
use crate::agent::{CreateSessionResult, CustomServer, NativeAgentConfig, PromptBlock, ServerDescriptor, SessionTarget};
use crate::error::NexError;
use crate::state::AppState;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

/// The New-Conversation agent list (whitelisted registry agents only).
#[tauri::command]
pub fn agent_list_servers(state: State<AppState>) -> Vec<ServerDescriptor> {
    state.agent_manager.list_servers()
}

/// Full agent list including custom + non-whitelisted registry (Settings).
#[tauri::command]
pub fn agent_list_all_servers(state: State<AppState>) -> Vec<ServerDescriptor> {
    state.agent_manager.list_all_servers()
}

#[tauri::command]
pub async fn agent_refresh_registry(state: State<'_, AppState>) -> Result<(), NexError> {
    state.agent_manager.refresh_registry().await
}

#[tauri::command]
pub async fn agent_create_session(
    app: AppHandle,
    state: State<'_, AppState>,
    conversation_id: String,
    target: SessionTarget,
    cwd: String,
) -> Result<CreateSessionResult, NexError> {
    state.agent_manager.create_session(&app, &conversation_id, target, &cwd).await
}

#[tauri::command]
pub async fn agent_send_prompt(
    state: State<'_, AppState>,
    session_id: String,
    blocks: Vec<PromptBlock>,
) -> Result<(), NexError> {
    state.agent_manager.send_prompt(&session_id, blocks).await
}

#[tauri::command]
pub async fn agent_set_session_mode(
    state: State<'_, AppState>,
    session_id: String,
    mode_id: String,
) -> Result<(), NexError> {
    state.agent_manager.set_session_mode(&session_id, &mode_id).await
}

#[tauri::command]
pub async fn agent_set_session_model(
    state: State<'_, AppState>,
    session_id: String,
    model_id: String,
) -> Result<Option<Vec<crate::agent::types::SessionConfigOptionDto>>, NexError> {
    state.agent_manager.set_session_model(&session_id, &model_id).await
}

#[tauri::command]
pub async fn agent_set_session_config_option(
    state: State<'_, AppState>,
    session_id: String,
    config_id: String,
    value: String,
) -> Result<Option<Vec<crate::agent::types::SessionConfigOptionDto>>, NexError> {
    state
        .agent_manager
        .set_session_config_option(&session_id, &config_id, &value)
        .await
}

#[tauri::command]
pub async fn agent_cancel(state: State<'_, AppState>, session_id: String) -> Result<(), NexError> {
    state.agent_manager.cancel(&session_id).await
}

#[tauri::command]
pub fn agent_respond_permission(
    state: State<AppState>,
    request_id: String,
    option_id: Option<String>,
) -> Result<(), NexError> {
    state.agent_manager.respond_permission(&request_id, option_id)
}

#[tauri::command]
pub fn agent_respond_plan(
    state: State<AppState>,
    request_id: String,
    outcome: String,
    reason: Option<String>,
) -> Result<(), NexError> {
    state.agent_manager.respond_plan(&request_id, &outcome, reason)
}

#[tauri::command]
pub fn agent_respond_ask_question(
    state: State<AppState>,
    request_id: String,
    outcome: String,
    answers: Option<Vec<crate::agent::types::AskQuestionAnswerDto>>,
    reason: Option<String>,
) -> Result<(), NexError> {
    state
        .agent_manager
        .respond_ask_question(&request_id, &outcome, answers, reason)
}

#[tauri::command]
pub fn agent_close_session(state: State<AppState>, session_id: String) -> Result<(), NexError> {
    state.agent_manager.remove_session(&session_id);
    Ok(())
}

#[tauri::command]
pub fn agent_custom_upsert(state: State<AppState>, server: CustomServer) -> Result<(), NexError> {
    state.agent_manager.custom_upsert(server)
}

#[tauri::command]
pub fn agent_custom_delete(state: State<AppState>, id: String) -> Result<(), NexError> {
    state.agent_manager.custom_delete(&id)
}

fn app_data_dir(app: &AppHandle) -> Result<std::path::PathBuf, NexError> {
    app.path()
        .app_data_dir()
        .map_err(|e| NexError::Internal(format!("failed to get app data dir: {e}")))
}

/// Reads the built-in native agent config (`nex-agent.json`; defaults when absent).
#[tauri::command]
pub fn native_agent_get_config(app: AppHandle) -> Result<NativeAgentConfig, NexError> {
    Ok(NativeAgentConfig::load(&app_data_dir(&app)?))
}

/// Persists the built-in native agent config (`nex-agent.json`).
#[tauri::command]
pub fn native_agent_set_config(app: AppHandle, config: NativeAgentConfig) -> Result<(), NexError> {
    config.save(&app_data_dir(&app)?)
}

/// Fetches the model id list from an OpenAI-compatible `{base_url}/v1/models`
/// endpoint. Powers the settings panel's "获取模型" button.
#[tauri::command]
pub async fn native_agent_list_models(
    base_url: String,
    api_key: String,
) -> Result<Vec<String>, NexError> {
    let url = crate::agent::native::provider::openai_endpoint(&base_url, "models");
    let resp = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .unwrap_or_default()
        .get(&url)
        .bearer_auth(api_key)
        .send()
        .await
        .map_err(|e| NexError::Agent(format!("failed to fetch model list: {e}")))?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(NexError::Agent(format!(
            "model list error {status}: {}",
            text.chars().take(300).collect::<String>()
        )));
    }
    let value: serde_json::Value = serde_json::from_str(&text)
        .map_err(|e| NexError::Agent(format!("invalid model list response: {e}")))?;
    let ids = value
        .get("data")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|m| m.get("id").and_then(|v| v.as_str()))
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    if ids.is_empty() {
        return Err(NexError::Agent("model list response has no data[].id entries".into()));
    }
    Ok(ids)
}

/// Settings-panel skill row.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillInfoDto {
    pub name: String,
    pub description: String,
    pub enabled: bool,
    /// `builtin` when seeded from the app bundle, otherwise `user`.
    pub source: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpUpsertRequest {
    pub name: String,
    pub command: Option<String>,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: std::collections::HashMap<String, String>,
    pub url: Option<String>,
}

#[tauri::command]
pub fn native_agent_list_mcp(app: AppHandle) -> Result<Vec<mcp::McpServerInfo>, NexError> {
    let cfg = NativeAgentConfig::load(&app_data_dir(&app)?);
    Ok(mcp::list_global(&cfg.disabled_mcp_servers))
}

#[tauri::command]
pub fn native_agent_upsert_mcp(server: McpUpsertRequest) -> Result<(), NexError> {
    mcp::upsert_global(
        &server.name,
        mcp::McpServerConfig {
            command: server.command,
            args: server.args,
            env: server.env,
            url: server.url,
        },
    )
    .map_err(NexError::Agent)
}

#[tauri::command]
pub fn native_agent_delete_mcp(name: String) -> Result<(), NexError> {
    mcp::delete_global(&name).map_err(NexError::Agent)
}

#[tauri::command]
pub fn native_agent_set_mcp_enabled(
    app: AppHandle,
    name: String,
    enabled: bool,
) -> Result<(), NexError> {
    let dir = app_data_dir(&app)?;
    let mut cfg = NativeAgentConfig::load(&dir);
    cfg.disabled_mcp_servers.retain(|n| n != &name);
    if !enabled {
        cfg.disabled_mcp_servers.push(name);
    }
    cfg.save(&dir)
}

/// Short handshake probe for the settings status badge.
#[tauri::command]
pub async fn native_agent_probe_mcp(name: String) -> Result<String, NexError> {
    let list = mcp::list_global(&[]);
    let Some(info) = list.into_iter().find(|s| s.name == name) else {
        return Err(NexError::Agent(format!("MCP server `{name}` not found")));
    };
    let cfg = mcp::McpServerConfig {
        command: info.command,
        args: info.args,
        env: info.env,
        url: info.url,
    };
    match mcp::McpClient::connect(&name, &cfg).await {
        Ok(client) => Ok(format!("connected:{} tools", client.tools.len())),
        Err(e) => Ok(format!("error:{e}")),
    }
}

#[tauri::command]
pub fn native_agent_list_skills(app: AppHandle) -> Result<Vec<SkillInfoDto>, NexError> {
    if let Some(home_dir) = home::nex_home() {
        bundled::ensure_bundled(&home_dir);
    }
    let cfg = NativeAgentConfig::load(&app_data_dir(&app)?);
    let builtin: std::collections::HashSet<&str> =
        bundled::bundled_skill_names().iter().copied().collect();
    let discovered = home::skills_dir()
        .map(|root| skills::discover(&root))
        .unwrap_or_default();
    Ok(discovered
        .into_iter()
        .map(|s| SkillInfoDto {
            enabled: !cfg.disabled_skills.iter().any(|d| d == &s.name),
            source: if builtin.contains(s.name.as_str()) {
                "builtin".into()
            } else {
                "user".into()
            },
            name: s.name,
            description: s.description,
        })
        .collect())
}

#[tauri::command]
pub fn native_agent_delete_skill(name: String) -> Result<(), NexError> {
    let root = home::skills_dir().ok_or_else(|| NexError::Agent("home unavailable".into()))?;
    let dir = root.join(&name);
    if name.is_empty() || name.contains('/') || name.contains('\\') || name == "." || name == ".." {
        return Err(NexError::Agent("invalid skill name".into()));
    }
    if !dir.is_dir() {
        return Err(NexError::Agent(format!("skill `{name}` not found")));
    }
    std::fs::remove_dir_all(&dir)
        .map_err(|e| NexError::Agent(format!("failed to delete skill: {e}")))
}

#[tauri::command]
pub fn native_agent_set_skill_enabled(
    app: AppHandle,
    name: String,
    enabled: bool,
) -> Result<(), NexError> {
    let dir = app_data_dir(&app)?;
    let mut cfg = NativeAgentConfig::load(&dir);
    cfg.disabled_skills.retain(|n| n != &name);
    if !enabled {
        cfg.disabled_skills.push(name);
    }
    cfg.save(&dir)
}

#[tauri::command]
pub fn native_agent_open_skills_dir() -> Result<String, NexError> {
    let home_dir = home::nex_home().ok_or_else(|| NexError::Agent("home unavailable".into()))?;
    bundled::ensure_bundled(&home_dir);
    let dir = home_dir.join("skills");
    let _ = std::fs::create_dir_all(&dir);
    open_path(&dir)?;
    Ok(dir.display().to_string())
}

fn open_path(path: &std::path::Path) -> Result<(), NexError> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(path)
            .spawn()
            .map_err(|e| NexError::Internal(format!("打开目录失败: {e}")))?;
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(path)
            .spawn()
            .map_err(|e| NexError::Internal(format!("打开目录失败: {e}")))?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(path)
            .spawn()
            .map_err(|e| NexError::Internal(format!("打开目录失败: {e}")))?;
    }
    Ok(())
}
