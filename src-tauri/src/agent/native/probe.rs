//! Active probing of OpenAI-compatible endpoints for reasoning-effort ladders.
//!
//! Sends tiny non-streaming chat completions with candidate `reasoning_effort`
//! values and classifies accept / reject-param / reject-value responses. Used
//! by Settings when `/models` carries no capability declaration.

use super::capabilities::{
    apply_reasoning_ladder, detect, uses_binary_thinking_toggle, uses_deepseek_thinking_toggle,
};
use super::config::{ModelEntry, ReasoningSource, ReasoningSupport};
use super::provider::openai_endpoint;
use crate::error::NexError;

/// Effort wire values to probe (excludes `off`, which is synthesized).
const CANDIDATE_EFFORTS: &[&str] = &["minimal", "low", "medium", "high", "xhigh", "max"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Outcome {
    Accepted,
    RejectedParam,
    RejectedValue,
    Auth,
    ModelMissing,
    Transient,
}

/// Probe which reasoning effort values a model accepts.
///
/// Makes a small number of cheap `max_tokens: 1` requests. On total parameter
/// rejection, falls back to a binary thinking toggle probe for DeepSeek /
/// MiniMax-style gateways.
pub async fn probe_reasoning_levels(
    base_url: &str,
    api_key: &str,
    model_id: &str,
) -> Result<ModelEntry, NexError> {
    let model_id = model_id.trim();
    if model_id.is_empty() {
        return Err(NexError::Agent("model id is empty".into()));
    }
    let mut entry = detect(model_id);
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .unwrap_or_default();
    let url = openai_endpoint(base_url, "chat/completions");

    // Phase 1: does the endpoint accept `reasoning_effort` at all?
    let probe_high = send_probe(
        &client,
        &url,
        api_key,
        model_id,
        ProbeBody::Effort("high"),
    )
    .await?;

    match probe_high {
        Outcome::Auth => {
            return Err(NexError::Agent(
                "probe failed: unauthorized (check API key)".into(),
            ));
        }
        Outcome::ModelMissing => {
            return Err(NexError::Agent(format!(
                "probe failed: model `{model_id}` not found"
            )));
        }
        Outcome::RejectedParam => {
            // Binary thinking toggle (DeepSeek V4 / MiniMax-M3 style).
            if uses_deepseek_thinking_toggle(model_id) || uses_binary_thinking_toggle(model_id) {
                let on = send_probe(
                    &client,
                    &url,
                    api_key,
                    model_id,
                    ProbeBody::ThinkingEnabled,
                )
                .await?;
                let off = send_probe(
                    &client,
                    &url,
                    api_key,
                    model_id,
                    ProbeBody::ThinkingDisabled,
                )
                .await?;
                if matches!(on, Outcome::Accepted) || matches!(off, Outcome::Accepted) {
                    apply_reasoning_ladder(
                        &mut entry,
                        vec!["off".into(), "high".into()],
                        ReasoningSupport::Yes,
                        ReasoningSource::Probe,
                        false,
                    );
                    return Ok(entry);
                }
            }
            apply_reasoning_ladder(
                &mut entry,
                Vec::new(),
                ReasoningSupport::No,
                ReasoningSource::None,
                false,
            );
            return Ok(entry);
        }
        Outcome::Accepted | Outcome::RejectedValue | Outcome::Transient => {}
    }

    // Phase 2: which discrete effort values are accepted?
    let mut accepted: Vec<String> = Vec::new();
    let mut saw_accept = matches!(probe_high, Outcome::Accepted);
    if saw_accept {
        accepted.push("high".into());
    }

    for effort in CANDIDATE_EFFORTS {
        if *effort == "high" {
            continue;
        }
        match send_probe(&client, &url, api_key, model_id, ProbeBody::Effort(effort)).await? {
            Outcome::Accepted => {
                saw_accept = true;
                accepted.push((*effort).into());
            }
            Outcome::RejectedParam => {
                // Endpoint flipped to rejecting the parameter entirely mid-probe.
                apply_reasoning_ladder(
                    &mut entry,
                    Vec::new(),
                    ReasoningSupport::No,
                    ReasoningSource::None,
                    false,
                );
                return Ok(entry);
            }
            Outcome::Auth => {
                return Err(NexError::Agent(
                    "probe failed: unauthorized (check API key)".into(),
                ));
            }
            Outcome::ModelMissing => {
                return Err(NexError::Agent(format!(
                    "probe failed: model `{model_id}` not found"
                )));
            }
            Outcome::RejectedValue | Outcome::Transient => {}
        }
    }

    if !saw_accept {
        // Ambiguous: keep heuristic ladder if any, mark unknown.
        if entry.reasoning_levels.is_empty() {
            apply_reasoning_ladder(
                &mut entry,
                Vec::new(),
                ReasoningSupport::Unknown,
                ReasoningSource::None,
                false,
            );
        }
        return Ok(entry);
    }

    if !accepted.iter().any(|l| l == "off") {
        accepted.insert(0, "off".into());
    }
    apply_reasoning_ladder(
        &mut entry,
        accepted,
        ReasoningSupport::Yes,
        ReasoningSource::Probe,
        false,
    );
    Ok(entry)
}

enum ProbeBody {
    Effort(&'static str),
    ThinkingEnabled,
    ThinkingDisabled,
}

async fn send_probe(
    client: &reqwest::Client,
    url: &str,
    api_key: &str,
    model_id: &str,
    body_kind: ProbeBody,
) -> Result<Outcome, NexError> {
    let mut body = serde_json::json!({
        "model": model_id,
        "messages": [{"role": "user", "content": "ping"}],
        "max_tokens": 1,
        "stream": false,
    });
    match body_kind {
        ProbeBody::Effort(effort) => {
            if uses_deepseek_thinking_toggle(model_id) {
                body["thinking"] = serde_json::json!({ "type": "enabled" });
            }
            body["reasoning_effort"] = serde_json::json!(effort);
        }
        ProbeBody::ThinkingEnabled => {
            body["thinking"] = serde_json::json!({ "type": "enabled" });
        }
        ProbeBody::ThinkingDisabled => {
            body["thinking"] = serde_json::json!({ "type": "disabled" });
        }
    }

    let effort = match body_kind {
        ProbeBody::Effort(e) => Some(e),
        _ => None,
    };

    let resp = client
        .post(url)
        .bearer_auth(api_key)
        .header("Content-Type", "application/json")
        .body(serde_json::to_vec(&body).unwrap_or_default())
        .send()
        .await
        .map_err(|e| NexError::Agent(format!("probe request failed: {e}")))?;

    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    Ok(classify(status, &text, effort))
}

fn classify(status: reqwest::StatusCode, body: &str, effort: Option<&str>) -> Outcome {
    if status.is_success() {
        return Outcome::Accepted;
    }
    let lower = body.to_ascii_lowercase();
    let code = status.as_u16();
    if code == 401 || code == 403 {
        return Outcome::Auth;
    }
    if lower.contains("model")
        && (lower.contains("not found")
            || lower.contains("does not exist")
            || lower.contains("invalid model")
            || lower.contains("unknown model"))
    {
        return Outcome::ModelMissing;
    }
    if lower.contains("reasoning_effort")
        && (lower.contains("unknown")
            || lower.contains("unexpected")
            || lower.contains("not support")
            || lower.contains("unsupported")
            || lower.contains("unrecognized")
            || lower.contains("extra")
            || lower.contains("additional propert"))
    {
        return Outcome::RejectedParam;
    }
    if let Some(e) = effort {
        let e = e.to_ascii_lowercase();
        if lower.contains(&e)
            && (lower.contains("invalid")
                || lower.contains("not support")
                || lower.contains("unsupported")
                || lower.contains("must be")
                || lower.contains("enum")
                || lower.contains("one of")
                || lower.contains("allowed"))
        {
            return Outcome::RejectedValue;
        }
    }
    if status.is_server_error() || code == 429 {
        return Outcome::Transient;
    }
    if status.is_client_error() {
        // Conservative: treat other 4xx with an effort as "value not accepted".
        if effort.is_some() {
            return Outcome::RejectedValue;
        }
        return Outcome::RejectedParam;
    }
    Outcome::Transient
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_unknown_param() {
        let o = classify(
            reqwest::StatusCode::BAD_REQUEST,
            r#"{"error":{"message":"unknown parameter: reasoning_effort"}}"#,
            Some("high"),
        );
        assert_eq!(o, Outcome::RejectedParam);
    }

    #[test]
    fn classify_invalid_effort_value() {
        let o = classify(
            reqwest::StatusCode::BAD_REQUEST,
            r#"{"error":{"message":"invalid reasoning_effort 'xhigh'; must be one of low,high,max"}}"#,
            Some("xhigh"),
        );
        assert_eq!(o, Outcome::RejectedValue);
    }

    #[test]
    fn classify_success() {
        assert_eq!(
            classify(reqwest::StatusCode::OK, "{}", Some("high")),
            Outcome::Accepted
        );
    }
}
