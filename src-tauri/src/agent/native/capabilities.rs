//! Model-capability detection for OpenAI-compatible endpoints.
//!
//! Resolution order for Composer reasoning ladders:
//! 1. Manual Settings override (`reasoning_manual`)
//! 2. Provider `/models` declaration (OpenRouter-style `reasoning` /
//!    `supported_parameters`)
//! 3. Active probe results (`ReasoningSource::Probe`)
//! 4. Family / id heuristics (CherryStudio / OpenCode / Pi style)
//!
//! Runtime rejection of `reasoning_effort` still wins (unless manual) and is
//! persisted as [`super::config::ReasoningSupport::No`].

use super::config::{ModelCapabilities, ModelEntry, ReasoningSource, ReasoningSupport};

/// Canonical effort ids Nex understands in Composer / wire bodies.
pub const KNOWN_EFFORTS: &[&str] = &["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/// Infers capabilities + reasoning levels + context window from a model id.
pub fn detect(model_id: &str) -> ModelEntry {
    detect_with_window(model_id, None)
}

/// Like [`detect`], but prefers an API-reported context window when present.
pub fn detect_with_window(model_id: &str, api_context_window: Option<u32>) -> ModelEntry {
    let id = model_id.trim();
    let lower = id.to_ascii_lowercase();
    let levels = reasoning_levels_for(&lower);
    let reasoning = !levels.is_empty();
    let vision = looks_like_vision(&lower);
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
        reasoning_manual: false,
        reasoning_source: if reasoning {
            ReasoningSource::Heuristic
        } else {
            ReasoningSource::None
        },
    }
}

/// Build a [`ModelEntry`] from a `/models` list item.
///
/// Prefers OpenRouter-style capability declarations when present; otherwise
/// falls back to id heuristics. Always merges an API-reported context window.
pub fn from_api_model(value: &serde_json::Value) -> Option<ModelEntry> {
    let id = value.get("id").and_then(|v| v.as_str())?;
    let api_window = context_window_from_api_model(value);
    let mut entry = detect_with_window(id, api_window);
    if let Some(api_levels) = reasoning_levels_from_api(value) {
        apply_reasoning_ladder(
            &mut entry,
            api_levels,
            ReasoningSupport::Yes,
            ReasoningSource::Api,
            false,
        );
    }
    // Vision from OpenRouter architecture.input_modalities when present.
    if let Some(mods) = value
        .pointer("/architecture/input_modalities")
        .or_else(|| value.pointer("/architecture/inputModalities"))
        .and_then(|v| v.as_array())
    {
        if mods.iter().any(|m| m.as_str() == Some("image")) {
            entry.capabilities.vision = true;
        }
    }
    Some(entry)
}

/// Apply a resolved ladder onto an entry (shared by API / probe / manual).
pub fn apply_reasoning_ladder(
    entry: &mut ModelEntry,
    levels: Vec<String>,
    support: ReasoningSupport,
    source: ReasoningSource,
    manual: bool,
) {
    let levels = normalize_effort_levels(levels);
    entry.reasoning_levels = levels;
    entry.capabilities.reasoning = !entry.reasoning_levels.is_empty();
    entry.reasoning_support = if entry.capabilities.reasoning {
        support
    } else if manual {
        ReasoningSupport::No
    } else {
        ReasoningSupport::Unknown
    };
    entry.reasoning_source = if entry.capabilities.reasoning {
        source
    } else if manual {
        ReasoningSource::Manual
    } else {
        ReasoningSource::None
    };
    entry.reasoning_manual = manual;
}

/// Re-runs detection while preserving manual / API / probe ladders, runtime
/// reasoning-no, and any user-/API-set context window.
pub fn refresh(entry: &ModelEntry) -> ModelEntry {
    let preserve_ladder = entry.reasoning_manual
        || matches!(
            entry.reasoning_source,
            ReasoningSource::Manual | ReasoningSource::Api | ReasoningSource::Probe
        );

    if preserve_ladder {
        let mut next = entry.clone();
        // Fill missing context window from heuristics only.
        if next.context_window.is_none() {
            next.context_window = detect(&entry.id).context_window;
        }
        // Runtime "no" still clears auto-sourced ladders; manual stays put.
        if entry.reasoning_support == ReasoningSupport::No && !entry.reasoning_manual {
            next.capabilities.reasoning = false;
            next.reasoning_levels.clear();
            next.reasoning_source = ReasoningSource::None;
        }
        return next;
    }

    let mut next = detect_with_window(&entry.id, entry.context_window);
    if entry.reasoning_support == ReasoningSupport::No {
        next.reasoning_support = ReasoningSupport::No;
        next.capabilities.reasoning = false;
        next.reasoning_levels.clear();
        next.reasoning_source = ReasoningSource::None;
    }
    if entry.context_window.is_some() {
        next.context_window = entry.context_window;
    }
    next.reasoning_manual = false;
    next
}

/// Normalize effort ids: map `none`→`off`, drop unknowns/duplicates, stable order.
pub fn normalize_effort_levels(raw: Vec<String>) -> Vec<String> {
    let mut out = Vec::new();
    for level in raw {
        let mapped = match level.to_ascii_lowercase().as_str() {
            "none" | "off" | "disabled" => "off",
            "minimal" | "min" => "minimal",
            "low" => "low",
            "medium" | "med" => "medium",
            "high" => "high",
            "xhigh" | "x-high" | "extra" => "xhigh",
            "max" | "maximal" => "max",
            // "auto" / "default" are not discrete Composer levels in Nex.
            _ => continue,
        };
        if !out.iter().any(|x| x == mapped) {
            out.push(mapped.to_string());
        }
    }
    out.sort_by_key(|l| {
        KNOWN_EFFORTS
            .iter()
            .position(|k| *k == l.as_str())
            .unwrap_or(99)
    });
    out
}

/// Parse OpenRouter-style reasoning declaration from a `/models` item.
///
/// Returns `None` when the payload carries no reasoning capability signal
/// (caller should keep heuristics). Returns `Some(vec![])` only when the API
/// explicitly advertises reasoning with an empty controllable ladder — treated
/// as "reasoning model, no effort UI" by applying a binary off/high fallback.
fn reasoning_levels_from_api(value: &serde_json::Value) -> Option<Vec<String>> {
    let has_param = value
        .get("supported_parameters")
        .or_else(|| value.get("supportedParameters"))
        .and_then(|v| v.as_array())
        .is_some_and(|arr| {
            arr.iter().any(|p| {
                matches!(
                    p.as_str(),
                    Some("reasoning" | "reasoning_effort" | "include_reasoning")
                )
            })
        });

    let reasoning = value.get("reasoning");
    if let Some(obj) = reasoning.and_then(|v| v.as_object()) {
        let mandatory = obj
            .get("mandatory")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let mut levels = match obj
            .get("supported_efforts")
            .or_else(|| obj.get("supportedEfforts"))
        {
            // null → gateway accepts the full effort set
            Some(v) if v.is_null() => KNOWN_EFFORTS
                .iter()
                .filter(|e| **e != "off")
                .map(|s| (*s).to_string())
                .collect(),
            Some(v) => {
                let arr = v.as_array()?;
                let parsed: Vec<String> = arr
                    .iter()
                    .filter_map(|x| x.as_str().map(str::to_string))
                    .collect();
                let norm = normalize_effort_levels(parsed);
                if norm.is_empty() {
                    // Present but empty / unrecognized → binary toggle.
                    vec!["high".into()]
                } else {
                    norm.into_iter().filter(|l| l != "off").collect()
                }
            }
            None => vec!["low".into(), "medium".into(), "high".into()],
        };
        if !mandatory && !levels.iter().any(|l| l == "off") {
            levels.insert(0, "off".into());
        }
        return Some(normalize_effort_levels(levels));
    }

    if has_param {
        return Some(normalize_effort_levels(vec![
            "off".into(),
            "low".into(),
            "medium".into(),
            "high".into(),
        ]));
    }
    None
}

/// Whether the OpenAI-compatible request should send DeepSeek-style
/// `thinking: {type}` alongside `reasoning_effort` (V4 + hybrid chat routes).
pub fn uses_deepseek_thinking_toggle(model_id: &str) -> bool {
    let lower = model_id.to_ascii_lowercase();
    is_deepseek_v4(&lower)
        || is_deepseek_hybrid(&lower)
        || lower.contains("deepseek-reasoner")
        || lower.contains("deepseek-r1")
}

/// Whether the model expects a binary thinking toggle (no multi-tier effort).
pub fn uses_binary_thinking_toggle(model_id: &str) -> bool {
    let lower = model_id.to_ascii_lowercase();
    is_minimax_m3(&lower)
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
    if id.contains("deepseek-v4") {
        return Some(1_000_000);
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

fn s(levels: &[&str]) -> Vec<String> {
    levels.iter().map(|l| (*l).to_string()).collect()
}

fn is_deepseek_v4(id: &str) -> bool {
    id.contains("deepseek-v4") || id.contains("deepseek/v4")
}

fn is_deepseek_v4_flash(id: &str) -> bool {
    is_deepseek_v4(id) && id.contains("flash")
}

fn is_deepseek_v4_pro(id: &str) -> bool {
    is_deepseek_v4(id) && id.contains("pro")
}

/// Legacy chat / V3.x hybrids that expose a thinking toggle (and often effort).
fn is_deepseek_hybrid(id: &str) -> bool {
    if is_deepseek_v4(id) {
        return false;
    }
    id.contains("deepseek-chat")
        || id.contains("deepseek-v3.1")
        || id.contains("deepseek-v3.2")
        || id.contains("deepseek-v3-1")
        || id.contains("deepseek-v3-2")
}

fn is_minimax_m3(id: &str) -> bool {
    id.contains("minimax") && id.contains("m3")
}

fn is_minimax_m2(id: &str) -> bool {
    id.contains("minimax") && (id.contains("m2") || id.contains("m1"))
}

/// Family-specific effort ladders (CherryStudio / Pi style).
/// Empty = model does not expose controllable reasoning in Composer.
fn reasoning_levels_for(id: &str) -> Vec<String> {
    // DeepSeek V4: official wire scale is low/high/max (+ thinking off).
    // Flash accepts low; Pro maps low→high (Pi exposes high/max only).
    if is_deepseek_v4_flash(id) {
        return s(&["off", "low", "high", "max"]);
    }
    if is_deepseek_v4_pro(id) || is_deepseek_v4(id) {
        return s(&["off", "high", "max"]);
    }
    // Legacy aliases now route to V4-Flash on the official API.
    if id.contains("deepseek-reasoner") || id.contains("deepseek-r1") {
        return s(&["off", "low", "high", "max"]);
    }
    if is_deepseek_hybrid(id) {
        return s(&["off", "low", "high", "max"]);
    }

    // MiniMax: M3 is adaptive/binary on most OpenAI-compatible gateways;
    // M2 exposes low|medium|high.
    if is_minimax_m3(id) {
        return s(&["off", "high"]);
    }
    if is_minimax_m2(id) {
        return s(&["off", "low", "medium", "high"]);
    }

    if id.contains("gpt-5") || id.contains("gpt5") {
        if id.contains("pro") && !id.contains("5.2") && !id.contains("5.3") {
            return s(&["high"]);
        }
        if id.contains("codex") {
            if id.contains("5.1") && id.contains("max") {
                return s(&["medium", "high", "xhigh"]);
            }
            if id.contains("5.2") || id.contains("5.3") {
                return s(&["low", "medium", "high", "xhigh"]);
            }
            return s(&["low", "medium", "high"]);
        }
        if id.contains("5.1") {
            return s(&["off", "low", "medium", "high"]);
        }
        // GPT-5.2+ and generic gpt-5
        return s(&["off", "minimal", "low", "medium", "high", "xhigh"]);
    }

    if id.contains("o3") || id.contains("o4") {
        return s(&["off", "minimal", "low", "medium", "high", "xhigh"]);
    }
    if id.contains("o1") {
        return s(&["low", "medium", "high"]);
    }

    if id.contains("claude") {
        if id.contains("4.6") || id.contains("4-6") {
            return s(&["off", "low", "medium", "high", "xhigh"]);
        }
        if id.contains("claude-4")
            || id.contains("claude-opus-4")
            || id.contains("claude-sonnet-4")
            || id.contains("claude-3-7")
            || id.contains("claude-3.7")
            || id.contains("opus-4")
            || id.contains("sonnet-4")
        {
            return s(&["off", "low", "medium", "high"]);
        }
        // Older Claude ids: only advertise when clearly a thinking SKU.
        if id.contains("thinking") {
            return s(&["off", "low", "medium", "high"]);
        }
        return Vec::new();
    }

    if id.contains("gemini") {
        if id.contains("gemini-3") || id.contains("gemini-2.5") {
            return s(&["off", "low", "medium", "high"]);
        }
        return Vec::new();
    }

    if id.contains("kimi-k3") || id.contains("kimi/k3") {
        return s(&["off", "low", "high", "max"]);
    }
    if id.contains("kimi-k2") || id.contains("kimi/k2") || id.contains("kimi-k2.5") {
        return s(&["off", "high"]);
    }

    if id.contains("grok-3-mini") || (id.contains("grok-4") && !id.contains("non-reasoning")) {
        return s(&["off", "low", "high"]);
    }

    if id.contains("qwq") || id.contains("qwen3") {
        return s(&["off", "low", "medium", "high"]);
    }

    // Generic catch-all for explicitly named reasoning SKUs.
    if id.contains("reason")
        || id.contains("thinking")
        || id.contains("r1")
        || id.contains("hunyuan-t1")
        || id.contains("glm-zero")
    {
        return s(&["off", "low", "medium", "high"]);
    }

    Vec::new()
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
        assert!(m.reasoning_levels.contains(&"max".to_string()));
        assert_eq!(m.context_window, Some(128_000));
    }

    #[test]
    fn deepseek_v4_flash_and_pro_ladders() {
        let flash = detect("deepseek-v4-flash");
        assert!(flash.capabilities.reasoning);
        assert_eq!(
            flash.reasoning_levels,
            vec!["off", "low", "high", "max"]
                .into_iter()
                .map(String::from)
                .collect::<Vec<_>>()
        );
        assert_eq!(flash.context_window, Some(1_000_000));

        let pro = detect("deepseek-v4-pro");
        assert_eq!(
            pro.reasoning_levels,
            vec!["off", "high", "max"]
                .into_iter()
                .map(String::from)
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn deepseek_chat_hybrid_gets_levels() {
        let m = detect("deepseek-chat");
        assert!(m.capabilities.reasoning);
        assert!(m.reasoning_levels.contains(&"off".to_string()));
        assert!(m.reasoning_levels.contains(&"max".to_string()));
    }

    #[test]
    fn plain_non_reasoning_has_no_levels() {
        let m = detect("llama-3.3-70b");
        assert!(!m.capabilities.reasoning);
        assert!(m.reasoning_levels.is_empty());
    }

    #[test]
    fn minimax_m3_binary_thinking() {
        let m = detect("MiniMax-M3");
        assert!(m.capabilities.reasoning);
        assert_eq!(
            m.reasoning_levels,
            vec!["off", "high"]
                .into_iter()
                .map(String::from)
                .collect::<Vec<_>>()
        );
        assert!(uses_binary_thinking_toggle("MiniMax-M3[1m]"));
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

    #[test]
    fn deepseek_thinking_toggle_helpers() {
        assert!(uses_deepseek_thinking_toggle("deepseek-v4-pro"));
        assert!(uses_deepseek_thinking_toggle("deepseek-chat"));
        assert!(!uses_deepseek_thinking_toggle("gpt-5.2"));
    }

    #[test]
    fn openrouter_supported_efforts_wins_over_heuristic() {
        let v = serde_json::json!({
            "id": "vendor/unknown-thinker",
            "supported_parameters": ["reasoning", "tools"],
            "reasoning": {
                "supported_efforts": ["high", "medium", "none"],
                "mandatory": false
            },
            "context_length": 200000
        });
        let m = from_api_model(&v).expect("entry");
        assert_eq!(m.reasoning_source, ReasoningSource::Api);
        assert!(m.capabilities.reasoning);
        assert_eq!(
            m.reasoning_levels,
            vec!["off", "medium", "high"]
                .into_iter()
                .map(String::from)
                .collect::<Vec<_>>()
        );
        assert_eq!(m.context_window, Some(200_000));
    }

    #[test]
    fn openrouter_param_only_gets_default_ladder() {
        let v = serde_json::json!({
            "id": "vendor/foo",
            "supported_parameters": ["reasoning_effort"]
        });
        let m = from_api_model(&v).expect("entry");
        assert_eq!(m.reasoning_source, ReasoningSource::Api);
        assert!(m.reasoning_levels.contains(&"off".to_string()));
        assert!(m.reasoning_levels.contains(&"high".to_string()));
    }

    #[test]
    fn refresh_preserves_manual_ladder() {
        let mut m = detect("llama-3.3-70b");
        assert!(!m.capabilities.reasoning);
        apply_reasoning_ladder(
            &mut m,
            vec!["off".into(), "high".into()],
            ReasoningSupport::Yes,
            ReasoningSource::Manual,
            true,
        );
        let next = refresh(&m);
        assert!(next.reasoning_manual);
        assert_eq!(next.reasoning_source, ReasoningSource::Manual);
        assert_eq!(next.reasoning_levels, m.reasoning_levels);
    }

    #[test]
    fn normalize_maps_none_to_off() {
        let levels = normalize_effort_levels(vec![
            "none".into(),
            "HIGH".into(),
            "auto".into(),
            "high".into(),
        ]);
        assert_eq!(levels, vec!["off".to_string(), "high".to_string()]);
    }
}
