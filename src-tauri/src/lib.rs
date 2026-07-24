use tauri::Manager;

mod error;
mod state;
mod commands;
pub mod db;

use db::Database;
use state::AppState;
use std::sync::Arc;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            commands::project_cmds::project_open,
            commands::project_cmds::project_list,
            commands::project_cmds::conversation_create,
            commands::project_cmds::conversation_list,
            commands::project_cmds::conversation_get_messages,
        ])
        .setup(|app| {
            #[cfg(target_os = "macos")]
            {
                use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial};
                let window = app.get_webview_window("main").expect("main window not found");
                let _ = apply_vibrancy(
                    &window,
                    NSVisualEffectMaterial::UnderWindowBackground,
                    None,
                    None,
                );
            }

            // Initialize database
            let app_data_dir = app.path().app_data_dir().expect("failed to get app data dir");
            std::fs::create_dir_all(&app_data_dir).ok();
            let db_path = app_data_dir.join("nex.db");
            let db = Database::new(&db_path).expect("failed to initialize database");

            app.manage(AppState { db: Arc::new(db) });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
