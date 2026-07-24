use std::sync::Arc;
use crate::db::Database;

pub struct AppState {
    pub db: Arc<Database>,
}
