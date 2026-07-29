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
    pub fn create_conversation(&self, project_id: &str, agent_type: &str) -> Result<Conversation, NexError> {
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
        let convs = stmt.query_map(params![project_id], |row| {
            Ok(Conversation {
                id: row.get(0)?, project_id: row.get(1)?, title: row.get(2)?,
                agent_type: row.get(3)?, status: row.get(4)?, created_at: row.get(5)?, updated_at: row.get(6)?,
            })
        })?.collect::<Result<Vec<_>, _>>()?;
        Ok(convs)
    }

    pub fn append_message(&self, conversation_id: &str, role: &str, content: &str, tool_summary: Option<&str>) -> Result<Message, NexError> {
        let conn = self.conn.lock().unwrap();
        let now = chrono::Utc::now().timestamp_millis();
        let seq: i32 = conn.query_row(
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
        conn.execute(
            "INSERT INTO messages (id, conversation_id, role, content, tool_summary, timestamp, sequence) VALUES (?1,?2,?3,?4,?5,?6,?7)",
            params![msg.id, msg.conversation_id, msg.role, msg.content, msg.tool_summary, msg.timestamp, msg.sequence],
        )?;
        conn.execute("UPDATE conversations SET updated_at = ?1 WHERE id = ?2", params![now, conversation_id])?;
        Ok(msg)
    }

    pub fn get_messages(&self, conversation_id: &str, limit: i32, offset: i32) -> Result<Vec<Message>, NexError> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT id, conversation_id, role, content, tool_summary, timestamp, sequence FROM messages WHERE conversation_id = ?1 ORDER BY sequence ASC LIMIT ?2 OFFSET ?3")?;
        let msgs = stmt.query_map(params![conversation_id, limit, offset], |row| {
            Ok(Message {
                id: row.get(0)?, conversation_id: row.get(1)?, role: row.get(2)?,
                content: row.get(3)?, tool_summary: row.get(4)?, timestamp: row.get(5)?, sequence: row.get(6)?,
            })
        })?.collect::<Result<Vec<_>, _>>()?;
        Ok(msgs)
    }

    pub fn update_conversation_status(&self, id: &str, status: &str) -> Result<(), NexError> {
        let conn = self.conn.lock().unwrap();
        let now = chrono::Utc::now().timestamp_millis();
        conn.execute("UPDATE conversations SET status = ?1, updated_at = ?2 WHERE id = ?3", params![status, now, id])?;
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
            tx.execute(
                "INSERT INTO thread_entries (id, conversation_id, kind, sequence, timestamp, payload_json)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    Uuid::new_v4().to_string(),
                    conversation_id,
                    e.kind,
                    e.sequence,
                    e.timestamp,
                    serde_json::to_string(&e.payload).unwrap_or_else(|_| "null".to_string())
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
                let payload: Value = serde_json::from_str(&payload_json)
                    .unwrap_or_else(|_| Value::Null);

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
}
