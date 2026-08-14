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
        let db = Self {
            conn: Mutex::new(conn),
        };
        // Older releases stored transient image/base64 payloads in thread
        // snapshots. Remove them once on upgrade as well as preventing future
        // writes, so a restart cannot repeatedly load legacy blobs into RAM.
        db.scrub_legacy_thread_image_payloads()?;
        Ok(db)
    }
}
