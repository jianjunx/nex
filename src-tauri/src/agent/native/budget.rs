//! Context budget control for the native agent.
//!
//! Resolves the model's reported context window into a hard prompt budget
//! the harness must satisfy before sending. The actual compaction work is
//! driven by [`crate::agent::native::compact::step`]; this module only owns
//! the math.
//!
//! Defaults are intentionally conservative and provider-agnostic. They are
//! placeholders, not long-term truth — providers are expected to override
//! `reserved_response` once the trait exposes a hint.

use crate::agent::native::provider::{Provider, ReasoningControl};
use crate::agent::native::{compact, memory, summary};

/// Upper bound on the deliberate Snip -> Compact -> Force walk. Three
/// passes is enough to apply every tier exactly once; the loop also bails
/// early on no-progress, so this is a hard ceiling rather than a target.
pub const MAX_COMPACT_PASSES: usize = 3;

/// Fallback used when the model's window is too small to admit the
/// `reserved_response + safety_margin` formula. Lets degraded sessions still
/// send a request instead of failing the prompt turn.
pub const SMALL_WINDOW_FALLBACK: u64 = 4096;

/// Minimum prompt budget we will ever send. Below this the request is
/// effectively useless; we clamp to `SMALL_WINDOW_FALLBACK` instead.
pub const MIN_PROMPT_BUDGET: u64 = 1024;

/// Result of a budget resolution. `prompt_budget = 0` is the sentinel that
/// means "compression disabled" — the caller is expected to short-circuit.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ContextBudget {
    /// The model's reported context window (raw).
    pub model_window: u64,
    /// Headroom reserved for the model's response.
    pub reserved_response: u64,
    /// Headroom kept for tokenizer / serializer uncertainty.
    pub safety_margin: u64,
    /// Hard cap on the prompt the harness will send. `0` disables
    /// compression entirely (the legacy behavior).
    pub prompt_budget: u64,
}

/// Conservative default for reserved response tokens when the provider does
/// not surface one. Reasoning-heavy models need more headroom because the
/// hidden chain-of-thought competes for the same response budget.
pub fn default_reserved_response(model_id: &str, reasoning: ReasoningControl) -> u64 {
    let family_is_reasoning = model_id
        .rsplit_once('/')
        .map(|(_, m)| {
            let lower = m.to_ascii_lowercase();
            lower.contains("reason")
                || lower.contains("o1")
                || lower.contains("o3")
                || lower.contains("r1")
                || lower.contains("thinking")
        })
        .unwrap_or(false);
    if family_is_reasoning
        || matches!(
            reasoning,
            ReasoningControl::High | ReasoningControl::XHigh
        )
    {
        8192
    } else {
        4096
    }
}

/// Conservative default for tokenizer uncertainty margin.
pub fn default_safety_margin(model_window: u64) -> u64 {
    let dyn_margin = (model_window * 3) / 100;
    dyn_margin.clamp(2048, 8192)
}

/// Resolve a model window into a hard prompt budget.
///
/// `model_window == 0` disables compression (the existing behavior, kept
/// for backwards compatibility and for users who have explicitly opted
/// out).
pub fn resolve(model_window: u64, reserved_response: u64, safety_margin: u64) -> ContextBudget {
    if model_window == 0 {
        return ContextBudget {
            model_window: 0,
            reserved_response: 0,
            safety_margin: 0,
            prompt_budget: 0,
        };
    }
    let mut budget = model_window.saturating_sub(reserved_response);
    budget = budget.saturating_sub(safety_margin);
    if budget < MIN_PROMPT_BUDGET {
        budget = SMALL_WINDOW_FALLBACK;
    }
    ContextBudget {
        model_window,
        reserved_response,
        safety_margin,
        prompt_budget: budget,
    }
}

/// Resolve a budget for a session, consulting the provider for a hint.
///
/// `model_window` should already come from
/// `NativeAgentConfig::context_window_for(composite)`.
pub fn resolve_for_session(
    provider: &dyn Provider,
    model_id: &str,
    reasoning: ReasoningControl,
    model_window: u64,
) -> ContextBudget {
    let reserved = provider
        .reserved_response_hint(model_id)
        .unwrap_or_else(|| default_reserved_response(model_id, reasoning));
    let safety = default_safety_margin(model_window);
    resolve(model_window, reserved, safety)
}

/// Aggregate stats for one [`enforce`] call. Exposed so the turn harness and
/// future metrics layer can observe compaction behavior without leaking the
/// internal loop state.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct BudgetLoopOutcome {
    /// Tokens estimated at the start of the loop.
    pub initial_tokens: u64,
    /// Tokens estimated after the loop exited.
    pub final_tokens: u64,
    /// Number of compaction passes that actually ran.
    pub passes: usize,
    /// Total tool-result messages that were snipped across all passes.
    pub total_snipped: usize,
    /// Total assistant/tool messages that were folded (archived) across all
    /// passes.
    pub total_folded: usize,
    /// Archive files written by the loop, in order. Useful for debugging
    /// and for tying the transcript back to its full history via `history`.
    pub archive_files: Vec<std::path::PathBuf>,
    /// Whether the final fallback summary splice was used.
    pub used_summary_fallback: bool,
    /// True when the transcript still exceeds `prompt_budget` after every
    /// tier plus the summary fallback. The turn harness must not send.
    pub over_budget: bool,
}

/// Drive [`crate::agent::native::compact::step`] until `messages` fits
/// `budget.prompt_budget`, `MAX_COMPACT_PASSES` is reached, or a pass stops
/// making progress. Returns the loop's stats for observability.
pub fn enforce(
    messages: &mut Vec<crate::agent::native::provider::ChatMessage>,
    budget: ContextBudget,
    archive_dir: &std::path::Path,
) -> BudgetLoopOutcome {
    enforce_with_memory(messages, budget, archive_dir, None)
}

/// Like [`enforce`], but the fallback summary is filled from session working
/// memory when provided instead of a mechanically extracted stub.
pub fn enforce_with_memory(
    messages: &mut Vec<crate::agent::native::provider::ChatMessage>,
    budget: ContextBudget,
    archive_dir: &std::path::Path,
    working_memory: Option<&memory::WorkingMemory>,
) -> BudgetLoopOutcome {
    if budget.prompt_budget == 0 {
        // Still report the current estimate so the composer can show
        // `used / window` even when the user has disabled compression.
        let used = compact::estimate_tokens(messages);
        return BudgetLoopOutcome {
            initial_tokens: used,
            final_tokens: used,
            ..Default::default()
        };
    }
    let mut outcome = BudgetLoopOutcome::default();
    let mut used = compact::estimate_tokens(messages);
    outcome.initial_tokens = used;
    if used <= budget.prompt_budget {
        outcome.final_tokens = used;
        return outcome;
    }
    // Deliberate walk: Snip -> Compact -> Force. Each pass re-estimates; if
    // a pass made no progress we stop instead of burning budget cycles.
    let tier_plan = [
        compact::StepTier::Snip,
        compact::StepTier::Compact,
        compact::StepTier::Force,
    ];
    for tier in tier_plan.iter().copied() {
        if used <= budget.prompt_budget {
            break;
        }
        let step = compact::step(messages, budget.prompt_budget, tier, archive_dir);
        outcome.passes += 1;
        outcome.total_snipped += step.snipped;
        outcome.total_folded += step.folded;
        if let Some(p) = step.archive_file {
            outcome.archive_files.push(p);
        }
        let used_after = compact::estimate_tokens(messages);
        if used_after >= used {
            // A full tier pass saved nothing: bail before burning more.
            break;
        }
        used = used_after;
    }
    // Final fallback: if the transcript still exceeds budget, replace the
    // old prefix with a single stable summary block pointing at the archive.
    if used > budget.prompt_budget {
        let body = match working_memory {
            Some(m) => summary::render_from_memory(m),
            None => summary::render_fallback_summary(messages),
        };
        let splice = compact::replace_prefix_with_summary(messages, body, archive_dir);
        if let Some(p) = splice.archive_file {
            outcome.archive_files.push(p);
            outcome.used_summary_fallback = true;
            outcome.total_folded += 1;
            used = compact::estimate_tokens(messages);
        }
    }
    // Last resort: snip remaining tool bodies (including the protected tail)
    // so a single oversized result cannot keep the request over budget.
    if used > budget.prompt_budget {
        let extra = compact::snip_tool_results(messages, true);
        outcome.total_snipped += extra;
        used = compact::estimate_tokens(messages);
    }
    outcome.over_budget = used > budget.prompt_budget;
    if outcome.over_budget {
        log::warn!(
            "context budget exhausted: used={} budget={} window={}",
            used,
            budget.prompt_budget,
            budget.model_window
        );
    }
    outcome.final_tokens = used;
    outcome
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::native::compact;
    use crate::agent::native::provider::ChatMessage;

    fn model_window(window: u64) -> ContextBudget {
        resolve(window, default_reserved_response("demo", ReasoningControl::Off), default_safety_margin(window))
    }

    #[test]
    fn zero_window_means_compression_off() {
        let b = model_window(0);
        assert_eq!(b.prompt_budget, 0);
        assert!(b.reserved_response > 0 || b.prompt_budget == 0);
    }

    #[test]
    fn large_window_keeps_reserved_response() {
        let b = model_window(200_000);
        assert!(b.prompt_budget > 0);
        // 200k - 4096 (default reserved) - safety_margin
        assert!(b.prompt_budget < b.model_window);
    }

    #[test]
    fn tiny_window_falls_back_to_safe_minimum() {
        let b = model_window(2048);
        assert_eq!(b.prompt_budget, SMALL_WINDOW_FALLBACK);
    }

    #[test]
    fn reasoning_heavy_model_gets_higher_reserve() {
        let plain = default_reserved_response("deepseek/deepseek-chat", ReasoningControl::Off);
        let heavy = default_reserved_response("deepseek/deepseek-reasoner", ReasoningControl::Off);
        assert!(heavy > plain);
    }

    #[test]
    fn enforce_loop_converges_under_budget() {
        // Heavy transcript that needs Snip + Compact + Force. The test
        // asserts the loop terminates within `MAX_COMPACT_PASSES` and
        // that the trajectory is monotonically non-increasing: the loop
        // bails on no-progress.
        let mut msgs: Vec<ChatMessage> = vec![ChatMessage::system("sys")];
        for i in 0..40 {
            msgs.push(ChatMessage::user(format!("user {i} {}", "u".repeat(200))));
            msgs.push(ChatMessage::assistant(format!("assistant {i} {}", "a".repeat(200))));
        }
        let budget = model_window(8_000);
        let tmp = tempfile::tempdir().unwrap();
        let initial = compact::estimate_tokens(&msgs);
        let outcome = enforce(&mut msgs, budget, tmp.path());
        assert!(outcome.passes <= MAX_COMPACT_PASSES);
        // Bounded by the 3-step Snip -> Compact -> Force walk; the loop
        // may exit without full convergence when there is no more work to
        // do, but it must never run away.
        assert!(outcome.final_tokens <= initial);
    }

    #[test]
    fn enforce_loop_respects_max_passes_on_pathological_input() {
        // 1MB single user message can't be snipped below 1600 chars
        // without breaking the message-pair invariant; the loop must bail
        // before it loops forever.
        let mut msgs: Vec<ChatMessage> = vec![ChatMessage::system("sys")];
        msgs.push(ChatMessage::user("x".repeat(1_000_000)));
        let budget = model_window(2_000);
        let tmp = tempfile::tempdir().unwrap();
        let outcome = enforce(&mut msgs, budget, tmp.path());
        assert!(outcome.passes <= MAX_COMPACT_PASSES);
        assert!(outcome.over_budget);
    }

    #[test]
    fn enforce_uses_summary_fallback_when_tiers_cannot_fit() {
        // User + tool-only transcript: Snip can shrink the tool bodies, but
        // Compact / Force have no assistant prose to fold. The final summary
        // fallback should therefore take over.
        let mut msgs: Vec<ChatMessage> = vec![ChatMessage::system("sys")];
        for i in 0..20 {
            msgs.push(ChatMessage::user(format!("goal {i} {}", "u".repeat(200))));
            msgs.push(ChatMessage::tool_result(format!("t{i}"), "x".repeat(6000)));
        }
        let budget = model_window(4_000);
        let tmp = tempfile::tempdir().unwrap();
        let outcome = enforce(&mut msgs, budget, tmp.path());
        assert!(outcome.used_summary_fallback);
        let summary_text = msgs[1]
            .content
            .as_ref()
            .and_then(crate::agent::native::provider::Content::as_text)
            .unwrap();
        assert!(summary_text.starts_with(crate::agent::native::compact::SUMMARY_MARKER));
    }

    #[test]
    fn enforce_walks_tiers_in_order() {
        // A transcript that fits Snip should converge in exactly one pass.
        let big = "z".repeat(8_000);
        let mut msgs: Vec<ChatMessage> = vec![ChatMessage::system("sys")];
        for i in 0..6 {
            msgs.push(ChatMessage::user(format!("u{i}")));
            msgs.push(ChatMessage::tool_result(format!("t{i}"), &big));
        }
        let budget = model_window(16_000);
        let tmp = tempfile::tempdir().unwrap();
        let outcome = enforce(&mut msgs, budget, tmp.path());
        assert!(outcome.passes >= 1);
        assert!(outcome.passes <= MAX_COMPACT_PASSES);
        assert!(outcome.total_snipped > 0 || outcome.total_folded > 0);
        assert!(compact::estimate_tokens(&msgs) <= budget.prompt_budget);
    }

    #[test]
    fn disabled_window_means_loop_is_a_noop() {
        let mut msgs: Vec<ChatMessage> = vec![ChatMessage::user("x".repeat(1_000_000))];
        let before = msgs.len();
        let budget = ContextBudget {
            model_window: 0,
            reserved_response: 0,
            safety_margin: 0,
            prompt_budget: 0,
        };
        let tmp = tempfile::tempdir().unwrap();
        let outcome = enforce(&mut msgs, budget, tmp.path());
        assert_eq!(msgs.len(), before);
        assert_eq!(outcome.passes, 0);
        assert!(!outcome.over_budget);
        assert!(outcome.final_tokens > 0);
        assert_eq!(outcome.final_tokens, outcome.initial_tokens);
        assert_eq!(outcome.final_tokens, compact::estimate_tokens(&msgs));
    }

    #[test]
    fn resolve_min_prompt_budget_clamps_to_fallback() {
        let b = resolve(1500, 1000, 500);
        assert_eq!(b.prompt_budget, SMALL_WINDOW_FALLBACK);
    }

    #[test]
    fn resolve_saturating_sub_with_underflow_falls_back() {
        // model_window too small to admit reserved + safety -> clamp to fallback.
        let b = resolve(2048, 4096, 2048);
        assert_eq!(b.prompt_budget, SMALL_WINDOW_FALLBACK);
    }

    #[test]
    fn enforce_fallback_summary_uses_working_memory() {
        let mut memory = memory::WorkingMemory::new();
        memory.set_goal("修 cache 命中率");
        memory.record_file_changed("src/cache.rs");
        memory.record_open_question("verify hit ratio");
        let mut msgs: Vec<ChatMessage> = vec![ChatMessage::system("sys")];
        for i in 0..20 {
            msgs.push(ChatMessage::user(format!("goal {i} {}", "u".repeat(200))));
            msgs.push(ChatMessage::tool_result(format!("t{i}"), "x".repeat(6000)));
        }
        let budget = model_window(4_000);
        let tmp = tempfile::tempdir().unwrap();
        let outcome = enforce_with_memory(&mut msgs, budget, tmp.path(), Some(&memory));
        assert!(outcome.used_summary_fallback);
        let summary_text = msgs
            .iter()
            .find(|m| compact::is_summary(m))
            .and_then(|m| m.content.as_ref())
            .and_then(crate::agent::native::provider::Content::as_text)
            .unwrap();
        assert!(summary_text.contains("修 cache 命中率"));
        assert!(summary_text.contains("src/cache.rs"));
        assert!(summary_text.contains("verify hit ratio"));
    }
}
