//! `switch_mode`: let the model change the session mode (plan/auto/code/ask).
//!
//! Marked read-only so it still runs under Ask/Plan (otherwise the model could
//! never leave those modes). The harness emits ACP `CurrentModeUpdate` after a
//! successful call so the Composer stays in sync.

use super::{Tool, ToolCtx};
use agent_client_protocol as acp;

const MODES: &[&str] = &["plan", "auto", "code", "ask"];

/// Validates and normalizes a mode id.
pub fn parse_mode(raw: &str) -> Option<&'static str> {
    let lower = raw.trim().to_ascii_lowercase();
    MODES.iter().copied().find(|m| *m == lower)
}

pub struct SwitchMode;

#[async_trait::async_trait(?Send)]
impl Tool for SwitchMode {
    fn name(&self) -> &'static str {
        "switch_mode"
    }

    fn description(&self) -> &'static str {
        "Switch the session mode for subsequent tool calls. \
         Modes: `plan` (read-only research then a concrete plan), \
         `auto` (edit + run without per-step approval), \
         `code` (edit + run with approval), `ask` (read-only Q&A). \
         Use `plan` for large/ambiguous work and only switch to `code`/`auto` \
         after the user confirms the plan. Do not flip modes unnecessarily."
    }

    fn schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "mode": {
                    "type": "string",
                    "enum": ["plan", "auto", "code", "ask"],
                    "description": "Target session mode"
                },
                "reason": {
                    "type": "string",
                    "description": "Short reason for the switch (shown in the tool result)"
                }
            },
            "required": ["mode"],
            "additionalProperties": false
        })
    }

    fn kind(&self) -> acp::ToolKind {
        acp::ToolKind::Other
    }

    fn read_only(&self) -> bool {
        true
    }

    async fn execute(&self, args: serde_json::Value, ctx: &ToolCtx) -> Result<String, String> {
        let mode_raw = args
            .get("mode")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "missing required argument `mode`".to_string())?;
        let mode = parse_mode(mode_raw).ok_or_else(|| {
            format!("invalid mode `{mode_raw}`; expected one of plan/auto/code/ask")
        })?;
        let reason = args
            .get("reason")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty());

        let Some(cell) = &ctx.mode_id else {
            return Err("switch_mode is unavailable in this context".into());
        };
        let prev = cell.borrow().clone();
        if prev == mode {
            return Ok(format!("already in `{mode}` mode"));
        }
        *cell.borrow_mut() = mode.to_string();
        match reason {
            Some(r) => Ok(format!("switched mode `{prev}` → `{mode}` ({r})")),
            None => Ok(format!("switched mode `{prev}` → `{mode}`")),
        }
    }
}

/// Test helper: a ToolCtx mode cell preloaded with `initial`.
#[cfg(test)]
pub fn test_mode_cell(initial: &str) -> std::rc::Rc<std::cell::RefCell<String>> {
    std::rc::Rc::new(std::cell::RefCell::new(initial.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::path::PathBuf;
    use std::rc::Rc;
    use std::time::Duration;

    fn ctx(mode: &str) -> ToolCtx {
        ToolCtx {
            cwd: PathBuf::from("/tmp"),
            bash_timeout: Duration::from_secs(1),
            path_env: std::env::var_os("PATH").unwrap_or_default(),
            archive_dir: PathBuf::from("/tmp/.nex-archive"),
            jobs: Rc::new(RefCell::new(
                crate::agent::native::tools::jobs::JobTable::default(),
            )),
            harness: None,
            mutations: Rc::new(RefCell::new(Vec::new())),
            mode_id: Some(test_mode_cell(mode)),
            memory: super::super::test_memory_handle(),
            graph: None,
        conn: None,
        session_id: None,
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn switches_and_rejects_invalid() {
        let c = ctx("code");
        let cell = c.mode_id.clone().unwrap();
        let out = SwitchMode
            .execute(
                serde_json::json!({ "mode": "plan", "reason": "scope unclear" }),
                &c,
            )
            .await
            .unwrap();
        assert!(out.contains("code"));
        assert!(out.contains("plan"));
        assert_eq!(cell.borrow().as_str(), "plan");

        let err = SwitchMode
            .execute(serde_json::json!({ "mode": "nope" }), &c)
            .await
            .unwrap_err();
        assert!(err.contains("invalid mode"));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn noop_when_same_mode() {
        let c = ctx("ask");
        let out = SwitchMode
            .execute(serde_json::json!({ "mode": "ASK" }), &c)
            .await
            .unwrap();
        assert!(out.contains("already"));
    }
}
