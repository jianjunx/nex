use serde::Serialize;
use thiserror::Error;

#[derive(Debug, Error, Serialize)]
#[serde(tag = "type", content = "message")]
pub enum NexError {
    #[error("Agent error: {0}")]
    Agent(String),
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
