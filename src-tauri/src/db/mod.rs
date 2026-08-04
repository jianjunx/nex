pub mod schema;
pub mod conversations;
pub mod projects;

use rusqlite::Connection;
use std::sync::Mutex;

pub struct Database {
    pub conn: Mutex<Connection>,
}

impl Database {
    pub fn new(path: &std::path::Path) -> Result<Self, crate::error::NexError> {
        let conn = Connection::open(path)?;
        // WAL allows readers while a writer is active (smoother UI reads);
        // busy_timeout avoids instant SQLITE_BUSY under brief contention;
        // foreign_keys must be enabled per connection to be enforced at all.
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "busy_timeout", 5000)?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        conn.execute_batch(schema::SCHEMA)?;
        Ok(Self { conn: Mutex::new(conn) })
    }
}
