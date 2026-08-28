//! OpenAI Responses API adapter.
//!
//! Unlike Chat Completions, Responses returns typed output items. Nex stores
//! those items on the assistant transcript entry and replays them verbatim in
//! later stateless (`store: false`) requests. This preserves function-call
//! linkage and encrypted reasoning without relying on server-side retention.

use std::collections::HashSet;

use serde_json::{json, Value};

use super::{
    ChatMessage, ChatRequest, Chunk, ChunkStream, Content, NativeToolCall, Provider,
    ReasoningControl, StopReasonKind, Usage, PARSE_ERROR_KEY,
};
use crate::error::NexError;

#[derive(Clone)]
pub struct ResponsesProvider {
    base_url: String,
    api_key: String,
    client: reqwest::Client,
}

impl ResponsesProvider {
    pub fn new(base_url: impl Into<String>, api_key: impl Into<String>) -> Self {
        Self {
            base_url: base_url.into(),
            api_key: api_key.into(),
            client: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(300))
                .build()
                .unwrap_or_default(),
        }
    }

    fn url(&self) -> String {
        super::openai_endpoint(&self.base_url, "responses")
    }

    fn build_body(&self, req: &ChatRequest) -> Value {
        let (instructions, input) = response_input(&req.messages);
        let tools: Vec<Value> = req
            .tools
            .iter()
            .map(|tool| {
                json!({
                    "type": "function",
                    "name": tool.function.name,
                    "description": tool.function.description,
                    "parameters": tool.function.parameters,
                    "strict": false
                })
            })
            .collect();
        let mut body = json!({
            "model": req.model,
            "input": input,
            "stream": true,
            "store": false,
            "include": ["reasoning.encrypted_content"],
            "parallel_tool_calls": true
        });
        if !instructions.is_empty() {
            body["instructions"] = Value::String(instructions);
        }
        if !tools.is_empty() {
            body["tools"] = Value::Array(tools);
        }
        if let Some(max) = req.max_tokens {
            body["max_output_tokens"] = json!(max);
        }
        if let Some(temperature) = req.temperature {
            body["temperature"] = json!(temperature);
        }
        if req.reasoning != ReasoningControl::Off {
            body["reasoning"] = json!({ "effort": req.reasoning.as_str() });
        }
        body
    }
}

#[async_trait::async_trait]
impl Provider for ResponsesProvider {
    fn name(&self) -> &str {
        "openai-responses"
    }

    fn reserved_response_hint(&self, _model_id: &str) -> Option<u64> {
        Some(16_384)
    }

    async fn stream(&self, req: ChatRequest) -> Result<ChunkStream, NexError> {
        let body = self.build_body(&req);
        log::info!(
            target: crate::agent::native::diag::TARGET,
            "http POST {} model={} input_items={} tools={}",
            self.url(),
            req.model,
            body["input"].as_array().map_or(0, Vec::len),
            req.tools.len()
        );
        let response = self
            .client
            .post(self.url())
            .bearer_auth(&self.api_key)
            .header("Accept", "text/event-stream")
            .json(&body)
            .send()
            .await
            .map_err(|error| NexError::Agent(format!("model request failed: {error}")))?;
        let status = response.status();
        if !status.is_success() {
            let text = response.text().await.unwrap_or_default();
            return Err(NexError::Agent(super::format_model_http_error(
                status, &text,
            )));
        }

        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        tokio::spawn(async move {
            if let Err(error) = pump_sse(response, tx.clone()).await {
                let _ = tx.send(Chunk::Error(error));
            }
        });
        Ok(rx)
    }
}

fn response_input(messages: &[ChatMessage]) -> (String, Vec<Value>) {
    let mut instructions = Vec::new();
    let mut input = Vec::new();
    for message in messages {
        if message.role == "system" {
            if let Some(text) = message.content.as_ref().and_then(Content::as_text) {
                instructions.push(text.to_string());
            }
            continue;
        }
        if !message.response_items.is_empty() {
            input.extend(message.response_items.iter().cloned());
            continue;
        }
        match message.role.as_str() {
            "user" => input.push(json!({
                "type": "message",
                "role": "user",
                "content": input_content(message.content.as_ref())
            })),
            "assistant" => {
                if let Some(calls) = &message.tool_calls {
                    for call in calls {
                        input.push(json!({
                            "type": "function_call",
                            "call_id": call.id,
                            "name": call.function.name,
                            "arguments": call.function.arguments
                        }));
                    }
                }
                if let Some(text) = message.content.as_ref().and_then(Content::as_text) {
                    if !text.is_empty() {
                        input.push(json!({
                            "type": "message",
                            "role": "assistant",
                            "content": [{ "type": "output_text", "text": text }]
                        }));
                    }
                }
            }
            "tool" => input.push(json!({
                "type": "function_call_output",
                "call_id": message.tool_call_id.as_deref().unwrap_or_default(),
                "output": content_text(message.content.as_ref())
            })),
            _ => {}
        }
    }
    (instructions.join("\n\n"), input)
}

fn input_content(content: Option<&Content>) -> Vec<Value> {
    match content {
        Some(Content::Text(text)) => vec![json!({ "type": "input_text", "text": text })],
        Some(Content::Parts(parts)) => parts
            .iter()
            .filter_map(|part| match part.typ.as_str() {
                "text" => part
                    .text
                    .as_ref()
                    .map(|text| json!({ "type": "input_text", "text": text })),
                "image_url" => part
                    .image_url
                    .as_ref()
                    .map(|image| json!({ "type": "input_image", "image_url": image.url })),
                _ => None,
            })
            .collect(),
        None => Vec::new(),
    }
}

fn content_text(content: Option<&Content>) -> String {
    match content {
        Some(Content::Text(text)) => text.clone(),
        Some(Content::Parts(parts)) => parts
            .iter()
            .filter_map(|part| part.text.as_deref())
            .collect::<Vec<_>>()
            .join("\n"),
        None => String::new(),
    }
}

async fn pump_sse(
    mut response: reqwest::Response,
    tx: tokio::sync::mpsc::UnboundedSender<Chunk>,
) -> Result<(), String> {
    let mut buffer = String::new();
    let mut emitted_calls = HashSet::new();
    let mut emitted_items = HashSet::new();
    let mut terminal_sent = false;
    while let Some(bytes) = response
        .chunk()
        .await
        .map_err(|error| format!("model stream error: {error}"))?
    {
        buffer.push_str(&String::from_utf8_lossy(&bytes));
        while let Some(newline) = buffer.find('\n') {
            let line: String = buffer.drain(..=newline).collect();
            let Some(data) = line.trim().strip_prefix("data:") else {
                continue;
            };
            let data = data.trim();
            if data.is_empty() || data == "[DONE]" {
                continue;
            }
            let event: Value = match serde_json::from_str(data) {
                Ok(event) => event,
                Err(error) => {
                    log::warn!("responses stream: skipping malformed SSE payload: {error}");
                    continue;
                }
            };
            terminal_sent |= handle_event(&event, &tx, &mut emitted_calls, &mut emitted_items)?;
            if tx.is_closed() {
                return Ok(());
            }
        }
    }
    if !terminal_sent {
        let _ = tx.send(Chunk::Done {
            stop_reason: StopReasonKind::EndTurn,
            usage: None,
        });
    }
    Ok(())
}

fn handle_event(
    event: &Value,
    tx: &tokio::sync::mpsc::UnboundedSender<Chunk>,
    emitted_calls: &mut HashSet<String>,
    emitted_items: &mut HashSet<String>,
) -> Result<bool, String> {
    let typ = event
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default();
    match typ {
        "response.output_text.delta" => send_delta(event, "delta", tx, Chunk::Text),
        "response.reasoning_summary_text.delta" => send_delta(event, "delta", tx, Chunk::Thinking),
        "response.output_item.done" => {
            if let Some(item) = event.get("item") {
                emit_response_item(item, tx, emitted_items)?;
                emit_function_call(item, tx, emitted_calls)?;
            }
        }
        "response.completed" => {
            let response = event.get("response").unwrap_or(event);
            // Some gateways omit output_item.done; recover all completed items.
            if let Some(items) = response.get("output").and_then(Value::as_array) {
                for item in items {
                    emit_response_item(item, tx, emitted_items)?;
                    emit_function_call(item, tx, emitted_calls)?;
                }
            }
            let usage = response.get("usage").and_then(parse_usage);
            let status = response
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or("completed");
            let stop_reason = if status == "incomplete"
                && response
                    .pointer("/incomplete_details/reason")
                    .and_then(Value::as_str)
                    == Some("max_output_tokens")
            {
                StopReasonKind::MaxTokens
            } else if emitted_calls.is_empty() {
                StopReasonKind::EndTurn
            } else {
                StopReasonKind::ToolCalls
            };
            tx.send(Chunk::Done { stop_reason, usage })
                .map_err(|_| "cancelled".to_string())?;
            return Ok(true);
        }
        "response.failed" | "error" => {
            let message = event
                .pointer("/response/error/message")
                .or_else(|| event.pointer("/error/message"))
                .or_else(|| event.get("message"))
                .and_then(Value::as_str)
                .unwrap_or("Responses API stream failed");
            return Err(message.to_string());
        }
        _ => {}
    }
    Ok(false)
}

fn emit_response_item(
    item: &Value,
    tx: &tokio::sync::mpsc::UnboundedSender<Chunk>,
    emitted: &mut HashSet<String>,
) -> Result<(), String> {
    if emitted.insert(item_key(item)) {
        tx.send(Chunk::ResponseItem(item.clone()))
            .map_err(|_| "cancelled".to_string())?;
    }
    Ok(())
}

fn send_delta(
    event: &Value,
    field: &str,
    tx: &tokio::sync::mpsc::UnboundedSender<Chunk>,
    make: fn(String) -> Chunk,
) {
    if let Some(delta) = event
        .get(field)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
    {
        let _ = tx.send(make(delta.to_string()));
    }
}

fn emit_function_call(
    item: &Value,
    tx: &tokio::sync::mpsc::UnboundedSender<Chunk>,
    emitted: &mut HashSet<String>,
) -> Result<(), String> {
    if item.get("type").and_then(Value::as_str) != Some("function_call") {
        return Ok(());
    }
    let key = item_key(item);
    if !emitted.insert(key) {
        return Ok(());
    }
    let id = item
        .get("call_id")
        .or_else(|| item.get("id"))
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| format!("call_{}", uuid::Uuid::new_v4().simple()));
    let name = item
        .get("name")
        .and_then(Value::as_str)
        .filter(|name| !name.is_empty())
        .unwrap_or("unknown_tool")
        .to_string();
    let raw = item
        .get("arguments")
        .and_then(Value::as_str)
        .unwrap_or("{}");
    let arguments = serde_json::from_str::<Value>(raw)
        .ok()
        .filter(Value::is_object)
        .unwrap_or_else(
            || json!({ PARSE_ERROR_KEY: format!("tool call `{name}` has invalid JSON arguments") }),
        );
    tx.send(Chunk::ToolCall(NativeToolCall {
        id,
        name,
        arguments,
    }))
    .map_err(|_| "cancelled".to_string())
}

fn item_key(item: &Value) -> String {
    item.get("id")
        .or_else(|| item.get("call_id"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| item.to_string())
}

fn parse_usage(value: &Value) -> Option<Usage> {
    let prompt_tokens = value
        .get("input_tokens")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let completion_tokens = value
        .get("output_tokens")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let cache_hit_tokens = value
        .pointer("/input_tokens_details/cached_tokens")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    (prompt_tokens != 0 || completion_tokens != 0 || cache_hit_tokens != 0).then_some(Usage {
        prompt_tokens,
        completion_tokens,
        cache_hit_tokens,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::native::provider::{
        ChatToolCall, ChatToolCallFunction, FunctionSpec, ToolSpec,
    };

    #[test]
    fn request_replays_typed_items_and_outputs() {
        let reasoning =
            json!({"type":"reasoning","id":"rs_1","encrypted_content":"opaque","summary":[]});
        let messages = vec![
            ChatMessage::system("system"),
            ChatMessage::user("question"),
            ChatMessage::assistant_tool_calls(vec![ChatToolCall {
                id: "call_1".into(),
                typ: "function".into(),
                function: ChatToolCallFunction { name: "read_file".into(), arguments: "{}".into() },
            }], None).with_response_items(vec![reasoning.clone(), json!({
                "type":"function_call","id":"fc_1","call_id":"call_1","name":"read_file","arguments":"{}"
            })]),
            ChatMessage::tool_result("call_1", "ok"),
        ];
        let (instructions, input) = response_input(&messages);
        assert_eq!(instructions, "system");
        assert!(input.contains(&reasoning));
        assert_eq!(input.last().unwrap()["type"], "function_call_output");
        assert_eq!(input.last().unwrap()["call_id"], "call_1");
    }

    #[test]
    fn body_flattens_function_tools() {
        let provider = ResponsesProvider::new("https://api.openai.com/v1", "key");
        let body = provider.build_body(&ChatRequest {
            model: "gpt-5.4".into(),
            messages: vec![ChatMessage::user("hi")],
            tools: vec![ToolSpec {
                typ: "function".into(),
                function: FunctionSpec {
                    name: "read_file".into(),
                    description: "read".into(),
                    parameters: json!({"type":"object"}),
                },
            }],
            reasoning: ReasoningControl::High,
            max_tokens: Some(1000),
            temperature: None,
        });
        assert_eq!(body["tools"][0]["name"], "read_file");
        assert_eq!(body["reasoning"]["effort"], "high");
        assert_eq!(body["max_output_tokens"], 1000);
        assert_eq!(body["store"], false);
    }

    #[test]
    fn completed_event_emits_items_call_and_usage() {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let mut calls = HashSet::new();
        let mut items = HashSet::new();
        let done = handle_event(&json!({
            "type":"response.completed",
            "response":{"status":"completed","output":[{
                "type":"function_call","id":"fc_1","call_id":"call_1","name":"read_file","arguments":"{}"
            }],"usage":{"input_tokens":10,"output_tokens":2,"input_tokens_details":{"cached_tokens":6}}}
        }), &tx, &mut calls, &mut items).unwrap();
        assert!(done);
        assert!(matches!(rx.try_recv().unwrap(), Chunk::ResponseItem(_)));
        assert!(matches!(rx.try_recv().unwrap(), Chunk::ToolCall(_)));
        match rx.try_recv().unwrap() {
            Chunk::Done { stop_reason, usage } => {
                assert_eq!(stop_reason, StopReasonKind::ToolCalls);
                assert_eq!(usage.unwrap().cache_hit_tokens, 6);
            }
            _ => panic!("expected done"),
        }
    }
}
