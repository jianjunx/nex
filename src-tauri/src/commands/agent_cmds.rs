use crate::agent::{CustomServer, ServerDescriptor, SessionTarget};
use crate::error::NexError;
use crate::state::AppState;
use tauri::{AppHandle, State};

/// The merged agent dropdown list (open ACP registry + user's custom servers).
#[tauri::command]
pub fn agent_list_servers(state: State<AppState>) -> Vec<ServerDescriptor> {
    state.agent_manager.list_servers()
}

/// Forces a registry re-fetch (bypasses the 1h throttle).
#[tauri::command]
pub async fn agent_refresh_registry(state: State<'_, AppState>) -> Result<(), NexError> {
    state.agent_manager.refresh_registry().await
}

/// Resolves the target (registry agent by id, or a custom command) and starts a
/// session; resolves to the Nex session id on a successful ACP handshake.
#[tauri::command]
pub async fn agent_create_session(
    app: AppHandle,
    state: State<'_, AppState>,
    conversation_id: String,
    target: SessionTarget,
    cwd: String,
) -> Result<String, NexError> {
    state.agent_manager.create_session(&app, &conversation_id, target, &cwd).await
}

/// Resolves when the agent finishes the prompt turn; session updates stream to
/// the frontend as `agent-notification` events in the meantime.
#[tauri::command]
pub async fn agent_send_prompt(state: State<'_, AppState>, session_id: String, content: String) -> Result<(), NexError> {
    state.agent_manager.send_prompt(&session_id, &content).await
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

/// Tears down a session: removing it drops the last handle, which signals the
/// session thread to kill the agent process, drain pending permissions, and
/// emit `agent-session-terminated`.
#[tauri::command]
pub fn agent_close_session(state: State<AppState>, session_id: String) -> Result<(), NexError> {
    state.agent_manager.remove_session(&session_id);
    Ok(())
}

/// Adds or updates a user-defined custom ACP server.
#[tauri::command]
pub fn agent_custom_upsert(state: State<AppState>, server: CustomServer) -> Result<(), NexError> {
    state.agent_manager.custom_upsert(server)
}

/// Deletes a user-defined custom ACP server by id.
#[tauri::command]
pub fn agent_custom_delete(state: State<AppState>, id: String) -> Result<(), NexError> {
    state.agent_manager.custom_delete(&id)
}
