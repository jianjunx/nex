use tauri::State;
use crate::state::AppState;
use crate::error::NexError;
use crate::db::projects::Project;
use crate::db::conversations::{Conversation, Message};

#[tauri::command]
pub fn project_open(state: State<AppState>, path: String) -> Result<Project, NexError> {
    let name = std::path::Path::new(&path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| path.clone());
    state.db.open_project(&name, &path)
}

#[tauri::command]
pub fn project_list(state: State<AppState>) -> Result<Vec<Project>, NexError> {
    state.db.list_projects()
}

#[tauri::command]
pub fn conversation_create(state: State<AppState>, project_id: String, agent_type: String) -> Result<Conversation, NexError> {
    state.db.create_conversation(&project_id, &agent_type)
}

#[tauri::command]
pub fn conversation_list(state: State<AppState>, project_id: String) -> Result<Vec<Conversation>, NexError> {
    state.db.list_conversations(&project_id)
}

#[tauri::command]
pub fn conversation_get_messages(state: State<AppState>, conversation_id: String, limit: i32, offset: i32) -> Result<Vec<Message>, NexError> {
    state.db.get_messages(&conversation_id, limit, offset)
}

#[tauri::command]
pub fn conversation_update_title(state: State<AppState>, conversation_id: String, title: String) -> Result<(), NexError> {
    state.db.update_conversation_title(&conversation_id, &title)
}
