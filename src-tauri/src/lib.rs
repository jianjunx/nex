use tauri::Manager;

mod error;
mod state;
mod watcher;
mod commands;
pub mod acp;
pub mod db;
pub mod fs;
pub mod git;
pub mod terminal;

use acp::manager::AcpSessionManager;
use db::Database;
use state::AppState;
use std::sync::Arc;
use terminal::pty::TerminalManager;
use watcher::WatcherManager;

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
            commands::fs_cmds::fs_read_tree,
            commands::fs_cmds::fs_expand_dir,
            commands::fs_cmds::fs_read_file,
            commands::fs_cmds::fs_watch_start,
            commands::git_cmds::git_status,
            commands::git_cmds::git_diff,
            commands::git_cmds::git_log,
            commands::git_cmds::git_stage,
            commands::git_cmds::git_unstage,
            commands::git_cmds::git_commit,
            commands::terminal_cmds::terminal_create,
            commands::terminal_cmds::terminal_write,
            commands::terminal_cmds::terminal_resize,
            commands::terminal_cmds::terminal_kill,
            commands::acp_cmds::acp_create_session,
            commands::acp_cmds::acp_send_prompt,
            commands::acp_cmds::acp_cancel,
            commands::acp_cmds::acp_respond_permission,
            commands::acp_cmds::acp_close_session,
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

            #[cfg(target_os = "windows")]
            {
                use window_vibrancy::apply_acrylic;
                let window = app.get_webview_window("main").expect("main window not found");
                // Tint is RGBA. The OS blurs the desktop wallpaper behind the
                // (transparent) Tauri window and applies this tint, producing a
                // real frosted-glass effect that CSS backdrop-filter cannot
                // achieve. Light tint matches the default light theme; tune the
                // alpha (4th byte) to adjust opacity.
                let _ = apply_acrylic(&window, Some((245, 246, 250, 180)));
            }

            // Initialize database
            let app_data_dir = app.path().app_data_dir().expect("failed to get app data dir");
            std::fs::create_dir_all(&app_data_dir).ok();
            let db_path = app_data_dir.join("nex.db");
            let db = Database::new(&db_path).expect("failed to initialize database");

            app.manage(AppState {
                db: Arc::new(db),
                terminal_manager: TerminalManager::new(),
                acp_manager: AcpSessionManager::new(),
                watcher_manager: WatcherManager::new(),
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
