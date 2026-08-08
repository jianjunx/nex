//! Heuristic model-capability detection for OpenAI-compatible endpoints.
//!
//! Used when the user adds or fetches models in Settings. Runtime rejection of
//! `reasoning_effort` still wins and is persisted separately as
//! [`super::config::ReasoningSupport::No`].

use super::config::{ModelCapabilities, ModelEntry, ReasoningSupport};

/// Infers capabilities + reasoning levels + context window from a model id.
pub fn detect(model_id: &str) -> ModelEntry {
    detect_with_window(model_id, None)
}

/// Like [`detect`], but prefers an API-reported context window when present.
pub fn detect_with_window(model_id: &str, api_context_window: Option<u32>) -> ModelEntry {
    let id = model_id.trim();
    let lower = id.to_ascii_lowercase();
    let reasoning = looks_like_reasoning(&lower);
    let vision = looks_like_vision(&lower);
    let levels = if reasoning {
        reasoning_levels_for(&lower)
    } else {
        Vec::new()
    };
    let context_window = api_context_window
        .filter(|&w| w > 0)
        .or_else(|| heuristic_context_window(&lower));
    ModelEntry {
        id: id.to_string(),
        reasoning_support: if reasoning {
            ReasoningSupport::Yes
        } else {
            ReasoningSupport::Unknown
        },
        capabilities: ModelCapabilities {
            tools: true,
            vision,
            reasoning,
        },
        reasoning_levels: levels,
        context_window,
    }
}

/// Re-runs detection while preserving the wire `id`, runtime reasoning-no, and
/// any user-/API-set context window.
pub fn refresh(entry: &ModelEntry) -> ModelEntry {
    let mut next = detect_with_window(&entry.id, entry.context_window);
    // Runtime "no" always wins over heuristics.
    if entry.reasoning_support == ReasoningSupport::No {
        next.reasoning_support = ReasoningSupport::No;
        next.capabilities.reasoning = false;
        next.reasoning_levels.clear();
    }
    // Keep an explicit context window (including cleared-via-Some if we ever
    // need that); only fill when the stored value is absent.
    if entry.context_window.is_some() {
        next.context_window = entry.context_window;
    }
    next
}

fn looks_like_reasoning(id: &str) -> bool {
    id.contains("reason")
        || id.contains("r1")
        || id.contains("thinking")
        || id.contains("o1")
        || id.contains("o3")
        || id.contains("o4")
        || id.contains("gpt-5")
        || id.contains("gpt5")
        || id.contains("claude-4")
        || id.contains("claude-opus-4")
        || id.contains("claude-sonnet-4")
        || id.contains("gemini-2.5")
        || id.contains("gemini-3")
        || id.contains("kimi-k2")
        || id.contains("kimi-k3")
        || id.contains("qwq")
        || id.contains("qwen3")
        || id.contains("deepseek-r")
}

fn looks_like_vision(id: &str) -> bool {
    id.contains("vision")
        || id.contains("vl")
        || id.contains("gpt-4o")
        || id.contains("gpt-4.1")
        || id.contains("gpt-5")
        || id.contains("claude-3")
        || id.contains("claude-4")
        || id.contains("claude-sonnet")
        || id.contains("claude-opus")
        || id.contains("gemini")
        || id.contains("pixtral")
        || id.contains("minimax-m")
}

/// Best-effort context window (tokens) from well-known model id patterns.
/// Returns `None` when unknown — caller leaves the field unset (no limit).
fn heuristic_context_window(id: &str) -> Option<u32> {
    // Explicit size suffixes in the id (e.g. `…-256k`, `…-1m`).
    if let Some(w) = parse_size_suffix(id) {
        return Some(w);
    }
    if id.contains("kimi-k3") || id.contains("kimi/k3") {
        return Some(1_000_000);
    }
    if id.contains("kimi") {
        return Some(262_144); // ~256K marketed; providers often expose ~289–295K
    }
    if id.contains("minimax") {
        if id.contains("m3") || id.contains("m2.5") {
            return Some(645_000); // ~631K class
        }
        return Some(327_680); // ~320K class
    }
    if id.contains("gemini-2.5") || id.contains("gemini-3") || id.contains("gemini-1.5") {
        return Some(1_048_576);
    }
    if id.contains("gemini") {
        return Some(1_048_576);
    }
    if id.contains("claude") {
        return Some(200_000);
    }
    if id.contains("gpt-4.1") || id.contains("gpt-4.5") {
        return Some(1_047_576);
    }
    if id.contains("gpt-4o") || id.contains("gpt-4-turbo") || id.contains("gpt-5") {
        return Some(128_000);
    }
    if id.contains("o1") || id.contains("o3") || id.contains("o4") {
        return Some(200_000);
    }
    if id.contains("deepseek") {
        return Some(128_000);
    }
    if id.contains("qwen") || id.contains("qwq") {
        return Some(131_072);
    }
    None
}

fn parse_size_suffix(id: &str) -> Option<u32> {
    // Match trailing `-<number>[kKmM]` (e.g. `foo-256k`, `bar-1m`).
    let bytes = id.as_bytes();
    let mut i = bytes.len();
    if i == 0 {
        return None;
    }
    let unit = match bytes[i - 1] {
        b'k' | b'K' => 1_000u32,
        b'm' | b'M' => 1_000_000u32,
        _ => return None,
    };
    i -= 1;
    let end = i;
    while i > 0 && bytes[i - 1].is_ascii_digit() {
        i -= 1;
    }
    if i == end || i == 0 || bytes[i - 1] != b'-' {
        return None;
    }
    let num: u32 = std::str::from_utf8(&bytes[i..end]).ok()?.parse().ok()?;
    num.checked_mul(unit)
}

fn reasoning_levels_for(id: &str) -> Vec<String> {
    if id.contains("gpt-5") || id.contains("gpt5") || id.contains("o3") || id.contains("o4") {
        return vec![
            "off".into(),
            "minimal".into(),
            "low".into(),
            "medium".into(),
            "high".into(),
            "xhigh".into(),
        ];
    }
    if id.contains("o1") {
        return vec!["low".into(), "medium".into(), "high".into()];
    }
    if id.contains("claude") {
        return vec!["off".into(), "low".into(), "medium".into(), "high".into()];
    }
    if id.contains("gemini") {
        return vec!["off".into(), "low".into(), "medium".into(), "high".into()];
    }
    // DeepSeek / generic OpenAI-compatible reasoning models.
    vec!["off".into(), "low".into(), "medium".into(), "high".into()]
}

/// Pull a context-length field from a `/models` list item when present.
///
/// Deliberately ignores `max_tokens` / `maxTokens` — many OpenAI-compatible
/// `/models` payloads use those for max *completion* tokens (e.g. 4096), not
/// the context window. Treating them as context would trigger premature
/// compression.
pub fn context_window_from_api_model(value: &serde_json::Value) -> Option<u32> {
    const KEYS: &[&str] = &[
        "context_length",
        "contextLength",
        "context_window",
        "contextWindow",
        "max_model_len",
        "maxModelLen",
    ];
    for key in KEYS {
        if let Some(n) = value.get(*key).and_then(|v| v.as_u64()) {
            if n > 0 && n <= u32::MAX as u64 {
                return Some(n as u32);
            }
        }
    }
    // OpenRouter nests under `top_provider.context_length`.
    if let Some(n) = value
        .pointer("/top_provider/context_length")
        .or_else(|| value.pointer("/topProvider/contextLength"))
        .and_then(|v| v.as_u64())
    {
        if n > 0 && n <= u32::MAX as u64 {
            return Some(n as u32);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deepseek_reasoner_gets_levels() {
        let m = detect("deepseek-reasoner");
        assert!(m.capabilities.reasoning);
        assert_eq!(m.reasoning_support, ReasoningSupport::Yes);
        assert!(m.reasoning_levels.contains(&"high".to_string()));
        assert_eq!(m.context_window, Some(128_000));
    }

    #[test]
    fn plain_chat_has_no_levels() {
        let m = detect("deepseek-chat");
        assert!(!m.capabilities.reasoning);
        assert!(m.reasoning_levels.is_empty());
        assert_eq!(m.context_window, Some(128_000));
    }

    #[test]
    fn gpt5_includes_minimal_and_xhigh() {
        let m = detect("gpt-5.2");
        assert!(m.capabilities.reasoning);
        assert!(m.reasoning_levels.iter().any(|l| l == "minimal"));
        assert!(m.reasoning_levels.iter().any(|l| l == "xhigh"));
    }

    #[test]
    fn refresh_keeps_runtime_no() {
        let mut m = detect("deepseek-reasoner");
        m.reasoning_support = ReasoningSupport::No;
        let next = refresh(&m);
        assert_eq!(next.reasoning_support, ReasoningSupport::No);
        assert!(next.reasoning_levels.is_empty());
    }

    #[test]
    fn refresh_keeps_explicit_window() {
        let mut m = detect("unknown-model-xyz");
        assert!(m.context_window.is_none());
        m.context_window = Some(64_000);
        let next = refresh(&m);
        assert_eq!(next.context_window, Some(64_000));
    }

    #[test]
    fn api_window_wins_over_heuristic() {
        let m = detect_with_window("deepseek-chat", Some(64_000));
        assert_eq!(m.context_window, Some(64_000));
    }

    #[test]
    fn size_suffix_and_kimi() {
        assert_eq!(heuristic_context_window("foo-256k"), Some(256_000));
        assert_eq!(heuristic_context_window("kimi-k3-preview"), Some(1_000_000));
    }

    #[test]
    fn context_from_api_json() {
        let v = serde_json::json!({"id": "x", "context_length": 131072});
        assert_eq!(context_window_from_api_model(&v), Some(131_072));
        let v2 = serde_json::json!({"id": "x", "top_provider": {"context_length": 200000}});
        assert_eq!(context_window_from_api_model(&v2), Some(200_000));
        // Completion-cap fields must not be treated as context windows.
        let v3 = serde_json::json!({"id": "x", "max_tokens": 4096, "maxTokens": 8192});
        assert_eq!(context_window_from_api_model(&v3), None);
        let v4 = serde_json::json!({"id": "x", "max_model_len": 32768, "max_tokens": 4096});
        assert_eq!(context_window_from_api_model(&v4), Some(32_768));
    }
}
