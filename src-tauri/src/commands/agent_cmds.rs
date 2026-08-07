use crate::agent::{CreateSessionResult, CustomServer, NativeAgentConfig, PromptBlock, ServerDescriptor, SessionTarget};
use crate::error::NexError;
use crate::state::AppState;
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
) -> Result<(), NexError> {
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
