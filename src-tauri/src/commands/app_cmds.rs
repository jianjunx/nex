use tauri::AppHandle;

#[tauri::command]
pub async fn app_exit_now(app: AppHandle) {
    crate::services::manager().shutdown().await;
    app.exit(0);
}
