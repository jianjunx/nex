use crate::error::NexError;
use crate::state::AppState;
use tauri::{AppHandle, State};

#[tauri::command]
pub async fn terminal_create(
    app: AppHandle,
    state: State<'_, AppState>,
    project_path: String,
    shell: Option<String>,
    cols: Option<u16>,
    rows: Option<u16>,
) -> Result<String, NexError> {
    // Resolve project/login PATH before spawn so packaged builds see
    // Homebrew git / direnv tooling the same way agent sessions do.
    let path_env = state.agent_manager.path_for_cwd(&project_path).await;
    let cols = cols.unwrap_or(80);
    let rows = rows.unwrap_or(24);
    state.terminal_manager.create(
        app,
        &project_path,
        shell.as_deref(),
        &path_env,
        cols,
        rows,
    )
}

#[tauri::command]
pub fn terminal_write(state: State<'_, AppState>, terminal_id: String, data: String) -> Result<(), NexError> {
    state.terminal_manager.write(&terminal_id, &data)
}

#[tauri::command]
pub fn terminal_resize(
    state: State<'_, AppState>,
    terminal_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), NexError> {
    state.terminal_manager.resize(&terminal_id, cols, rows)
}

#[tauri::command]
pub fn terminal_kill(state: State<'_, AppState>, terminal_id: String) -> Result<(), NexError> {
    state.terminal_manager.kill(&terminal_id)
}
