//! Session-level MCP tool proxy.
//!
//! One [`McpProxy`] per tool of a connected MCP server, registered into the
//! session's registry under `mcp__{server}__{tool}` so builtin names never
//! collide. Execution forwards `tools/call` over JSON-RPC; results flagged
//! `isError` surface as tool errors.

use std::rc::Rc;

use agent_client_protocol as acp;

use super::{preview_partial, Tool, ToolCtx, INLINE_CAP_CHARS};
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

/// Read-only proxy for MCP `resources/list` with cursor pagination.
pub struct McpListResources {
    pub name: String,
    pub client: Rc<McpClient>,
}

#[async_trait::async_trait(?Send)]
impl Tool for McpListResources {
    fn name(&self) -> &str {
        &self.name
    }

    fn description(&self) -> &str {
        "List resources exposed by this MCP server. Pass nextCursor from the previous response to continue."
    }

    fn schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "cursor": { "type": "string", "description": "Opaque nextCursor from a previous page." }
            },
            "additionalProperties": false
        })
    }

    fn kind(&self) -> acp::ToolKind {
        acp::ToolKind::Read
    }

    fn read_only(&self) -> bool {
        true
    }

    async fn execute(&self, args: serde_json::Value, _ctx: &ToolCtx) -> Result<String, String> {
        let cursor = args
            .get("cursor")
            .and_then(|value| value.as_str())
            .map(str::to_string);
        let response = self.client.list_resources(cursor).await?;
        render_resource_response(&self.name, response)
    }
}

/// Read-only proxy for MCP `resources/read`.
pub struct McpReadResource {
    pub name: String,
    pub client: Rc<McpClient>,
}

/// Read-only proxy for MCP `resources/templates/list`.
pub struct McpListResourceTemplates {
    pub name: String,
    pub client: Rc<McpClient>,
}

#[async_trait::async_trait(?Send)]
impl Tool for McpListResourceTemplates {
    fn name(&self) -> &str {
        &self.name
    }

    fn description(&self) -> &str {
        "List URI templates exposed by this MCP server. Pass nextCursor to continue pagination."
    }

    fn schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "cursor": { "type": "string", "description": "Opaque nextCursor from a previous page." }
            },
            "additionalProperties": false
        })
    }

    fn kind(&self) -> acp::ToolKind {
        acp::ToolKind::Read
    }

    fn read_only(&self) -> bool {
        true
    }

    async fn execute(&self, args: serde_json::Value, _ctx: &ToolCtx) -> Result<String, String> {
        let cursor = args
            .get("cursor")
            .and_then(|value| value.as_str())
            .map(str::to_string);
        let response = self.client.list_resource_templates(cursor).await?;
        render_resource_response(&self.name, response)
    }
}

#[async_trait::async_trait(?Send)]
impl Tool for McpReadResource {
    fn name(&self) -> &str {
        &self.name
    }

    fn description(&self) -> &str {
        "Read one resource from this MCP server by its URI."
    }

    fn schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "uri": { "type": "string", "description": "Exact resource URI returned by resources_list." }
            },
            "required": ["uri"],
            "additionalProperties": false
        })
    }

    fn kind(&self) -> acp::ToolKind {
        acp::ToolKind::Read
    }

    fn read_only(&self) -> bool {
        true
    }

    async fn execute(&self, args: serde_json::Value, _ctx: &ToolCtx) -> Result<String, String> {
        let uri = args
            .get("uri")
            .and_then(|value| value.as_str())
            .filter(|uri| !uri.is_empty())
            .ok_or("missing required argument `uri`")?;
        let response = self.client.read_resource(uri).await?;
        render_resource_response(&self.name, response)
    }
}

fn render_resource_response(
    tool_name: &str,
    response: serde_json::Value,
) -> Result<String, String> {
    if let Some(error) = response.get("error") {
        return Err(format!("MCP resource error: {error}"));
    }
    let result = response.get("result").cloned().unwrap_or_default();
    let text = serde_json::to_string_pretty(&result)
        .map_err(|error| format!("failed to encode MCP resource response: {error}"))?;
    Ok(tier_mcp_text(tool_name, text))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resource_response_preserves_cursor_and_metadata() {
        let rendered = render_resource_response(
            "mcp__docs__resources_list",
            serde_json::json!({
                "result": {
                    "resources": [{"uri": "docs://guide", "mimeType": "text/markdown"}],
                    "nextCursor": "page-2"
                }
            }),
        )
        .unwrap();
        assert!(rendered.contains("docs://guide"));
        assert!(rendered.contains("text/markdown"));
        assert!(rendered.contains("page-2"));
    }

    #[test]
    fn resource_response_surfaces_json_rpc_error() {
        let error = render_resource_response(
            "mcp__docs__resources_read",
            serde_json::json!({"error": {"code": -32601, "message": "not supported"}}),
        )
        .unwrap_err();
        assert!(error.contains("not supported"));
    }
}
