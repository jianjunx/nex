//! Heuristic model-capability detection for OpenAI-compatible endpoints.
//!
//! Used when the user adds or fetches models in Settings. Runtime rejection of
//! `reasoning_effort` still wins and is persisted separately as
//! [`super::config::ReasoningSupport::No`].

use super::config::{ModelCapabilities, ModelEntry, ReasoningSupport};

/// Infers capabilities + reasoning levels from a model id.
pub fn detect(model_id: &str) -> ModelEntry {
    let id = model_id.trim();
    let lower = id.to_ascii_lowercase();
    let reasoning = looks_like_reasoning(&lower);
    let vision = looks_like_vision(&lower);
    let levels = if reasoning {
        reasoning_levels_for(&lower)
    } else {
        Vec::new()
    };
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
    }
}

/// Re-runs detection while preserving the wire `id`.
pub fn refresh(entry: &ModelEntry) -> ModelEntry {
    let mut next = detect(&entry.id);
    // Runtime "no" always wins over heuristics.
    if entry.reasoning_support == ReasoningSupport::No {
        next.reasoning_support = ReasoningSupport::No;
        next.capabilities.reasoning = false;
        next.reasoning_levels.clear();
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deepseek_reasoner_gets_levels() {
        let m = detect("deepseek-reasoner");
        assert!(m.capabilities.reasoning);
        assert_eq!(m.reasoning_support, ReasoningSupport::Yes);
        assert!(m.reasoning_levels.contains(&"high".to_string()));
    }

    #[test]
    fn plain_chat_has_no_levels() {
        let m = detect("deepseek-chat");
        assert!(!m.capabilities.reasoning);
        assert!(m.reasoning_levels.is_empty());
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
}
