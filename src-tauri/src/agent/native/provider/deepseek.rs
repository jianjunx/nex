//! OpenAI-compatible streaming provider (DeepSeek and other `/v1` gateways).
//!
//! Posts to `{base_url}/v1/chat/completions` (injecting `/v1` when the stored
//! base has no version segment) with `stream: true` and parses the SSE by hand:
//! bytes are drained via `Response::chunk()`, buffered, split on `\n`, and each
//! `data:` payload is decoded. Tool-call deltas arrive split by `index`; we
//! accumulate them here and only emit a [`Chunk::ToolCall`] once the arguments
//! are complete. `429`/`5xx` responses retry with bounded exponential backoff
//! before streaming begins.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde::Deserialize;

use super::{
    ChatRequest, Chunk, ChunkStream, NativeToolCall, Provider, ReasoningControl, StopReasonKind,
    Usage, PARSE_ERROR_KEY,
};
use crate::error::NexError;

/// Max retry attempts for retriable HTTP failures (429 / 5xx).
const MAX_RETRIES: u32 = 3;
/// Base backoff between retries; doubled each attempt.
const RETRY_BASE_MS: u64 = 500;

pub struct DeepSeekProvider {
    base_url: String,
    api_key: String,
    client: reqwest::Client,
    /// Set when the endpoint rejected `reasoning_effort` and we stripped it.
    /// The agent persists this as `reasoningSupport: "no"` for the model.
    reasoning_downgraded: Arc<AtomicBool>,
}

impl DeepSeekProvider {
    pub fn new(base_url: impl Into<String>, api_key: impl Into<String>) -> Self {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(300))
            .build()
            .unwrap_or_default();
        Self {
            base_url: base_url.into(),
            api_key: api_key.into(),
            client,
            reasoning_downgraded: Arc::new(AtomicBool::new(false)),
        }
    }

    /// Whether `reasoning_effort` was rejected at runtime and stripped.
    pub fn reasoning_downgraded(&self) -> bool {
        self.reasoning_downgraded.load(Ordering::Relaxed)
    }

    fn url(&self) -> String {
        super::openai_endpoint(&self.base_url, "chat/completions")
    }

    fn build_body(&self, req: &ChatRequest) -> serde_json::Value {
        let mut body = serde_json::json!({
            "model": req.model,
            "messages": req.messages,
            "stream": true,
            "stream_options": { "include_usage": true },
        });
        if !req.tools.is_empty() {
            body["tools"] = serde_json::to_value(&req.tools).unwrap_or_default();
        }
        if let Some(t) = req.temperature {
            body["temperature"] = serde_json::json!(t);
        }
        if let Some(mt) = req.max_tokens {
            body["max_tokens"] = serde_json::json!(mt);
        }
        Self::apply_reasoning(&mut body, &req.model, req.reasoning);
        body
    }

    /// Attach family-specific thinking / effort fields.
    ///
    /// DeepSeek V4 defaults thinking **on**, so Off must send
    /// `thinking: {type: disabled}`. MiniMax-M3 gateways typically take a
    /// binary thinking toggle rather than multi-tier `reasoning_effort`.
    fn apply_reasoning(body: &mut serde_json::Value, model: &str, reasoning: ReasoningControl) {
        use crate::agent::native::capabilities::{
            uses_binary_thinking_toggle, uses_deepseek_thinking_toggle,
        };
        if uses_binary_thinking_toggle(model) {
            body["thinking"] = serde_json::json!({
                "type": if reasoning == ReasoningControl::Off { "disabled" } else { "enabled" }
            });
            return;
        }
        if uses_deepseek_thinking_toggle(model) {
            if reasoning == ReasoningControl::Off {
                body["thinking"] = serde_json::json!({ "type": "disabled" });
            } else {
                body["thinking"] = serde_json::json!({ "type": "enabled" });
                body["reasoning_effort"] = serde_json::json!(reasoning.as_str());
            }
            return;
        }
        if reasoning != ReasoningControl::Off {
            body["reasoning_effort"] = serde_json::json!(reasoning.as_str());
        }
    }

    async fn send_with_retry(
        &self,
        body: &serde_json::Value,
    ) -> Result<reqwest::Response, NexError> {
        let mut body = body.clone();
        let mut attempt = 0u32;
        loop {
            let resp = self
                .client
                .post(self.url())
                .bearer_auth(&self.api_key)
                .header("Accept", "text/event-stream")
                .header("Content-Type", "application/json")
                .body(serde_json::to_vec(&body).unwrap_or_default())
                .send()
                .await
                .map_err(|e| {
                    log::error!(
                        target: crate::agent::native::diag::TARGET,
                        "http request failed endpoint={} {e}",
                        self.url()
                    );
                    NexError::Agent(format!("model request failed: {e}"))
                })?;

            let status = resp.status();
            if status.is_success() {
                if attempt > 0 {
                    log::info!(
                        target: crate::agent::native::diag::TARGET,
                        "http {status} after retry attempt={attempt} endpoint={}",
                        self.url()
                    );
                }
                return Ok(resp);
            }
            // Drain a short error body for the message.
            let err_text = resp.text().await.unwrap_or_default();
            // Runtime reasoning-support detection: some models reject the
            // `reasoning_effort` parameter outright. Strip it, remember the
            // downgrade, and retry once without backoff.
            if body.get("reasoning_effort").is_some()
                && err_text.to_ascii_lowercase().contains("reasoning_effort")
            {
                body.as_object_mut().map(|o| o.remove("reasoning_effort"));
                self.reasoning_downgraded.store(true, Ordering::Relaxed);
                log::warn!(
                    target: crate::agent::native::diag::TARGET,
                    "endpoint rejected reasoning_effort; retrying without it"
                );
                continue;
            }
            let retriable = status.as_u16() == 429 || status.is_server_error();
            if retriable && attempt < MAX_RETRIES {
                let backoff = RETRY_BASE_MS * 2u64.pow(attempt);
                log::warn!(
                    target: crate::agent::native::diag::TARGET,
                    "http {status} retrying in {backoff}ms ({}/{MAX_RETRIES}) endpoint={}",
                    attempt + 1,
                    self.url()
                );
                tokio::time::sleep(std::time::Duration::from_millis(backoff)).await;
                attempt += 1;
                continue;
            }
            log::error!(
                target: crate::agent::native::diag::TARGET,
                "http {status} endpoint={} body={}",
                self.url(),
                crate::agent::native::diag::preview(&err_text, 200)
            );
            return Err(NexError::Agent(super::format_model_http_error(
                status, &err_text,
            )));
        }
    }
}

#[async_trait::async_trait]
impl Provider for DeepSeekProvider {
    fn name(&self) -> &str {
        "deepseek"
    }

    fn reserved_response_hint(&self, model_id: &str) -> Option<u64> {
        // DeepSeek caps `max_tokens` at 8k by default; reasoning models
        // hit that ceiling with hidden chain-of-thought, so reserve more
        // headroom up front rather than discovering it mid-stream.
        let lower = model_id.to_ascii_lowercase();
        if lower.contains("reason") || lower.contains("thinking") {
            Some(8192)
        } else {
            Some(4096)
        }
    }

    async fn stream(&self, req: ChatRequest) -> Result<ChunkStream, NexError> {
        log::info!(
            target: crate::agent::native::diag::TARGET,
            "http POST {} model={} msgs={} tools={}",
            self.url(),
            req.model,
            req.messages.len(),
            req.tools.len()
        );
        let body = self.build_body(&req);
        let resp = self.send_with_retry(&body).await?;

        let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<Chunk>();
        // Drive the SSE parse on a background task so the harness can consume
        // chunks through the receiver without blocking on IO here.
        tokio::spawn(async move {
            if let Err(e) = pump_sse(resp, tx.clone()).await {
                let _ = tx.send(Chunk::Error(e));
            }
        });
        Ok(rx)
    }
}

/// Reads the SSE response to completion, emitting chunks on `tx`.
async fn pump_sse(
    mut resp: reqwest::Response,
    tx: tokio::sync::mpsc::UnboundedSender<Chunk>,
) -> Result<(), String> {
    let mut buffer = String::new();
    let mut acc = ToolAccumulator::default();
    let mut finish: Option<StopReasonKind> = None;
    let mut usage: Option<Usage> = None;

    loop {
        let chunk = resp
            .chunk()
            .await
            .map_err(|e| format!("model stream error: {e}"))?;
        let Some(bytes) = chunk else { break };
        buffer.push_str(&String::from_utf8_lossy(&bytes));

        // Process all complete lines; keep the trailing partial line buffered.
        while let Some(newline) = buffer.find('\n') {
            let line: String = buffer.drain(..=newline).collect();
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            let Some(data) = line.strip_prefix("data:") else {
                continue;
            };
            let data = data.trim();
            if data == "[DONE]" {
                continue;
            }
            match serde_json::from_str::<SseEvent>(data) {
                Ok(event) => {
                    if let Some(raw) = event.usage {
                        if let Some(parsed) = parse_usage_value(&raw) {
                            usage = Some(match usage {
                                Some(prev) => Usage {
                                    prompt_tokens: parsed.prompt_tokens.max(prev.prompt_tokens),
                                    completion_tokens: parsed
                                        .completion_tokens
                                        .max(prev.completion_tokens),
                                    cache_hit_tokens: parsed
                                        .cache_hit_tokens
                                        .max(prev.cache_hit_tokens),
                                },
                                None => parsed,
                            });
                        }
                    }
                    if let Some(choice) = event.choices.and_then(|c| c.into_iter().next()) {
                        let delta = choice.delta.unwrap_or_default();
                        if let Some(text) = delta.content {
                            if !text.is_empty() && tx.send(Chunk::Text(text)).is_err() {
                                return Ok(());
                            }
                        }
                        if let Some(think) = delta.reasoning_content {
                            if !think.is_empty() && tx.send(Chunk::Thinking(think)).is_err() {
                                return Ok(());
                            }
                        }
                        if let Some(calls) = delta.tool_calls {
                            acc.absorb(calls);
                        }
                        if let Some(reason) = choice.finish_reason {
                            finish = Some(match reason.as_str() {
                                "tool_calls" => StopReasonKind::ToolCalls,
                                "length" => StopReasonKind::MaxTokens,
                                _ => StopReasonKind::EndTurn,
                            });
                        }
                    }
                }
                Err(e) => {
                    log::warn!("model stream: skipping malformed SSE payload: {e}");
                }
            }
        }
    }

    // Stream ended: flush accumulated tool calls. Malformed calls become
    // ERROR results instead of aborting the whole turn, so sibling calls
    // and already-streamed text still reach the transcript.
    let calls = acc.drain();
    let had_calls = !calls.is_empty();
    for call in calls {
        if tx.send(Chunk::ToolCall(call)).is_err() {
            return Ok(());
        }
    }
    let stop_reason = finish.unwrap_or(if !had_calls {
        StopReasonKind::EndTurn
    } else {
        StopReasonKind::ToolCalls
    });
    let _ = tx.send(Chunk::Done { stop_reason, usage });
    Ok(())
}

/// Accumulates split tool-call deltas keyed by their stream `index`.
#[derive(Default)]
struct ToolAccumulator {
    calls: HashMap<u32, PartialCall>,
}

#[derive(Default)]
struct PartialCall {
    id: Option<String>,
    name: Option<String>,
    arguments: String,
}

impl ToolAccumulator {
    fn absorb(&mut self, deltas: Vec<SseToolCallDelta>) {
        for d in deltas {
            let entry = self.calls.entry(d.index).or_default();
            if let Some(id) = d.id {
                entry.id = Some(id);
            }
            if let Some(f) = d.function {
                if let Some(name) = f.name {
                    if !name.is_empty() {
                        entry.name = Some(name);
                    }
                }
                entry.arguments.push_str(&f.arguments);
            }
        }
    }

    fn drain(&mut self) -> Vec<NativeToolCall> {
        let mut out: Vec<(u32, PartialCall)> = self.calls.drain().collect();
        out.sort_by_key(|(idx, _)| *idx);
        // Gateways reject empty / duplicate `tool_call_id` values (400). Some
        // models emit `id: ""` or reuse the same id for parallel calls; treat
        // blank as missing and uniquify within this round.
        let mut used = std::collections::HashSet::new();
        out.into_iter()
            .map(|(index, p)| {
                let mut id =
                    p.id.filter(|s| !s.trim().is_empty())
                        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
                if !used.insert(id.clone()) {
                    id = uuid::Uuid::new_v4().to_string();
                    used.insert(id.clone());
                }
                let name = p
                    .name
                    .clone()
                    .filter(|s| !s.trim().is_empty())
                    .unwrap_or_else(|| "unknown_tool".to_string());
                let arguments = match parse_tool_arguments(index, &name, &p.arguments, &p.name) {
                    Ok(args) => args,
                    Err(err) => serde_json::json!({ PARSE_ERROR_KEY: err }),
                };
                NativeToolCall {
                    id,
                    name,
                    arguments,
                }
            })
            .collect()
    }
}

fn parse_tool_arguments(
    index: u32,
    name: &str,
    raw: &str,
    original_name: &Option<String>,
) -> Result<serde_json::Value, String> {
    if original_name
        .as_ref()
        .map(|s| s.trim().is_empty())
        .unwrap_or(true)
    {
        return Err(format!("tool call {index} has no function name"));
    }
    let args = if raw.trim().is_empty() {
        serde_json::json!({})
    } else {
        serde_json::from_str(raw)
            .map_err(|e| format!("tool call `{name}` has invalid JSON arguments: {e}"))?
    };
    if !args.is_object() {
        return Err(format!(
            "tool call `{name}` arguments must be a JSON object"
        ));
    }
    Ok(args)
}

// --- SSE wire types (only the fields we read) ---

#[derive(Deserialize)]
struct SseEvent {
    choices: Option<Vec<SseChoice>>,
    usage: Option<serde_json::Value>,
}

#[derive(Deserialize)]
struct SseChoice {
    delta: Option<SseDelta>,
    finish_reason: Option<String>,
}

#[derive(Default, Deserialize)]
struct SseDelta {
    content: Option<String>,
    reasoning_content: Option<String>,
    tool_calls: Option<Vec<SseToolCallDelta>>,
}

#[derive(Deserialize)]
struct SseToolCallDelta {
    index: u32,
    id: Option<String>,
    function: Option<SseFunctionDelta>,
}

#[derive(Deserialize)]
struct SseFunctionDelta {
    name: Option<String>,
    #[serde(default)]
    arguments: String,
}

fn json_u64(v: &serde_json::Value) -> u64 {
    match v {
        serde_json::Value::Number(n) => n
            .as_u64()
            .or_else(|| n.as_f64().map(|f| f.max(0.0) as u64))
            .unwrap_or(0),
        serde_json::Value::String(s) => s
            .parse::<f64>()
            .ok()
            .map(|f| f.max(0.0) as u64)
            .unwrap_or(0),
        _ => 0,
    }
}

/// Pull prompt / completion / cache-hit counts from a provider `usage` object.
///
/// Gateways disagree on field names:
/// - DeepSeek: `prompt_cache_hit_tokens`
/// - OpenAI / OpenRouter: `prompt_tokens_details.cached_tokens`
/// - Anthropic-compat: `cache_read_input_tokens` / `input_tokens`
///
/// Empty objects (some streams attach `"usage": {}` on every chunk) return
/// `None` so they do not wipe a previously parsed usage.
fn parse_usage_value(u: &serde_json::Value) -> Option<Usage> {
    if !u.is_object() {
        return None;
    }
    let prompt = json_u64(&u["prompt_tokens"]).max(json_u64(&u["input_tokens"]));
    let completion = json_u64(&u["completion_tokens"]).max(json_u64(&u["output_tokens"]));
    let cache = [
        json_u64(&u["prompt_cache_hit_tokens"]),
        json_u64(&u["cached_tokens"]),
        json_u64(&u["cache_read_input_tokens"]),
        json_u64(&u["cache_read_tokens"]),
        json_u64(&u["prompt_tokens_details"]["cached_tokens"]),
        json_u64(&u["input_tokens_details"]["cache_read"]),
        json_u64(&u["input_tokens_details"]["cached_tokens"]),
    ]
    .into_iter()
    .max()
    .unwrap_or(0);
    if prompt == 0 && completion == 0 && cache == 0 {
        return None;
    }
    Some(Usage {
        prompt_tokens: prompt,
        completion_tokens: completion,
        cache_hit_tokens: cache,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::native::provider::Provider;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[test]
    fn reserved_response_hint_picks_reasoning_budget() {
        let p = DeepSeekProvider::new("https://api.deepseek.com/v1", "k");
        assert_eq!(p.reserved_response_hint("deepseek-chat"), Some(4096));
        assert_eq!(p.reserved_response_hint("deepseek-reasoner"), Some(8192));
        assert_eq!(p.reserved_response_hint("kimi-thinking"), Some(8192));
    }

    #[test]
    fn parse_usage_reads_deepseek_cache_hit() {
        let u = serde_json::json!({
            "prompt_tokens": 100,
            "completion_tokens": 10,
            "prompt_cache_hit_tokens": 80
        });
        let parsed = parse_usage_value(&u).expect("usage");
        assert_eq!(parsed.prompt_tokens, 100);
        assert_eq!(parsed.completion_tokens, 10);
        assert_eq!(parsed.cache_hit_tokens, 80);
    }

    #[test]
    fn parse_usage_reads_openai_cached_tokens() {
        let u = serde_json::json!({
            "prompt_tokens": 200,
            "completion_tokens": 5,
            "prompt_tokens_details": { "cached_tokens": 150 }
        });
        let parsed = parse_usage_value(&u).expect("usage");
        assert_eq!(parsed.prompt_tokens, 200);
        assert_eq!(parsed.cache_hit_tokens, 150);
    }

    #[test]
    fn parse_usage_reads_anthropic_compat_fields() {
        let u = serde_json::json!({
            "input_tokens": 40,
            "output_tokens": 6,
            "cache_read_input_tokens": 32
        });
        let parsed = parse_usage_value(&u).expect("usage");
        assert_eq!(parsed.prompt_tokens, 40);
        assert_eq!(parsed.completion_tokens, 6);
        assert_eq!(parsed.cache_hit_tokens, 32);
    }

    #[test]
    fn parse_usage_ignores_empty_object() {
        assert!(parse_usage_value(&serde_json::json!({})).is_none());
        assert!(parse_usage_value(&serde_json::json!(null)).is_none());
    }

    #[test]
    fn parse_usage_accepts_float_counts() {
        let u = serde_json::json!({ "prompt_tokens": 12.0, "cached_tokens": 8.0 });
        let parsed = parse_usage_value(&u).expect("usage");
        assert_eq!(parsed.prompt_tokens, 12);
        assert_eq!(parsed.cache_hit_tokens, 8);
    }

    #[tokio::test]
    async fn accumulator_merges_split_deltas() {
        let mut acc = ToolAccumulator::default();
        acc.absorb(vec![SseToolCallDelta {
            index: 0,
            id: Some("call_1".into()),
            function: Some(SseFunctionDelta {
                name: Some("read_file".into()),
                arguments: "".into(),
            }),
        }]);
        acc.absorb(vec![SseToolCallDelta {
            index: 0,
            id: None,
            function: Some(SseFunctionDelta {
                name: None,
                arguments: "{\"path\":".into(),
            }),
        }]);
        acc.absorb(vec![SseToolCallDelta {
            index: 0,
            id: None,
            function: Some(SseFunctionDelta {
                name: None,
                arguments: "\"a.rs\"}".into(),
            }),
        }]);
        let calls = acc.drain();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].name, "read_file");
        assert_eq!(calls[0].id, "call_1");
        assert_eq!(calls[0].arguments["path"], "a.rs");
    }

    #[test]
    fn accumulator_replaces_empty_and_duplicate_ids() {
        let mut acc = ToolAccumulator::default();
        acc.absorb(vec![
            SseToolCallDelta {
                index: 0,
                id: Some("".into()),
                function: Some(SseFunctionDelta {
                    name: Some("read_file".into()),
                    arguments: "{}".into(),
                }),
            },
            SseToolCallDelta {
                index: 1,
                id: Some("same".into()),
                function: Some(SseFunctionDelta {
                    name: Some("ls".into()),
                    arguments: "{}".into(),
                }),
            },
            SseToolCallDelta {
                index: 2,
                id: Some("same".into()),
                function: Some(SseFunctionDelta {
                    name: Some("grep".into()),
                    arguments: "{}".into(),
                }),
            },
        ]);
        let calls = acc.drain();
        assert_eq!(calls.len(), 3);
        assert!(!calls[0].id.trim().is_empty());
        assert_eq!(calls[1].id, "same");
        assert_ne!(calls[2].id, "same");
        assert_ne!(calls[0].id, calls[1].id);
        assert_ne!(calls[0].id, calls[2].id);
        assert_ne!(calls[1].id, calls[2].id);
    }

    #[test]
    fn accumulator_rejects_invalid_tool_argument_json() {
        let mut acc = ToolAccumulator::default();
        acc.absorb(vec![SseToolCallDelta {
            index: 0,
            id: Some("call_bad".into()),
            function: Some(SseFunctionDelta {
                name: Some("write_file".into()),
                arguments: r#"{"path":"a.txt""#.into(),
            }),
        }]);
        let calls = acc.drain();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].name, "write_file");
        let err = calls[0].arguments[PARSE_ERROR_KEY].as_str().unwrap();
        assert!(err.contains("write_file"));
        assert!(err.contains("invalid JSON"));
    }

    #[test]
    fn accumulator_keeps_valid_calls_when_sibling_is_malformed() {
        let mut acc = ToolAccumulator::default();
        acc.absorb(vec![
            SseToolCallDelta {
                index: 0,
                id: Some("good".into()),
                function: Some(SseFunctionDelta {
                    name: Some("read_file".into()),
                    arguments: r#"{"path":"a.rs"}"#.into(),
                }),
            },
            SseToolCallDelta {
                index: 1,
                id: Some("bad".into()),
                function: Some(SseFunctionDelta {
                    name: Some("write_file".into()),
                    arguments: r#"{"path":"a.txt""#.into(),
                }),
            },
        ]);
        let calls = acc.drain();
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0].name, "read_file");
        assert!(calls[0].arguments.get(PARSE_ERROR_KEY).is_none());
        assert!(calls[1].arguments.get(PARSE_ERROR_KEY).is_some());
    }

    #[test]
    fn reasoning_parse() {
        assert_eq!(ReasoningControl::parse("high"), ReasoningControl::High);
        assert_eq!(ReasoningControl::parse("max"), ReasoningControl::Max);
        assert_eq!(ReasoningControl::parse("xhigh"), ReasoningControl::XHigh);
        assert_eq!(ReasoningControl::parse("bogus"), ReasoningControl::Off);
        assert_eq!(ReasoningControl::High.as_str(), "high");
        assert_eq!(ReasoningControl::Max.as_str(), "max");
        assert_eq!(ReasoningControl::Off.as_str(), "off");
    }

    #[test]
    fn deepseek_v4_off_sends_thinking_disabled() {
        let p = DeepSeekProvider::new("https://api.deepseek.com", "k");
        let body = p.build_body(&ChatRequest {
            model: "deepseek-v4-flash".into(),
            messages: vec![],
            tools: vec![],
            reasoning: ReasoningControl::Off,
            max_tokens: None,
            temperature: None,
        });
        assert_eq!(body["thinking"]["type"], "disabled");
        assert!(body.get("reasoning_effort").is_none());
    }

    #[test]
    fn deepseek_v4_max_sends_effort_and_thinking() {
        let p = DeepSeekProvider::new("https://api.deepseek.com", "k");
        let body = p.build_body(&ChatRequest {
            model: "deepseek-v4-pro".into(),
            messages: vec![],
            tools: vec![],
            reasoning: ReasoningControl::Max,
            max_tokens: None,
            temperature: None,
        });
        assert_eq!(body["thinking"]["type"], "enabled");
        assert_eq!(body["reasoning_effort"], "max");
    }

    #[test]
    fn minimax_m3_uses_binary_thinking() {
        let p = DeepSeekProvider::new("https://gateway.example/v1", "k");
        let off = p.build_body(&ChatRequest {
            model: "MiniMax-M3".into(),
            messages: vec![],
            tools: vec![],
            reasoning: ReasoningControl::Off,
            max_tokens: None,
            temperature: None,
        });
        assert_eq!(off["thinking"]["type"], "disabled");
        assert!(off.get("reasoning_effort").is_none());
        let on = p.build_body(&ChatRequest {
            model: "MiniMax-M3".into(),
            messages: vec![],
            tools: vec![],
            reasoning: ReasoningControl::High,
            max_tokens: None,
            temperature: None,
        });
        assert_eq!(on["thinking"]["type"], "enabled");
    }

    #[test]
    fn url_strips_trailing_slash_and_injects_v1() {
        let p = DeepSeekProvider::new("https://api.deepseek.com/", "k");
        assert_eq!(p.url(), "https://api.deepseek.com/v1/chat/completions");
        let p2 = DeepSeekProvider::new("https://api.openai.com/v1", "k");
        assert_eq!(p2.url(), "https://api.openai.com/v1/chat/completions");
    }

    /// Runtime reasoning-support detection: a 4xx whose body names
    /// `reasoning_effort` strips the parameter, flags the downgrade, and
    /// retries successfully without it.
    #[tokio::test]
    async fn reasoning_effort_rejection_downgrades_and_retries() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut s1, _) = listener.accept().await.unwrap();
            let mut served = 0u32;
            // The retry may reuse the same keep-alive connection; serve up to
            // two requests on it, falling back to a fresh accept when idle.
            while served < 2 {
                let mut buf = [0u8; 8192];
                let n = tokio::time::timeout(std::time::Duration::from_secs(5), s1.read(&mut buf))
                    .await
                    .ok()
                    .and_then(|r| r.ok())
                    .filter(|n| *n > 0);
                if n.is_none() {
                    break;
                }
                served += 1;
                if served == 1 {
                    // Reject `reasoning_effort` explicitly.
                    let err_body =
                        br#"{"error":{"message":"unknown parameter: reasoning_effort"}}"#;
                    let header = format!(
                        "HTTP/1.1 400 Bad Request\r\nContent-Length: {}\r\n\r\n",
                        err_body.len()
                    );
                    s1.write_all(header.as_bytes()).await.unwrap();
                    s1.write_all(err_body).await.unwrap();
                } else {
                    s1.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok")
                        .await
                        .unwrap();
                }
            }
            if served < 2 {
                let (mut s2, _) = listener.accept().await.unwrap();
                let mut buf = [0u8; 8192];
                let _ = s2.read(&mut buf).await;
                s2.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok")
                    .await
                    .unwrap();
            }
        });

        let p = DeepSeekProvider::new(format!("http://{addr}"), "k");
        let body = serde_json::json!({ "model": "m", "reasoning_effort": "medium" });
        let resp = p.send_with_retry(&body).await.expect("retry succeeds");
        assert_eq!(resp.status().as_u16(), 200);
        assert!(p.reasoning_downgraded(), "downgrade must be recorded");
        server.await.unwrap();
    }

    /// Models that never get `reasoning_effort` in the body must not trip the
    /// downgrade path; a plain 400 stays an error.
    #[tokio::test]
    async fn plain_400_without_reasoning_mention_stays_error() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut s1, _) = listener.accept().await.unwrap();
            let mut buf1 = [0u8; 4096];
            let _ = s1.read(&mut buf1).await.unwrap();
            let err_body = br#"{"error":{"message":"bad api key"}}"#;
            let header = format!(
                "HTTP/1.1 400 Bad Request\r\nContent-Length: {}\r\n\r\n",
                err_body.len()
            );
            s1.write_all(header.as_bytes()).await.unwrap();
            s1.write_all(err_body).await.unwrap();
        });

        let p = DeepSeekProvider::new(format!("http://{addr}"), "k");
        let body = serde_json::json!({ "model": "m", "reasoning_effort": "medium" });
        let err = p.send_with_retry(&body).await.expect_err("must fail");
        assert!(err.to_string().contains("400"));
        assert!(!p.reasoning_downgraded());
        server.await.unwrap();
    }
}
