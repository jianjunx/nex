use std::sync::Arc;
use crate::db::Database;
use crate::terminal::pty::TerminalManager;

pub struct AppState {
    pub db: Arc<Database>,
    pub terminal_manager: TerminalManager,
}
