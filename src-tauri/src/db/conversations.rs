use rusqlite::params;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

use super::Database;
use crate::error::NexError;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Conversation {
    pub id: String,
    pub project_id: String,
    pub title: String,
    pub agent_type: String,
    pub status: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Message {
    pub id: String,
    pub conversation_id: String,
    pub role: String,
    pub content: String,
    pub tool_summary: Option<String>,
    pub timestamp: i64,
    pub sequence: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ThreadEntryPersisted {
    pub kind: String,
    pub sequence: i32,
    pub timestamp: i64,
    /// Full ThreadEntry payload serialized as JSON.
    pub payload: Value,
}

impl Database {
    pub fn create_conversation(
        &self,
        project_id: &str,
        agent_type: &str,
    ) -> Result<Conversation, NexError> {
        let conn = self.conn.lock().unwrap();
        let now = chrono::Utc::now().timestamp_millis();
        let conv = Conversation {
            id: Uuid::new_v4().to_string(),
            project_id: project_id.to_string(),
            title: "New Chat".to_string(),
            agent_type: agent_type.to_string(),
            status: "idle".to_string(),
            created_at: now,
            updated_at: now,
        };
        conn.execute(
            "INSERT INTO conversations (id, project_id, title, agent_type, status, created_at, updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7)",
            params![conv.id, conv.project_id, conv.title, conv.agent_type, conv.status, conv.created_at, conv.updated_at],
        )?;
        Ok(conv)
    }

    pub fn list_conversations(&self, project_id: &str) -> Result<Vec<Conversation>, NexError> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT id, project_id, title, agent_type, status, created_at, updated_at FROM conversations WHERE project_id = ?1 ORDER BY updated_at DESC")?;
        let convs = stmt
            .query_map(params![project_id], |row| {
                Ok(Conversation {
                    id: row.get(0)?,
                    project_id: row.get(1)?,
                    title: row.get(2)?,
                    agent_type: row.get(3)?,
                    status: row.get(4)?,
                    created_at: row.get(5)?,
                    updated_at: row.get(6)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(convs)
    }

    pub fn append_message(
        &self,
        conversation_id: &str,
        role: &str,
        content: &str,
        tool_summary: Option<&str>,
    ) -> Result<Message, NexError> {
        let mut conn = self.conn.lock().unwrap();
        let now = chrono::Utc::now().timestamp_millis();
        // Sequence computation + INSERT + conversation touch must be atomic:
        // two concurrent appends could otherwise read the same MAX(sequence).
        let tx = conn.transaction()?;
        let seq: i32 = tx.query_row(
            "SELECT COALESCE(MAX(sequence), 0) + 1 FROM messages WHERE conversation_id = ?1",
            params![conversation_id],
            |row| row.get(0),
        )?;
        let msg = Message {
            id: Uuid::new_v4().to_string(),
            conversation_id: conversation_id.to_string(),
            role: role.to_string(),
            content: content.to_string(),
            tool_summary: tool_summary.map(|s| s.to_string()),
            timestamp: now,
            sequence: seq,
        };
        tx.execute(
            "INSERT INTO messages (id, conversation_id, role, content, tool_summary, timestamp, sequence) VALUES (?1,?2,?3,?4,?5,?6,?7)",
            params![msg.id, msg.conversation_id, msg.role, msg.content, msg.tool_summary, msg.timestamp, msg.sequence],
        )?;
        tx.execute(
            "UPDATE conversations SET updated_at = ?1 WHERE id = ?2",
            params![now, conversation_id],
        )?;
        tx.commit()?;
        Ok(msg)
    }

    pub fn get_messages(
        &self,
        conversation_id: &str,
        limit: i32,
        offset: i32,
    ) -> Result<Vec<Message>, NexError> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT id, conversation_id, role, content, tool_summary, timestamp, sequence FROM messages WHERE conversation_id = ?1 ORDER BY sequence ASC LIMIT ?2 OFFSET ?3")?;
        let msgs = stmt
            .query_map(params![conversation_id, limit, offset], |row| {
                Ok(Message {
                    id: row.get(0)?,
                    conversation_id: row.get(1)?,
                    role: row.get(2)?,
                    content: row.get(3)?,
                    tool_summary: row.get(4)?,
                    timestamp: row.get(5)?,
                    sequence: row.get(6)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(msgs)
    }

    pub fn update_conversation_status(&self, id: &str, status: &str) -> Result<(), NexError> {
        let conn = self.conn.lock().unwrap();
        let now = chrono::Utc::now().timestamp_millis();
        conn.execute(
            "UPDATE conversations SET status = ?1, updated_at = ?2 WHERE id = ?3",
            params![status, now, id],
        )?;
        Ok(())
    }

    pub fn update_conversation_title(&self, id: &str, title: &str) -> Result<(), NexError> {
        let conn = self.conn.lock().unwrap();
        let now = chrono::Utc::now().timestamp_millis();
        let n = conn.execute(
            "UPDATE conversations SET title = ?1, updated_at = ?2 WHERE id = ?3",
            params![title, now, id],
        )?;
        if n == 0 {
            return Err(NexError::Database(format!("conversation not found: {id}")));
        }
        Ok(())
    }

    /// Remove one conversation and everything it owns (messages + thread
    /// snapshots) in one transaction. This is used when the user closes a
    /// conversation tab: unlike VS Code tabs, Nex tabs *are* the durable local
    /// conversation objects, so closing one must not leave its history growing
    /// forever in SQLite.
    pub fn delete_conversation(&self, id: &str) -> Result<(), NexError> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        tx.execute(
            "DELETE FROM messages WHERE conversation_id = ?1",
            params![id],
        )?;
        tx.execute(
            "DELETE FROM thread_entries WHERE conversation_id = ?1",
            params![id],
        )?;
        let n = tx.execute("DELETE FROM conversations WHERE id = ?1", params![id])?;
        tx.commit()?;
        if n == 0 {
            return Err(NexError::Database(format!("conversation not found: {id}")));
        }
        Ok(())
    }

    /// Replace the whole persisted thread snapshot for `conversation_id`.
    ///
    /// We overwrite rather than do incremental patching because ThreadEntry
    /// updates arrive in multiple notifications and we only need a stable
    /// snapshot for restore.
    pub fn replace_thread_entries(
        &self,
        conversation_id: &str,
        entries: &[ThreadEntryPersisted],
    ) -> Result<(), NexError> {
        let mut conn = self.conn.lock().unwrap();

        let tx = conn.transaction()?;
        tx.execute(
            "DELETE FROM thread_entries WHERE conversation_id = ?1",
            params![conversation_id],
        )?;

        for e in entries {
            // Thread snapshots are UI restore data, not an attachment store.
            // Strip image base64 before serialization so a pasted image cannot
            // become a long-lived SQLite blob (or be reloaded into memory on
            // every app start).
            let payload = scrub_inline_image_payload(e.payload.clone());
            tx.execute(
                "INSERT INTO thread_entries (id, conversation_id, kind, sequence, timestamp, payload_json)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    Uuid::new_v4().to_string(),
                    conversation_id,
                    e.kind,
                    e.sequence,
                    e.timestamp,
                    serde_json::to_string(&payload).unwrap_or_else(|_| "null".to_string())
                ],
            )?;
        }

        tx.commit()?;
        Ok(())
    }

    pub fn get_thread_entries(
        &self,
        conversation_id: &str,
    ) -> Result<Vec<ThreadEntryPersisted>, NexError> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT kind, sequence, timestamp, payload_json
             FROM thread_entries
             WHERE conversation_id = ?1
             ORDER BY sequence ASC",
        )?;

        let rows = stmt
            .query_map(params![conversation_id], |row| {
                let kind: String = row.get(0)?;
                let sequence: i32 = row.get(1)?;
                let timestamp: i64 = row.get(2)?;
                let payload_json: String = row.get(3)?;
                let payload: Value = serde_json::from_str(&payload_json).unwrap_or(Value::Null);

                Ok(ThreadEntryPersisted {
                    kind,
                    sequence,
                    timestamp,
                    payload,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;

        Ok(rows)
    }

    /// Upgrade cleanup for snapshots written before inline images were made
    /// transient. The marker is committed in the same transaction, so an
    /// interrupted cleanup is retried at the next startup instead of leaving
    /// a partially-sanitized database marked complete.
    pub(crate) fn scrub_legacy_thread_image_payloads(&self) -> Result<(), NexError> {
        const SCRUB_MARKER: &str = "thread_entries_inline_image_scrub_v1";

        let mut conn = self.conn.lock().unwrap();
        let already_scrubbed: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM nex_metadata WHERE key = ?1)",
            params![SCRUB_MARKER],
            |row| row.get(0),
        )?;
        if already_scrubbed {
            return Ok(());
        }

        let tx = conn.transaction()?;
        // Select only small ids first. A legacy image can be many MiB, and
        // processing one payload at a time avoids multiplying that allocation
        // while upgrading an existing database.
        let ids: Vec<String> = {
            let mut stmt = tx.prepare(
                r#"SELECT id FROM thread_entries
                   WHERE instr(payload_json, 'data:image/') > 0
                      OR instr(payload_json, '"images"') > 0
                      OR instr(payload_json, '"data"') > 0"#,
            )?;
            let ids = stmt
                .query_map([], |row| row.get(0))?
                .collect::<Result<Vec<_>, _>>()?;
            ids
        };

        for id in ids {
            let payload_json: String = tx.query_row(
                "SELECT payload_json FROM thread_entries WHERE id = ?1",
                params![&id],
                |row| row.get(0),
            )?;
            // Malformed JSON already restores as Null; replacing it with an
            // explicit Null is safer than retaining a possible image blob.
            let payload = serde_json::from_str::<Value>(&payload_json)
                .map(scrub_inline_image_payload)
                .unwrap_or(Value::Null);
            let cleaned = serde_json::to_string(&payload).map_err(|e| {
                NexError::Database(format!("failed to serialize thread snapshot: {e}"))
            })?;
            if cleaned != payload_json {
                tx.execute(
                    "UPDATE thread_entries SET payload_json = ?1 WHERE id = ?2",
                    params![cleaned, id],
                )?;
            }
        }

        tx.execute(
            "INSERT INTO nex_metadata (key, value) VALUES (?1, 'complete')",
            params![SCRUB_MARKER],
        )?;
        tx.commit()?;
        Ok(())
    }
}

/// Remove inline image/base64 fields from a persisted thread payload while
/// preserving a small count/marker for the restored UI. This deliberately
/// operates on the generic JSON DTO so older frontend builds cannot bypass it.
fn scrub_inline_image_payload(mut payload: Value) -> Value {
    scrub_inline_images(&mut payload);
    payload
}

fn scrub_inline_images(value: &mut Value) {
    match value {
        Value::Array(items) => {
            for item in items {
                scrub_inline_images(item);
            }
        }
        Value::Object(map) => {
            // User-message images have no `type` discriminator. Remove the
            // whole array, retaining only an image count for a truthful UI
            // placeholder after restart.
            if let Some(Value::Array(images)) = map.remove("images") {
                let count = images.len();
                if count > 0 {
                    map.insert("imageCount".to_string(), Value::from(count as u64));
                }
            }

            let is_image = map
                .get("type")
                .and_then(Value::as_str)
                .is_some_and(|typ| typ == "image" || typ == "image_url")
                || (map.contains_key("data")
                    && (map.contains_key("mimeType") || map.contains_key("mime_type")));
            if is_image && map.remove("data").is_some() {
                map.insert(
                    "text".to_string(),
                    Value::String("[图片附件未持久化]".to_string()),
                );
                map.insert("imageOmitted".to_string(), Value::Bool(true));
            }
            if map
                .get("url")
                .and_then(Value::as_str)
                .is_some_and(|url| url.starts_with("data:image/"))
            {
                map.insert(
                    "url".to_string(),
                    Value::String("[inline image omitted]".to_string()),
                );
                map.insert("imageOmitted".to_string(), Value::Bool(true));
            }
            for child in map.values_mut() {
                scrub_inline_images(child);
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn thread_payload_scrubber_removes_user_and_tool_image_base64() {
        let payload = serde_json::json!({
            "kind": "user_message",
            "text": "look",
            "images": [{"mimeType": "image/png", "data": "SECRET-BASE64"}],
            "nested": {
                "type": "image",
                "mimeType": "image/png",
                "data": "TOOL-IMAGE-BASE64"
            }
        });
        let scrubbed = scrub_inline_image_payload(payload);
        let encoded = serde_json::to_string(&scrubbed).unwrap();
        assert!(!encoded.contains("SECRET-BASE64"));
        assert!(!encoded.contains("TOOL-IMAGE-BASE64"));
        assert_eq!(scrubbed["imageCount"], 1);
        assert_eq!(scrubbed["nested"]["imageOmitted"], true);
    }

    #[test]
    fn delete_conversation_removes_messages_and_thread_entries() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("nex.db");
        let db = Database::new(&path).unwrap();

        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO projects (id, name, path, created_at, last_opened) VALUES ('p', 'P', '/tmp/p', 1, 1)",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO conversations (id, project_id, title, agent_type, status, created_at, updated_at) VALUES ('c', 'p', 'C', 'nex', 'idle', 1, 1)",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO messages (id, conversation_id, role, content, tool_summary, timestamp, sequence) VALUES ('m', 'c', 'user', 'hello', NULL, 1, 1)",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO thread_entries (id, conversation_id, kind, sequence, timestamp, payload_json) VALUES ('e', 'c', 'user_message', 0, 1, '{}')",
                [],
            )
            .unwrap();
        }

        db.delete_conversation("c").unwrap();

        let conn = db.conn.lock().unwrap();
        let conv_exists: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM conversations WHERE id = 'c')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let msg_exists: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM messages WHERE conversation_id = 'c')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let thread_exists: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM thread_entries WHERE conversation_id = 'c')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(!conv_exists);
        assert!(!msg_exists);
        assert!(!thread_exists);
    }

    #[test]
    fn opening_existing_database_scrubs_legacy_thread_image_payloads_once() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("nex.db");
        {
            // Simulate an older Nex database: it has the current table shape
            // but a pre-fix thread snapshot with inline attachment bytes.
            let conn = rusqlite::Connection::open(&path).unwrap();
            conn.execute_batch(crate::db::schema::SCHEMA).unwrap();
            conn.execute(
                "INSERT INTO projects (id, name, path, created_at, last_opened) VALUES ('p', 'P', '/tmp/p', 1, 1)",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO conversations (id, project_id, title, agent_type, status, created_at, updated_at) VALUES ('c', 'p', 'C', 'nex', 'idle', 1, 1)",
                [],
            )
            .unwrap();
            let payload = serde_json::json!({
                "kind": "user_message",
                "text": "look",
                "images": [{"mimeType": "image/png", "data": "LEGACY-USER-BASE64"}],
                "content": [{"type": "image", "mimeType": "image/png", "data": "LEGACY-TOOL-BASE64"}]
            });
            conn.execute(
                "INSERT INTO thread_entries (id, conversation_id, kind, sequence, timestamp, payload_json) VALUES ('e', 'c', 'user_message', 0, 1, ?1)",
                params![payload.to_string()],
            )
            .unwrap();
        }

        let db = Database::new(&path).expect("upgrade cleanup");
        let rows = db.get_thread_entries("c").unwrap();
        let encoded = rows[0].payload.to_string();
        assert!(!encoded.contains("LEGACY-USER-BASE64"));
        assert!(!encoded.contains("LEGACY-TOOL-BASE64"));
        assert_eq!(rows[0].payload["imageCount"], 1);
        assert_eq!(rows[0].payload["content"][0]["imageOmitted"], true);

        let conn = db.conn.lock().unwrap();
        let marker: String = conn
            .query_row(
                "SELECT value FROM nex_metadata WHERE key = 'thread_entries_inline_image_scrub_v1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(marker, "complete");
    }
}
