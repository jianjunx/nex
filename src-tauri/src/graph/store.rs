//! SQLite persistence for the code graph. One database per project.

use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension};

use super::parse::ExtractedFile;
use super::paths;

pub const SCHEMA_VERSION: i64 = 1;

const DDL: &str = r#"
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS files (
    path TEXT PRIMARY KEY,
    language TEXT NOT NULL,
    mtime_ms INTEGER NOT NULL,
    size INTEGER NOT NULL,
    hash INTEGER NOT NULL,
    parse_ok INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS nodes (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    qualified TEXT NOT NULL,
    file TEXT NOT NULL,
    start_line INTEGER NOT NULL,
    end_line INTEGER NOT NULL,
    language TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_nodes_name ON nodes(name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_nodes_file ON nodes(file);
CREATE INDEX IF NOT EXISTS idx_nodes_kind ON nodes(kind);
CREATE INDEX IF NOT EXISTS idx_nodes_qual ON nodes(qualified COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS facts (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL,
    src_file TEXT NOT NULL,
    src_name TEXT,
    dst_name TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_facts_src ON facts(src_file);
CREATE INDEX IF NOT EXISTS idx_facts_dst ON facts(dst_name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_facts_kind ON facts(kind);
"#;

pub struct Store {
    conn: Connection,
}

impl Store {
    pub fn open(cwd: &Path) -> Result<Self, String> {
        paths::ensure_layout(cwd)?;
        let path = paths::db_path(cwd);
        let conn = Connection::open(&path)
            .map_err(|e| format!("cannot open graph db {}: {e}", path.display()))?;
        conn.execute_batch(DDL)
            .map_err(|e| format!("graph schema: {e}"))?;
        let store = Self { conn };
        store.migrate()?;
        Ok(store)
    }

    fn migrate(&self) -> Result<(), String> {
        let ver: Option<String> = self
            .conn
            .query_row(
                "SELECT value FROM meta WHERE key = 'schema_version'",
                [],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        match ver {
            None => {
                self.set_meta("schema_version", &SCHEMA_VERSION.to_string())?;
                Ok(())
            }
            Some(v) if v == SCHEMA_VERSION.to_string() => Ok(()),
            Some(_) => {
                // Incompatible: wipe and recreate.
                self.conn
                    .execute_batch(
                        "DROP TABLE IF EXISTS facts;
                         DROP TABLE IF EXISTS nodes;
                         DROP TABLE IF EXISTS files;
                         DROP TABLE IF EXISTS meta;",
                    )
                    .map_err(|e| e.to_string())?;
                self.conn.execute_batch(DDL).map_err(|e| e.to_string())?;
                self.set_meta("schema_version", &SCHEMA_VERSION.to_string())
            }
        }
    }

    pub fn set_meta(&self, key: &str, value: &str) -> Result<(), String> {
        self.conn
            .execute(
                "INSERT INTO meta(key, value) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![key, value],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn meta(&self, key: &str) -> Option<String> {
        self.conn
            .query_row("SELECT value FROM meta WHERE key = ?1", [key], |r| r.get(0))
            .optional()
            .ok()
            .flatten()
    }

    pub fn file_stamp(&self, path: &str) -> Option<(u64, u64, u64)> {
        self.conn
            .query_row(
                "SELECT mtime_ms, size, hash FROM files WHERE path = ?1",
                [path],
                |r| {
                    Ok((
                        r.get::<_, i64>(0)? as u64,
                        r.get::<_, i64>(1)? as u64,
                        r.get::<_, i64>(2)? as u64,
                    ))
                },
            )
            .optional()
            .ok()
            .flatten()
    }

    pub fn known_files(&self) -> Result<Vec<String>, String> {
        let mut stmt = self
            .conn
            .prepare("SELECT path FROM files")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<String>, _>>()
            .map_err(|e| e.to_string())
    }

    pub fn delete_file(&self, path: &str) -> Result<(), String> {
        self.conn
            .execute("DELETE FROM facts WHERE src_file = ?1", [path])
            .map_err(|e| e.to_string())?;
        self.conn
            .execute("DELETE FROM nodes WHERE file = ?1", [path])
            .map_err(|e| e.to_string())?;
        self.conn
            .execute("DELETE FROM files WHERE path = ?1", [path])
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn replace_file(
        &self,
        path: &str,
        language: &str,
        mtime_ms: u64,
        size: u64,
        hash: u64,
        extracted: &ExtractedFile,
    ) -> Result<(), String> {
        let tx = self
            .conn
            .unchecked_transaction()
            .map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM facts WHERE src_file = ?1", [path])
            .map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM nodes WHERE file = ?1", [path])
            .map_err(|e| e.to_string())?;
        tx.execute(
            "INSERT INTO files(path, language, mtime_ms, size, hash, parse_ok)
             VALUES (?1, ?2, ?3, ?4, ?5, 1)
             ON CONFLICT(path) DO UPDATE SET
                language = excluded.language,
                mtime_ms = excluded.mtime_ms,
                size = excluded.size,
                hash = excluded.hash,
                parse_ok = 1",
            params![path, language, mtime_ms as i64, size as i64, hash as i64],
        )
        .map_err(|e| e.to_string())?;

        // File node first so `children_of` / `file_summary` have a handle.
        tx.execute(
            "INSERT INTO nodes(kind, name, qualified, file, start_line, end_line, language)
             VALUES ('File', ?1, ?2, ?2, 1, 1, ?3)",
            params![
                Path::new(path)
                    .file_name()
                    .map(|s| s.to_string_lossy().into_owned())
                    .unwrap_or_else(|| path.to_string()),
                path,
                language
            ],
        )
        .map_err(|e| e.to_string())?;

        for n in &extracted.nodes {
            tx.execute(
                "INSERT INTO nodes(kind, name, qualified, file, start_line, end_line, language)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    n.kind.as_str(),
                    n.name,
                    n.qualified,
                    path,
                    n.start_line as i64,
                    n.end_line as i64,
                    language
                ],
            )
            .map_err(|e| e.to_string())?;
        }
        for f in &extracted.facts {
            tx.execute(
                "INSERT INTO facts(kind, src_file, src_name, dst_name) VALUES (?1, ?2, ?3, ?4)",
                params![f.kind.as_str(), path, f.src_name, f.dst_name],
            )
            .map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn conn(&self) -> &Connection {
        &self.conn
    }
}

/// Read-only connection for queries (WAL allows this beside the writer).
pub fn open_read(cwd: &Path) -> Result<Connection, String> {
    let path = paths::db_path(cwd);
    if !path.exists() {
        return Err("code graph index is not built yet".into());
    }
    let conn = Connection::open(&path).map_err(|e| format!("cannot open graph db: {e}"))?;
    conn.pragma_update(None, "query_only", true)
        .map_err(|e| e.to_string())?;
    Ok(conn)
}
