//! Per-turn context metrics.
//!
//! Carries the numbers we want to watch in CI / dashboards: cache hit ratio,
//! compaction passes, snipped / folded / archived messages, and how many
//! tool results were flagged as `partial` (i.e. the model saw only a
//! preview head). Designed to be cheap to assemble (no I/O) and trivial
//! to surface through the existing `prompt` response `_meta`.
//!
//! Keep the data flat: the upstream consumers are dashboard-style
//! scrapers, not a typed API.

use serde::Serialize;

/// Per-turn snapshot of the context-engine's runtime behaviour. Field
/// names are the public contract — don't rename without bumping the
/// `SCHEMA_VERSION`.
#[derive(Debug, Clone, Default, Serialize)]
pub struct ContextStats {
    /// Bumped whenever the struct's serialised shape changes.
    pub schema_version: u32,
    /// Token estimate *after* `budget::enforce` ran on this turn.
    pub final_tokens: u64,
    /// Number of compaction passes that actually ran.
    pub compaction_passes: u32,
    /// Total tool-result messages snipped across all passes.
    pub snipped_messages: u32,
    /// Total assistant/tool messages folded into the archive.
    pub folded_messages: u32,
    /// Number of distinct archive jsonl files written on this turn.
    pub archive_files_written: u32,
    /// Total tool result messages produced this turn (across all tools).
    pub tool_results: u32,
    /// Subset of `tool_results` that were returned as preview / partial
    /// content. This is the number we most want to keep low — every
    /// entry here is a chance the model continues reasoning on partial
    /// information.
    pub partial_tool_results: u32,
    /// Cache-hit tokens reported by the provider on the last stream
    /// of this turn, if any. Zero when the provider did not surface
    /// `prompt_cache_hit_tokens`.
    pub cache_hit_tokens: u64,
    /// Total prompt tokens reported by the provider on the last stream
    /// of this turn. Zero when the provider did not surface `usage`.
    pub prompt_tokens: u64,
}

impl ContextStats {
    /// Bump whenever the serialised shape changes; consumers can pin
    /// against this and warn when the schema drifts.
    pub const SCHEMA_VERSION: u32 = 1;

    pub fn new() -> Self {
        Self {
            schema_version: Self::SCHEMA_VERSION,
            ..Default::default()
        }
    }

    /// Ratio in `[0.0, 1.0]`. Returns `0.0` when `prompt_tokens == 0`
    /// (no usage returned by the provider).
    pub fn cache_hit_ratio(&self) -> f64 {
        if self.prompt_tokens == 0 {
            0.0
        } else {
            self.cache_hit_tokens as f64 / self.prompt_tokens as f64
        }
    }

    /// Fraction of tool results that were flagged as partial. Returns
    /// `0.0` when no tool results were produced.
    pub fn partial_ratio(&self) -> f64 {
        if self.tool_results == 0 {
            0.0
        } else {
            self.partial_tool_results as f64 / self.tool_results as f64
        }
    }
}

/// Helper for surfacing `ContextStats` in the `prompt` response's
/// `_meta` payload without leaking the field names elsewhere.
pub const META_KEY: &str = "contextStats";

/// Build the `_meta` JSON value for a turn. Caller passes the current
/// `ContextStats` plus any existing `meta` they want to preserve.
pub fn to_meta(stats: &ContextStats, existing: Option<serde_json::Value>) -> serde_json::Value {
    let mut meta = existing.unwrap_or_else(|| serde_json::json!({}));
    if let Some(obj) = meta.as_object_mut() {
        if let Ok(serialised) = serde_json::to_value(stats) {
            obj.insert(META_KEY.to_string(), serialised);
        }
    }
    meta
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cache_hit_ratio_handles_zero() {
        let s = ContextStats::new();
        assert_eq!(s.cache_hit_ratio(), 0.0);
    }

    #[test]
    fn cache_hit_ratio_uses_provider_numbers() {
        let s = ContextStats {
            cache_hit_tokens: 80,
            prompt_tokens: 100,
            ..ContextStats::new()
        };
        assert!((s.cache_hit_ratio() - 0.8).abs() < 1e-9);
    }

    #[test]
    fn partial_ratio_handles_zero() {
        let s = ContextStats::new();
        assert_eq!(s.partial_ratio(), 0.0);
    }

    #[test]
    fn partial_ratio_counts_partials() {
        let s = ContextStats {
            tool_results: 4,
            partial_tool_results: 1,
            ..ContextStats::new()
        };
        assert!((s.partial_ratio() - 0.25).abs() < 1e-9);
    }

    #[test]
    fn to_meta_preserves_existing() {
        let stats = ContextStats {
            final_tokens: 1234,
            ..ContextStats::new()
        };
        let existing = serde_json::json!({"hadMutations": true});
        let merged = to_meta(&stats, Some(existing));
        assert_eq!(merged["hadMutations"], true);
        assert_eq!(merged["contextStats"]["final_tokens"], 1234);
        assert_eq!(merged["contextStats"]["schema_version"], 1);
    }
}