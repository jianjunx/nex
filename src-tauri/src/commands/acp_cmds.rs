use crate::error::NexError;
use crate::state::AppState;
use tauri::{AppHandle, State};

#[tauri::command]
pub async fn acp_create_session(
    app: AppHandle,
    state: State<'_, AppState>,
    conversation_id: String,
    agent_command: String,
    cwd: String,
) -> Result<String, NexError> {
    state.acp_manager.create_session(&app, &conversation_id, &agent_command, &cwd).await
}

/// Resolves when the agent finishes the prompt turn; session updates stream
/// to the frontend as `acp-notification` events in the meantime.
#[tauri::command]
pub async fn acp_send_prompt(state: State<'_, AppState>, session_id: String, content: String) -> Result<(), NexError> {
    state.acp_manager.send_prompt(&session_id, &content).await
}

#[tauri::command]
pub async fn acp_cancel(state: State<'_, AppState>, session_id: String) -> Result<(), NexError> {
    state.acp_manager.cancel(&session_id).await
}

#[tauri::command]
pub fn acp_respond_permission(state: State<AppState>, request_id: String, option_id: Option<String>) -> Result<(), NexError> {
    state.acp_manager.respond_permission(&request_id, option_id)
}
