use crate::services::{manager, ServiceInfo};
use std::path::Path;

#[tauri::command]
pub async fn service_list(project_path: String) -> Result<Vec<ServiceInfo>, String> {
    manager().list(Path::new(&project_path)).await
}

#[tauri::command]
pub async fn service_action(
    project_path: String,
    id: String,
    action: String,
) -> Result<(), String> {
    manager()
        .action(Path::new(&project_path), &id, &action)
        .await
}

#[tauri::command]
pub fn service_logs(project_path: String, id: String) -> Result<String, String> {
    manager().logs(Path::new(&project_path), &id)
}
