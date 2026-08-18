use tauri::AppHandle;

#[tauri::command]
pub fn app_exit_now(app: AppHandle) {
    app.exit(0);
}
