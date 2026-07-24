use crate::error::NexError;
use crate::state::AppState;
use tauri::{AppHandle, State};

#[tauri::command]
pub fn terminal_create(app: AppHandle, state: State<AppState>, project_path: String, shell: Option<String>) -> Result<String, NexError> {
    state.terminal_manager.create(app, &project_path, shell.as_deref())
}

#[tauri::command]
pub fn terminal_write(state: State<AppState>, terminal_id: String, data: String) -> Result<(), NexError> {
    state.terminal_manager.write(&terminal_id, &data)
}

#[tauri::command]
pub fn terminal_resize(state: State<AppState>, terminal_id: String, cols: u16, rows: u16) -> Result<(), NexError> {
    state.terminal_manager.resize(&terminal_id, cols, rows)
}

#[tauri::command]
pub fn terminal_kill(state: State<AppState>, terminal_id: String) -> Result<(), NexError> {
    state.terminal_manager.kill(&terminal_id)
}
