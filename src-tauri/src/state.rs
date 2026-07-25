use std::sync::Arc;
use crate::acp::manager::AcpSessionManager;
use crate::db::Database;
use crate::terminal::pty::TerminalManager;
use crate::watcher::WatcherManager;

pub struct AppState {
    pub db: Arc<Database>,
    pub terminal_manager: TerminalManager,
    pub acp_manager: AcpSessionManager,
    pub watcher_manager: WatcherManager,
}
