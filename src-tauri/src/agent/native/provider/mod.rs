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

/// The content of a chat message: plain text (legacy archives serialize this
/// way) or a list of multimodal parts (OpenAI wire format). `untagged` keeps
/// old transcript jsonl readable — a bare string deserializes as [`Content::Text`]
/// with no migration.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Content {
    Text(String),
    Parts(Vec<ContentPart>),
}

impl Content {
    /// Plain-text view of the content; `None` for multimodal parts.
    pub fn as_text(&self) -> Option<&str> {
        match self {
            Content::Text(s) => Some(s),
            Content::Parts(_) => None,
        }
    }

    /// Character count of the textual portion (compression bookkeeping).
    pub fn text_len(&self) -> usize {
        match self {
            Content::Text(s) => s.chars().count(),
            Content::Parts(parts) => parts
                .iter()
                .filter_map(|p| p.text.as_deref())
                .map(|t| t.chars().count())
                .sum(),
        }
    }
}

/// One part of a multimodal message (`type: "text" | "image_url"`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContentPart {
    #[serde(rename = "type")]
    pub typ: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image_url: Option<ImageUrl>,
}

impl ContentPart {
    pub fn text(text: impl Into<String>) -> Self {
        Self { typ: "text".into(), text: Some(text.into()), image_url: None }
    }
    /// `url` is a data URI (`data:{mime};base64,{data}`) or a remote URL.
    pub fn image(url: impl Into<String>) -> Self {
        Self { typ: "image_url".into(), text: None, image_url: Some(ImageUrl { url: url.into() }) }
    }
}

/// An OpenAI `image_url` part payload.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImageUrl {
    pub url: String,
}

/// One message in the OpenAI-compatible chat transcript.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<Content>,
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
        Self { role: "system".into(), content: Some(Content::Text(text.into())), tool_calls: None, tool_call_id: None, reasoning_content: None }
    }
    pub fn user(text: impl Into<String>) -> Self {
        Self { role: "user".into(), content: Some(Content::Text(text.into())), tool_calls: None, tool_call_id: None, reasoning_content: None }
    }
    pub fn assistant(text: impl Into<String>) -> Self {
        Self { role: "assistant".into(), content: Some(Content::Text(text.into())), tool_calls: None, tool_call_id: None, reasoning_content: None }
    }
    /// Assistant turn that only carries tool calls (content may be None).
    pub fn assistant_tool_calls(calls: Vec<ChatToolCall>, text: Option<String>) -> Self {
        Self { role: "assistant".into(), content: text.map(Content::Text), tool_calls: Some(calls), tool_call_id: None, reasoning_content: None }
    }
    pub fn tool_result(tool_call_id: impl Into<String>, content: impl Into<String>) -> Self {
        Self { role: "tool".into(), content: Some(Content::Text(content.into())), tool_calls: None, tool_call_id: Some(tool_call_id.into()), reasoning_content: None }
    }
    /// A user turn with multimodal parts (text + images + injected files).
    pub fn user_parts(parts: Vec<ContentPart>) -> Self {
        Self { role: "user".into(), content: Some(Content::Parts(parts)), tool_calls: None, tool_call_id: None, reasoning_content: None }
    }
    /// A user turn with arbitrary content (text or parts).
    pub fn user_content(content: Content) -> Self {
        Self { role: "user".into(), content: Some(content), tool_calls: None, tool_call_id: None, reasoning_content: None }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn content_text_serializes_as_plain_string() {
        let msg = ChatMessage::user("hi");
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains(r#""content":"hi""#), "got: {json}");
        // And round-trips back to Text.
        let back: ChatMessage = serde_json::from_str(&json).unwrap();
        assert_eq!(back.content.as_ref().and_then(Content::as_text), Some("hi"));
    }

    #[test]
    fn content_parts_serialize_as_array() {
        let msg = ChatMessage::user_parts(vec![
            ContentPart::text("看图"),
            ContentPart::image("data:image/png;base64,AAAA"),
        ]);
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains(r#""content":[{"type":"text","text":"看图"}"#), "got: {json}");
        assert!(json.contains(r#"{"type":"image_url","image_url":{"url":"data:image/png;base64,AAAA"}}"#), "got: {json}");

        let back: ChatMessage = serde_json::from_str(&json).unwrap();
        assert!(matches!(back.content, Some(Content::Parts(_))));
        assert_eq!(back.content.as_ref().and_then(Content::as_text), None);
    }

    #[test]
    fn legacy_string_archives_deserialize_as_text() {
        // Old transcripts stored `content` as a bare string.
        let legacy = r#"{"role":"user","content":"old archive"}"#;
        let msg: ChatMessage = serde_json::from_str(legacy).unwrap();
        assert_eq!(msg.content.as_ref().and_then(Content::as_text), Some("old archive"));
        assert!(matches!(msg.content, Some(Content::Text(_))));
    }

    #[test]
    fn text_len_counts_textual_portion() {
        assert_eq!(Content::Text("abc".into()).text_len(), 3);
        assert_eq!(
            Content::Parts(vec![ContentPart::text("ab"), ContentPart::text("cde")]).text_len(),
            5
        );
        assert_eq!(
            Content::Parts(vec![ContentPart::image("data:x")]).text_len(),
            0
        );
    }
}
