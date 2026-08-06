//! Provider abstraction for the native agent.
//!
//! A [`Provider`] turns an assembled [`ChatRequest`] into a stream of
//! [`Chunk`]s. The harness loop in `session.rs` consumes those chunks,
//! accumulating assistant text and tool calls. Only DeepSeek is wired today,
//! but the trait keeps the door open for other OpenAI-compatible endpoints.

pub mod deepseek;

use serde::{Deserialize, Serialize};

use crate::error::NexError;

/// Reasoning-effort hint forwarded to the provider.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ReasoningControl {
    Off,
    Low,
    Medium,
    High,
}

impl ReasoningControl {
    pub fn parse(s: &str) -> Self {
        match s.to_ascii_lowercase().as_str() {
            "low" => Self::Low,
            "medium" | "med" => Self::Medium,
            "high" => Self::High,
            _ => Self::Off,
        }
    }

    /// Wire id used by the Composer config option.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Off => "off",
            Self::Low => "low",
            Self::Medium => "medium",
            Self::High => "high",
        }
    }
}

/// A fully-accumulated tool call emitted by the provider.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NativeToolCall {
    pub id: String,
    pub name: String,
    /// Parsed JSON arguments (already decoded from the wire's string form).
    pub arguments: serde_json::Value,
}

/// Token accounting reported by the provider at stream end.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Usage {
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
    /// DeepSeek prefix-cache hit tokens (observability metric, Phase 2).
    pub cache_hit_tokens: u64,
}

/// Why the model stopped producing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StopReasonKind {
    /// Natural end of turn.
    EndTurn,
    /// The model wants tool calls to be executed.
    ToolCalls,
    /// Generation hit the token cap.
    MaxTokens,
    /// Interrupted by the user.
    Cancelled,
}

/// A single streamed item from the provider.
pub enum Chunk {
    /// Assistant text delta.
    Text(String),
    /// Assistant internal-reasoning delta (DeepSeek `reasoning_content`).
    Thinking(String),
    /// A complete tool call (arguments already accumulated + parsed).
    ToolCall(NativeToolCall),
    /// Stream finished.
    Done { stop_reason: StopReasonKind, usage: Option<Usage> },
    /// Provider-side failure; the loop surfaces it as a tool/turn error.
    Error(String),
}

/// One message in the OpenAI-compatible chat transcript.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<ChatToolCall>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    /// DeepSeek reasoner thought channel (kept for transcript fidelity).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning_content: Option<String>,
}

impl ChatMessage {
    pub fn system(text: impl Into<String>) -> Self {
        Self { role: "system".into(), content: Some(text.into()), tool_calls: None, tool_call_id: None, reasoning_content: None }
    }
    pub fn user(text: impl Into<String>) -> Self {
        Self { role: "user".into(), content: Some(text.into()), tool_calls: None, tool_call_id: None, reasoning_content: None }
    }
    pub fn assistant(text: impl Into<String>) -> Self {
        Self { role: "assistant".into(), content: Some(text.into()), tool_calls: None, tool_call_id: None, reasoning_content: None }
    }
    /// Assistant turn that only carries tool calls (content may be None).
    pub fn assistant_tool_calls(calls: Vec<ChatToolCall>, text: Option<String>) -> Self {
        Self { role: "assistant".into(), content: text, tool_calls: Some(calls), tool_call_id: None, reasoning_content: None }
    }
    pub fn tool_result(tool_call_id: impl Into<String>, content: impl Into<String>) -> Self {
        Self { role: "tool".into(), content: Some(content.into()), tool_calls: None, tool_call_id: Some(tool_call_id.into()), reasoning_content: None }
    }
}

/// A tool call as serialized on the OpenAI wire.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatToolCall {
    pub id: String,
    #[serde(rename = "type")]
    pub typ: String,
    pub function: ChatToolCallFunction,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatToolCallFunction {
    pub name: String,
    /// Arguments serialized as a JSON string (OpenAI wire format).
    pub arguments: String,
}

/// One tool exposed to the model (`{"type":"function","function":{...}}`).
#[derive(Debug, Clone, Serialize)]
pub struct ToolSpec {
    #[serde(rename = "type")]
    pub typ: String,
    pub function: FunctionSpec,
}

#[derive(Debug, Clone, Serialize)]
pub struct FunctionSpec {
    pub name: String,
    pub description: String,
    pub parameters: serde_json::Value,
}

/// Everything a provider needs to run one completion.
#[derive(Debug, Clone)]
pub struct ChatRequest {
    pub model: String,
    pub messages: Vec<ChatMessage>,
    pub tools: Vec<ToolSpec>,
    pub reasoning: ReasoningControl,
    pub max_tokens: Option<u32>,
    pub temperature: Option<f32>,
}

/// Receiver end of a provider stream.
pub type ChunkStream = tokio::sync::mpsc::UnboundedReceiver<Chunk>;

/// A model provider that streams chat completions.
#[async_trait::async_trait]
pub trait Provider: Send + Sync {
    /// Human-readable provider id (e.g. `deepseek`).
    fn name(&self) -> &str;
    /// Start streaming; chunks arrive on the returned receiver.
    async fn stream(&self, req: ChatRequest) -> Result<ChunkStream, NexError>;
}
