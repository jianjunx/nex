use std::sync::Arc;
use crate::agent::AgentSessionManager;
use crate::db::Database;
use crate::graph::GraphService;
use crate::terminal::pty::TerminalManager;
use crate::watcher::WatcherManager;

pub struct AppState {
    pub db: Arc<Database>,
    pub terminal_manager: TerminalManager,
    pub agent_manager: AgentSessionManager,
    pub watcher_manager: WatcherManager,
    pub graph: GraphService,
}
