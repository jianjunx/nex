//! The `todo_write` tool: the model's scratch plan. The harness mirrors the
//! validated entries to the client as an ACP `session/update:plan`.

use super::{Tool, ToolCtx};
use agent_client_protocol as acp;

/// One validated todo entry (mirrors ACP `PlanEntry` shapes).
#[derive(Debug, Clone)]
pub struct TodoEntry {
    pub content: String,
    pub status: TodoStatus,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TodoStatus {
    Pending,
    InProgress,
    Completed,
    Cancelled,
}

impl TodoStatus {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "pending" => Some(Self::Pending),
            "in_progress" => Some(Self::InProgress),
            "completed" => Some(Self::Completed),
            "cancelled" => Some(Self::Cancelled),
            _ => None,
        }
    }

    pub fn to_acp(self) -> acp::PlanEntryStatus {
        match self {
            Self::Pending | Self::Cancelled => acp::PlanEntryStatus::Pending,
            Self::InProgress => acp::PlanEntryStatus::InProgress,
            Self::Completed => acp::PlanEntryStatus::Completed,
        }
    }
}

/// Parses and validates the raw `todos` argument.
pub fn parse_todos(args: &serde_json::Value) -> Result<Vec<TodoEntry>, String> {
    let todos = args
        .get("todos")
        .and_then(|v| v.as_array())
        .ok_or("missing required argument `todos`")?;
    if todos.is_empty() {
        return Err("`todos` must not be empty".into());
    }
    let mut out = Vec::with_capacity(todos.len());
    for (i, item) in todos.iter().enumerate() {
        let content = item
            .get("content")
            .and_then(|v| v.as_str())
            .filter(|s| !s.trim().is_empty())
            .ok_or_else(|| format!("todos[{i}]: missing `content`"))?;
        let status = item
            .get("status")
            .and_then(|v| v.as_str())
            .and_then(TodoStatus::parse)
            .ok_or_else(|| format!("todos[{i}]: `status` must be one of pending/in_progress/completed/cancelled"))?;
        out.push(TodoEntry { content: content.trim().to_string(), status });
    }
    Ok(out)
}

pub struct TodoWrite;

#[async_trait::async_trait(?Send)]
impl Tool for TodoWrite {
    fn name(&self) -> &'static str {
        "todo_write"
    }
    fn description(&self) -> &'static str {
        "Create or replace the full task list for the current request. \
         Call it whenever the plan changes; always send the complete list. \
         Statuses: pending, in_progress, completed, cancelled."
    }
    fn schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "todos": {
                    "type": "array",
                    "description": "The complete task list (replaces the previous one).",
                    "items": {
                        "type": "object",
                        "properties": {
                            "content": { "type": "string", "description": "Short task description." },
                            "status": { "type": "string", "enum": ["pending", "in_progress", "completed", "cancelled"] }
                        },
                        "required": ["content", "status"],
                        "additionalProperties": false
                    }
                }
            },
            "required": ["todos"],
            "additionalProperties": false
        })
    }
    fn kind(&self) -> acp::ToolKind {
        acp::ToolKind::Think
    }
    fn read_only(&self) -> bool {
        true
    }
    async fn execute(&self, args: serde_json::Value, _ctx: &ToolCtx) -> Result<String, String> {
        let entries = parse_todos(&args)?;
        let done = entries.iter().filter(|e| e.status == TodoStatus::Completed).count();
        Ok(format!("updated plan: {} task(s), {} completed", entries.len(), done))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_valid_todos() {
        let args = serde_json::json!({
            "todos": [
                {"content": "a", "status": "pending"},
                {"content": "b", "status": "in_progress"},
                {"content": "c", "status": "completed"}
            ]
        });
        let entries = parse_todos(&args).unwrap();
        assert_eq!(entries.len(), 3);
        assert_eq!(entries[1].status, TodoStatus::InProgress);
    }

    #[test]
    fn rejects_bad_status() {
        let args = serde_json::json!({"todos": [{"content": "a", "status": "bogus"}]});
        assert!(parse_todos(&args).is_err());
        let args = serde_json::json!({"todos": []});
        assert!(parse_todos(&args).is_err());
    }
}
