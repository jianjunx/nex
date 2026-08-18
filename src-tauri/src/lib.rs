use tauri::{Emitter, Manager};

pub mod agent;
mod commands;
pub mod db;
mod error;
pub mod fs;
pub mod git;
mod state;
pub mod terminal;
mod watcher;
mod win_process;

use agent::AgentSessionManager;
use db::Database;
use git::credentials::GitCredentialBroker;
use state::AppState;
use std::sync::Arc;
use terminal::pty::TerminalManager;
use watcher::WatcherManager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            commands::project_cmds::project_open,
            commands::project_cmds::project_list,
            commands::project_cmds::project_touch,
            commands::project_cmds::project_remove,
            commands::project_cmds::conversation_create,
            commands::project_cmds::conversation_list,
            commands::project_cmds::conversation_get_messages,
            commands::project_cmds::conversation_update_title,
            commands::project_cmds::conversation_delete,
            commands::project_cmds::conversation_append_message,
            commands::project_cmds::conversation_get_thread_entries,
            commands::project_cmds::conversation_replace_thread_entries,
            commands::fs_cmds::fs_read_tree,
            commands::fs_cmds::fs_expand_dir,
            commands::fs_cmds::fs_read_file,
            commands::fs_cmds::fs_write_file,
            commands::fs_cmds::fs_watch_start,
            commands::fs_cmds::fs_watch_stop,
            commands::fs_cmds::fs_search,
            commands::fs_cmds::fs_search_replace,
            commands::fs_cmds::fs_apply_replace,
            commands::fs_cmds::fs_create_file,
            commands::fs_cmds::fs_create_dir,
            commands::fs_cmds::fs_delete_entry,
            commands::fs_cmds::fs_rename_entry,
            commands::fs_cmds::fs_copy_entry,
            commands::fs_cmds::fs_move_entry,
            commands::fs_cmds::fs_import_files,
            commands::git_cmds::git_status,
            commands::git_cmds::git_diff,
            commands::git_cmds::git_diff_contents,
            commands::git_cmds::git_commit_patch,
            commands::git_cmds::git_log,
            commands::git_cmds::git_stage,
            commands::git_cmds::git_unstage,
            commands::git_cmds::git_commit,
            commands::git_cmds::git_list_branches,
            commands::git_cmds::git_checkout,
            commands::git_cmds::git_create_branch,
            commands::git_cmds::git_delete_branch,
            commands::git_cmds::git_discard,
            commands::git_cmds::git_revert_staged,
            commands::git_cmds::git_stash_save,
            commands::git_cmds::git_stash_list,
            commands::git_cmds::git_stash_apply,
            commands::git_cmds::git_stash_pop,
            commands::git_cmds::git_stash_drop,
            commands::git_cmds::git_credential_respond,
            commands::git_cmds::git_fetch,
            commands::git_cmds::git_pull,
            commands::git_cmds::git_push,
            commands::git_cmds::git_clone,
            commands::git_cmds::git_merge,
            commands::terminal_cmds::terminal_create,
            commands::terminal_cmds::terminal_write,
            commands::terminal_cmds::terminal_resize,
            commands::terminal_cmds::terminal_kill,
            commands::agent_cmds::agent_list_servers,
            commands::agent_cmds::agent_list_all_servers,
            commands::agent_cmds::agent_refresh_registry,
            commands::agent_cmds::agent_create_session,
            commands::agent_cmds::agent_send_prompt,
            commands::agent_cmds::agent_set_session_mode,
            commands::agent_cmds::agent_set_session_model,
            commands::agent_cmds::agent_set_session_config_option,
            commands::agent_cmds::agent_cancel,
            commands::agent_cmds::agent_respond_permission,
            commands::agent_cmds::agent_respond_plan,
            commands::agent_cmds::agent_respond_ask_question,
            commands::agent_cmds::agent_close_session,
            commands::agent_cmds::agent_custom_upsert,
            commands::agent_cmds::agent_custom_delete,
            commands::agent_cmds::native_agent_get_config,
            commands::agent_cmds::native_agent_set_config,
            commands::agent_cmds::native_agent_list_models,
            commands::agent_cmds::native_agent_probe_reasoning,
            commands::agent_cmds::native_agent_list_mcp,
            commands::agent_cmds::native_agent_upsert_mcp,
            commands::agent_cmds::native_agent_delete_mcp,
            commands::agent_cmds::native_agent_set_mcp_enabled,
            commands::agent_cmds::native_agent_set_project_mcp_enabled,
            commands::agent_cmds::native_agent_probe_mcp,
            commands::agent_cmds::native_agent_list_skills,
            commands::agent_cmds::native_agent_delete_skill,
            commands::agent_cmds::native_agent_set_skill_enabled,
            commands::agent_cmds::native_agent_open_skills_dir,
            commands::update_cmds::update_check_latest,
            commands::update_cmds::update_download_and_install,
            commands::update_cmds::open_external,
            commands::app_cmds::app_exit_now,
        ])
        .setup(|app| {
            #[cfg(target_os = "windows")]
            {
                let Some(window) = app.get_webview_window("main") else {
                    return Err("main window not found".into());
                };
                // Hide the native title bar on Windows; we draw our own tab bar
                // with custom window controls in the frontend.
                let _ = window.set_decorations(false);
            }

            // Initialize database. Returning Err lets Tauri shut down with a
            // readable error instead of panicking mid-setup.
            let app_data_dir = app
                .path()
                .app_data_dir()
                .map_err(|e| format!("failed to get app data dir: {e}"))?;
            std::fs::create_dir_all(&app_data_dir).ok();
            let db_path = app_data_dir.join("nex.db");
            let db = Database::new(&db_path)
                .map_err(|e| format!("failed to initialize database: {e}"))?;

            // Shared login-shell env: one zsh/cmd fork for agents + terminals.
            let shell_env = agent::shell_env::ShellEnv::new();
            shell_env.try_trigger_lazy_load();
            let project_envs = agent::project_env::ProjectEnvCache::new();

            app.manage(AppState {
                db: Arc::new(db),
                terminal_manager: TerminalManager::new(),
                agent_manager: AgentSessionManager::new(&app_data_dir, shell_env, project_envs),
                watcher_manager: WatcherManager::new(),
            });

            // In-memory git credential broker for the GUI auth dialog
            // (Plan 3). Independent State: AppState stays untouched.
            app.manage(GitCredentialBroker::new());

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::ExitRequested {
                code: None,
                api,
                ..
            } = event
            {
                api.prevent_exit();
                let _ = app.emit("app-exit-requested", ());
            }
        });
}
