//! Provider abstraction for the native agent.
//!
//! A [`Provider`] turns an assembled [`ChatRequest`] into a stream of
//! [`Chunk`]s. The harness loop in `session.rs` consumes those chunks,
//! accumulating assistant text and tool calls. Only DeepSeek is wired today,
//! but the trait keeps the door open for other OpenAI-compatible endpoints.

pub mod deepseek;

use serde::{Deserialize, Serialize};

use crate::error::NexError;

/// Join an OpenAI-compatible API path onto a user-supplied base URL.
///
/// Settings often store a host-only base (`https://api.example.com`). Most
/// OpenAI-compatible gateways expose the surface under `/v1`, so a bare host
/// plus `/chat/completions` 404s (`default backend - 404`). DeepSeek accepts
/// both forms; others typically require `/v1`. If the base already ends with
/// a `/vN` segment (or already includes `path`), it is left alone.
pub fn openai_endpoint(base_url: &str, path: &str) -> String {
    let path = path.trim_start_matches('/');
    let mut base = base_url.trim().trim_end_matches('/').to_string();
    if base.is_empty() {
        return format!("/{path}");
    }
    if base.ends_with(path) {
        return base;
    }
    let last = base.rsplit('/').next().unwrap_or("");
    let has_version = last.len() >= 2
        && last.as_bytes()[0] == b'v'
        && last[1..].bytes().all(|b| b.is_ascii_digit());
    if !has_version {
        base.push_str("/v1");
    }
    format!("{base}/{path}")
}

/// Map an OpenAI-compatible HTTP error into a short, actionable message.
///
/// DeepSeek and many `/v1` gateways return `402` + `Insufficient Balance`
/// (or a 400 with the same body). Dumping the raw JSON into the transcript
/// is not useful; billing / auth failures need a recharge-or-check-key hint.
pub fn format_model_http_error(status: reqwest::StatusCode, body: &str) -> String {
    let code = status.as_u16();
    let provider_msg = extract_provider_error_message(body);
    if is_billing_error(status, body) {
        return format!("账户余额不足（HTTP {code}）。请到模型供应商控制台充值后再试。");
    }
    match code {
        401 => "API Key 无效或已过期，请在设置中检查密钥。".into(),
        403 => "没有访问该模型的权限，请检查 API Key 或模型开通状态。".into(),
        404 => "模型或接口不存在，请检查供应商地址和模型 ID。".into(),
        429 => "请求过于频繁，请稍后再试。".into(),
        500..=599 => format!("模型服务暂时不可用（HTTP {code}），请稍后重试。"),
        _ if !provider_msg.is_empty() => format!("模型接口返回 HTTP {code}：{provider_msg}"),
        _ => format!("模型接口返回 HTTP {code}"),
    }
}

/// True for payment / quota failures (DeepSeek `402`, or a 4xx whose body
/// names insufficient balance / credits).
pub fn is_billing_error(status: reqwest::StatusCode, body: &str) -> bool {
    if status.as_u16() == 402 {
        return true;
    }
    let lower = extract_provider_error_message(body).to_ascii_lowercase();
    let hay = if lower.is_empty() {
        body.to_ascii_lowercase()
    } else {
        lower
    };
    (hay.contains("insufficient")
        && (hay.contains("balance") || hay.contains("credit") || hay.contains("quota")))
        || hay.contains("余额不足")
        || hay.contains("欠费")
}

fn extract_provider_error_message(body: &str) -> String {
    let trimmed = body.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(trimmed) {
        for pointer in ["/error/message", "/message", "/error/msg"] {
            if let Some(s) = v.pointer(pointer).and_then(|m| m.as_str()).map(str::trim) {
                if !s.is_empty() {
                    return s.to_string();
                }
            }
        }
    }
    trimmed.chars().take(160).collect()
}

/// Reasoning-effort hint forwarded to the provider.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ReasoningControl {
    Off,
    Minimal,
    Low,
    Medium,
    High,
    XHigh,
    /// DeepSeek V4 / Kimi K3 top tier (`reasoning_effort: "max"`).
    Max,
}

impl ReasoningControl {
    pub fn parse(s: &str) -> Self {
        match s.to_ascii_lowercase().as_str() {
            "minimal" | "min" => Self::Minimal,
            "low" => Self::Low,
            "medium" | "med" => Self::Medium,
            "high" => Self::High,
            "xhigh" | "x-high" | "extra" => Self::XHigh,
            "max" => Self::Max,
            _ => Self::Off,
        }
    }

    /// Wire id used by the Composer config option / API body.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Off => "off",
            Self::Minimal => "minimal",
            Self::Low => "low",
            Self::Medium => "medium",
            Self::High => "high",
            Self::XHigh => "xhigh",
            Self::Max => "max",
        }
    }

    /// Wire id used by the Composer config option / API body. Also the
    /// display label: Composer shows the raw API value (off/low/…),
    /// not a localized alias, so users can match docs & probes.
    pub fn display_name(self) -> &'static str {
        self.as_str()
    }

    /// Pick a valid level for the given model options; prefer current, then
    /// medium, then the first non-off entry, then off/first.
    pub fn clamp_to(self, levels: &[String]) -> Self {
        if levels.is_empty() {
            return Self::Off;
        }
        let cur = self.as_str();
        if levels.iter().any(|l| l.eq_ignore_ascii_case(cur)) {
            return self;
        }
        for pref in ["medium", "high", "low", "minimal", "xhigh", "max", "off"] {
            if let Some(l) = levels.iter().find(|l| l.eq_ignore_ascii_case(pref)) {
                return Self::parse(l);
            }
        }
        Self::parse(&levels[0])
    }
}

/// Reserved argument key used when a tool-call delta could not be parsed.
/// The harness turns these into `ERROR:` tool results instead of aborting
/// the whole turn.
pub const PARSE_ERROR_KEY: &str = "__nex_parse_error";

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
    /// Prompt-cache hit tokens (DeepSeek / OpenAI `cached_tokens` /
    /// Anthropic `cache_read_input_tokens`).
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
    Done {
        stop_reason: StopReasonKind,
        usage: Option<Usage>,
    },
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
        Self {
            typ: "text".into(),
            text: Some(text.into()),
            image_url: None,
        }
    }
    /// `url` is a data URI (`data:{mime};base64,{data}`) or a remote URL.
    pub fn image(url: impl Into<String>) -> Self {
        Self {
            typ: "image_url".into(),
            text: None,
            image_url: Some(ImageUrl { url: url.into() }),
        }
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
        Self {
            role: "system".into(),
            content: Some(Content::Text(text.into())),
            tool_calls: None,
            tool_call_id: None,
            reasoning_content: None,
        }
    }
    pub fn user(text: impl Into<String>) -> Self {
        Self {
            role: "user".into(),
            content: Some(Content::Text(text.into())),
            tool_calls: None,
            tool_call_id: None,
            reasoning_content: None,
        }
    }
    pub fn assistant(text: impl Into<String>) -> Self {
        Self {
            role: "assistant".into(),
            content: Some(Content::Text(text.into())),
            tool_calls: None,
            tool_call_id: None,
            reasoning_content: None,
        }
    }
    /// Assistant turn that only carries tool calls (content may be None).
    pub fn assistant_tool_calls(calls: Vec<ChatToolCall>, text: Option<String>) -> Self {
        Self {
            role: "assistant".into(),
            content: text.map(Content::Text),
            tool_calls: Some(calls),
            tool_call_id: None,
            reasoning_content: None,
        }
    }
    pub fn tool_result(tool_call_id: impl Into<String>, content: impl Into<String>) -> Self {
        Self {
            role: "tool".into(),
            content: Some(Content::Text(content.into())),
            tool_calls: None,
            tool_call_id: Some(tool_call_id.into()),
            reasoning_content: None,
        }
    }
    /// A user turn with multimodal parts (text + images + injected files).
    pub fn user_parts(parts: Vec<ContentPart>) -> Self {
        Self {
            role: "user".into(),
            content: Some(Content::Parts(parts)),
            tool_calls: None,
            tool_call_id: None,
            reasoning_content: None,
        }
    }
    /// A user turn with arbitrary content (text or parts).
    pub fn user_content(content: Content) -> Self {
        Self {
            role: "user".into(),
            content: Some(content),
            tool_calls: None,
            tool_call_id: None,
            reasoning_content: None,
        }
    }
}

/// Rewrites empty or duplicate tool-call ids so OpenAI-compatible gateways
/// accept the transcript (`Duplicate value for 'tool_call_id'` 400s).
///
/// Walks assistant `tool_calls` in order; when an id is blank or already seen
/// earlier in the transcript, assigns a fresh `call_<uuid>` and rewrites the
/// immediately following `role=tool` results **by position** so pairing stays
/// intact. Stable ids that are already unique are left unchanged.
pub fn ensure_unique_tool_call_ids(messages: &mut [ChatMessage]) {
    use std::collections::HashSet;
    let mut seen: HashSet<String> = HashSet::new();
    let mut i = 0;
    while i < messages.len() {
        let Some(calls) = messages[i].tool_calls.as_mut() else {
            i += 1;
            continue;
        };
        let mut new_ids: Vec<String> = Vec::with_capacity(calls.len());
        for call in calls.iter_mut() {
            let trimmed = call.id.trim();
            let id = if trimmed.is_empty() || seen.contains(trimmed) {
                fresh_tool_call_id(&seen)
            } else {
                trimmed.to_string()
            };
            seen.insert(id.clone());
            call.id = id.clone();
            new_ids.push(id);
        }
        let mut j = i + 1;
        let mut k = 0;
        while j < messages.len() && k < new_ids.len() && messages[j].role == "tool" {
            messages[j].tool_call_id = Some(new_ids[k].clone());
            k += 1;
            j += 1;
        }
        i += 1;
    }
}

fn fresh_tool_call_id(seen: &std::collections::HashSet<String>) -> String {
    loop {
        let id = format!("call_{}", uuid::Uuid::new_v4().simple());
        if !seen.contains(&id) {
            return id;
        }
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
    /// Provider's preferred reserved response budget for `model_id`, if
    /// known. Returning `None` means "use the global default", which the
    /// budget module derives from model id heuristics. Keep this cheap —
    /// it is queried on every turn.
    fn reserved_response_hint(&self, _model_id: &str) -> Option<u64> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn format_model_http_error_maps_deepseek_402() {
        let body = r#"{"error":{"message":"Insufficient Balance","type":"unknown_error","param":null,"code":"invalid_request_error"}}"#;
        let msg = format_model_http_error(reqwest::StatusCode::PAYMENT_REQUIRED, body);
        assert!(msg.contains("余额不足"), "{msg}");
        assert!(!msg.contains("invalid_request_error"), "{msg}");
        assert!(is_billing_error(reqwest::StatusCode::PAYMENT_REQUIRED, body));
    }

    #[test]
    fn format_model_http_error_maps_400_insufficient_balance() {
        let body = r#"{"error":{"message":"Insufficient Balance"}}"#;
        assert!(is_billing_error(reqwest::StatusCode::BAD_REQUEST, body));
        let msg = format_model_http_error(reqwest::StatusCode::BAD_REQUEST, body);
        assert!(msg.contains("余额不足"), "{msg}");
    }

    #[test]
    fn format_model_http_error_extracts_json_message() {
        let msg = format_model_http_error(
            reqwest::StatusCode::BAD_REQUEST,
            r#"{"error":{"message":"bad api key"}}"#,
        );
        assert!(msg.contains("400"), "{msg}");
        assert!(msg.contains("bad api key"), "{msg}");
    }

    #[test]
    fn format_model_http_error_maps_401() {
        let msg = format_model_http_error(reqwest::StatusCode::UNAUTHORIZED, "");
        assert!(msg.contains("API Key"), "{msg}");
    }

    #[test]
    fn openai_endpoint_injects_v1_when_missing() {
        assert_eq!(
            openai_endpoint("https://ai-gateway.example.com", "chat/completions"),
            "https://ai-gateway.example.com/v1/chat/completions"
        );
        assert_eq!(
            openai_endpoint("https://api.deepseek.com/", "chat/completions"),
            "https://api.deepseek.com/v1/chat/completions"
        );
        assert_eq!(
            openai_endpoint("https://api.openai.com/v1", "chat/completions"),
            "https://api.openai.com/v1/chat/completions"
        );
        assert_eq!(
            openai_endpoint("https://api.openai.com/v1/", "models"),
            "https://api.openai.com/v1/models"
        );
        assert_eq!(
            openai_endpoint(
                "https://dashscope.aliyuncs.com/compatible-mode/v1",
                "models"
            ),
            "https://dashscope.aliyuncs.com/compatible-mode/v1/models"
        );
        // Already a full endpoint — do not double-append.
        assert_eq!(
            openai_endpoint(
                "https://api.openai.com/v1/chat/completions",
                "chat/completions"
            ),
            "https://api.openai.com/v1/chat/completions"
        );
    }

    fn tool_call(id: &str, name: &str) -> ChatToolCall {
        ChatToolCall {
            id: id.into(),
            typ: "function".into(),
            function: ChatToolCallFunction {
                name: name.into(),
                arguments: "{}".into(),
            },
        }
    }

    #[test]
    fn ensure_unique_tool_call_ids_rewrites_empty_and_reused() {
        let mut msgs = vec![
            ChatMessage::system("sys"),
            ChatMessage::assistant_tool_calls(vec![tool_call("call_a", "read_file")], None),
            ChatMessage::tool_result("call_a", "ok"),
            ChatMessage::assistant_tool_calls(
                vec![
                    tool_call("", "ls"),
                    tool_call("call_a", "grep"), // reused from prior turn
                    tool_call("dup", "bash"),
                    tool_call("dup", "read_file"), // duplicate within round
                ],
                None,
            ),
            ChatMessage::tool_result("", "a"),
            ChatMessage::tool_result("call_a", "b"),
            ChatMessage::tool_result("dup", "c"),
            ChatMessage::tool_result("dup", "d"),
        ];
        ensure_unique_tool_call_ids(&mut msgs);

        let first = msgs[1].tool_calls.as_ref().unwrap();
        assert_eq!(first[0].id, "call_a");
        assert_eq!(msgs[2].tool_call_id.as_deref(), Some("call_a"));

        let second = msgs[3].tool_calls.as_ref().unwrap();
        assert!(!second[0].id.trim().is_empty());
        assert_ne!(second[1].id, "call_a");
        assert_eq!(second[2].id, "dup");
        assert_ne!(second[3].id, "dup");
        let ids: Vec<&str> = second.iter().map(|c| c.id.as_str()).collect();
        let unique: std::collections::HashSet<_> = ids.iter().copied().collect();
        assert_eq!(unique.len(), 4);
        for (i, msg) in msgs[4..8].iter().enumerate() {
            assert_eq!(msg.tool_call_id.as_deref(), Some(second[i].id.as_str()));
        }
        assert!(!ids.contains(&"call_a"));
    }

    #[test]
    fn ensure_unique_tool_call_ids_is_noop_for_unique_ids() {
        let mut msgs = vec![
            ChatMessage::assistant_tool_calls(vec![tool_call("a", "ls")], None),
            ChatMessage::tool_result("a", "ok"),
            ChatMessage::assistant_tool_calls(vec![tool_call("b", "ls")], None),
            ChatMessage::tool_result("b", "ok"),
        ];
        ensure_unique_tool_call_ids(&mut msgs);
        assert_eq!(
            msgs[0].tool_calls.as_ref().unwrap()[0].id,
            "a"
        );
        assert_eq!(msgs[1].tool_call_id.as_deref(), Some("a"));
        assert_eq!(
            msgs[2].tool_calls.as_ref().unwrap()[0].id,
            "b"
        );
        assert_eq!(msgs[3].tool_call_id.as_deref(), Some("b"));
    }

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
        assert!(
            json.contains(r#""content":[{"type":"text","text":"看图"}"#),
            "got: {json}"
        );
        assert!(
            json.contains(
                r#"{"type":"image_url","image_url":{"url":"data:image/png;base64,AAAA"}}"#
            ),
            "got: {json}"
        );

        let back: ChatMessage = serde_json::from_str(&json).unwrap();
        assert!(matches!(back.content, Some(Content::Parts(_))));
        assert_eq!(back.content.as_ref().and_then(Content::as_text), None);
    }

    #[test]
    fn legacy_string_archives_deserialize_as_text() {
        // Old transcripts stored `content` as a bare string.
        let legacy = r#"{"role":"user","content":"old archive"}"#;
        let msg: ChatMessage = serde_json::from_str(legacy).unwrap();
        assert_eq!(
            msg.content.as_ref().and_then(Content::as_text),
            Some("old archive")
        );
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
