//! Session-level MCP tool proxy.
//!
//! One [`McpProxy`] per tool of a connected MCP server, registered into the
//! session's registry under `mcp__{server}__{tool}` so builtin names never
//! collide. Execution forwards `tools/call` over JSON-RPC; results flagged
//! `isError` surface as tool errors.

use std::rc::Rc;

use agent_client_protocol as acp;

use super::{preview_partial, Tool, ToolCtx, INLINE_CAP_CHARS, PARTIAL_MARKER};
use crate::agent::native::mcp::McpClient;

/// Renders an MCP `content` array (text parts joined; other part types noted)
/// into the tool result string.
fn render_content(content: Option<&serde_json::Value>) -> String {
    let Some(content) = content else {
        return String::new();
    };
    let mut out = Vec::new();
    if let Some(parts) = content.as_array() {
        for part in parts {
            match part.get("type").and_then(|v| v.as_str()) {
                Some("text") => {
                    if let Some(t) = part.get("text").and_then(|v| v.as_str()) {
                        out.push(t.to_string());
                    }
                }
                Some(other) => {
                    out.push(format!("[{other} content from MCP server]"));
                }
                None => {}
            }
        }
    } else if let Some(t) = content.as_str() {
        out.push(t.to_string());
    }
    out.join("\n")
}

/// Proxies one tool of a connected MCP server. Not read-only: MCP tool calls
/// go through the normal permission flow (plan/ask/auto gating applies).
pub struct McpProxy {
    /// Registry name: `mcp__{server}__{tool}`.
    pub name: String,
    pub server: String,
    /// Tool name as the MCP server knows it.
    pub tool_name: String,
    pub description: String,
    pub schema: serde_json::Value,
    pub client: Rc<McpClient>,
}

#[async_trait::async_trait(?Send)]
impl Tool for McpProxy {
    fn name(&self) -> &str {
        &self.name
    }

    fn description(&self) -> &str {
        &self.description
    }

    fn schema(&self) -> serde_json::Value {
        self.schema.clone()
    }

    fn kind(&self) -> acp::ToolKind {
        acp::ToolKind::Other
    }

    async fn execute(&self, args: serde_json::Value, _ctx: &ToolCtx) -> Result<String, String> {
        let response = self.client.call_tool(&self.tool_name, args).await?;
        if let Some(err) = response.get("error") {
            return Err(format!("MCP tool error: {err}"));
        }
        let result = response.get("result").cloned().unwrap_or_default();
        let is_error = result
            .get("isError")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let text = tier_mcp_text(&self.name, render_content(result.get("content")));
        if is_error {
            Err(if text.is_empty() {
                "MCP tool failed".to_string()
            } else {
                text
            })
        } else {
            Ok(text)
        }
    }
}

/// Tag MCP text responses with the shared partial-output marker so the
/// model knows when it sees only the head of a long payload.
fn tier_mcp_text(tool_name: &str, raw: String) -> String {
    let chars = raw.chars().count();
    if chars <= INLINE_CAP_CHARS {
        return raw;
    }
    let head_chars = INLINE_CAP_CHARS / 2;
    let head: String = raw.chars().take(head_chars).collect();
    let notice = preview_partial(
        "mcp",
        chars,
        head_chars,
        "Re-call the tool with smaller `arguments` (e.g. add a limit/offset/pagination field) to fetch the rest.",
    );
    let prefixed = format!("{notice}{tool_name} (truncated head)\n");
    format!("{prefixed}{head}")
}
