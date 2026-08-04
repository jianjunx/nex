use tauri::State;
use crate::state::AppState;
use crate::error::NexError;
use crate::db::projects::Project;
use crate::db::conversations::{Conversation, Message, ThreadEntryPersisted};

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

/// Bump `last_opened` when switching to an already-listed project (dropdown).
#[tauri::command]
pub fn project_touch(state: State<AppState>, id: String) -> Result<i64, NexError> {
    state.db.update_project_last_opened(&id)
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

#[tauri::command]
pub fn conversation_append_message(
    state: State<AppState>,
    conversation_id: String,
    role: String,
    content: String,
    tool_summary: Option<String>,
) -> Result<Message, NexError> {
    state.db.append_message(&conversation_id, &role, &content, tool_summary.as_deref())
}

#[tauri::command]
pub fn conversation_get_thread_entries(
    state: State<AppState>,
    conversation_id: String,
) -> Result<Vec<ThreadEntryPersisted>, NexError> {
    state.db.get_thread_entries(&conversation_id)
}

#[tauri::command]
pub fn conversation_replace_thread_entries(
    state: State<AppState>,
    conversation_id: String,
    entries: Vec<ThreadEntryPersisted>,
) -> Result<(), NexError> {
    state.db.replace_thread_entries(&conversation_id, &entries)
}
