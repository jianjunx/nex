use serde::Serialize;
use thiserror::Error;

#[derive(Debug, Clone, Error, Serialize)]
#[serde(tag = "type", content = "message")]
pub enum NexError {
    #[error("Agent error: {0}")]
    Agent(String),
    /// The agent could not be started because a runtime dependency (Node.js,
    /// the agent's npm package, etc.) is missing or unreachable. `what` names
    /// the dependency, `hint` is a user-actionable remediation string.
    #[error("Agent not installed ({what}): {hint}")]
    #[serde(rename = "agentNotInstalled")]
    AgentNotInstalled {
        what: &'static str,
        hint: String,
    },
    #[error("Git error: {0}")]
    Git(String),
    #[error("Terminal error: {0}")]
    Terminal(String),
    #[error("FileSystem error: {0}")]
    FileSystem(String),
    #[error("Database error: {0}")]
    Database(String),
    #[error("Internal error: {0}")]
    Internal(String),
}

impl From<rusqlite::Error> for NexError {
    fn from(e: rusqlite::Error) -> Self {
        NexError::Database(e.to_string())
    }
}

impl From<git2::Error> for NexError {
    fn from(e: git2::Error) -> Self {
        NexError::Git(e.to_string())
    }
}

impl From<std::io::Error> for NexError {
    fn from(e: std::io::Error) -> Self {
        NexError::Internal(e.to_string())
    }
}

impl From<agent_client_protocol::Error> for NexError {
    fn from(e: agent_client_protocol::Error) -> Self {
        NexError::Agent(e.to_string())
    }
}
