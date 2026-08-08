//! Minimal MCP (Model Context Protocol) client.
//!
//! Reads `~/.nex/mcp.json` and `<cwd>/.nex/mcp.json` (Claude-compatible
//! `{"mcpServers": {"<name>": {"command", "args", "env", "url"}}}` layout; project
//! overrides global by name), connects each server (stdio via `command`, or
//! Streamable HTTP via `url` — `url` wins when both are set), performs the
//! JSON-RPC 2.0 handshake (`initialize` → `notifications/initialized` →
//! `tools/list`) and proxies `tools/call` for the harness.
//!
//! Failure policy: a single failing server degrades to a log entry — it never
//! blocks session creation. Dropping the last [`McpClient`] handle kills the
//! stdio child process (`kill_on_drop`) when present; HTTP clients have no child.

use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout};
use tokio::sync::Mutex;

/// Handshake (spawn/connect → initialize → tools/list) budget per server.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(20);
/// Per-`tools/call` response budget.
const CALL_TIMEOUT: Duration = Duration::from_secs(300);

/// A MCP server configuration from `mcp.json`.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub args: Vec<String>,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub env: HashMap<String, String>,
    /// Streamable HTTP endpoint (preferred over `command` when set).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    /// Extra HTTP headers for Streamable HTTP transports (e.g. Authorization).
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub headers: HashMap<String, String>,
}

/// The `mcp.json` file shape (Claude-compatible).
#[derive(Debug, Default, serde::Serialize, serde::Deserialize)]
struct McpFile {
    #[serde(rename = "mcpServers", default)]
    mcp_servers: HashMap<String, McpServerConfig>,
}

/// Settings-panel row for one global MCP server.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerInfo {
    pub name: String,
    pub command: Option<String>,
    pub args: Vec<String>,
    pub env: HashMap<String, String>,
    pub url: Option<String>,
    pub headers: HashMap<String, String>,
    pub enabled: bool,
    /// `global` for `~/.nex/mcp.json` entries.
    pub source: String,
}

/// Path to the user-global MCP config (`~/.nex/mcp.json`).
pub fn global_mcp_path() -> Option<std::path::PathBuf> {
    super::home::nex_home().map(|h| h.join("mcp.json"))
}

/// Lists servers from the global mcp.json (sorted by name).
pub fn list_global(disabled: &[String]) -> Vec<McpServerInfo> {
    let Some(path) = global_mcp_path() else {
        return Vec::new();
    };
    let mut map = HashMap::new();
    merge_file(&mut map, &path);
    let mut out: Vec<McpServerInfo> = map
        .into_iter()
        .map(|(name, cfg)| {
            let enabled = !disabled.iter().any(|d| d == &name);
            McpServerInfo {
                name,
                command: cfg.command,
                args: cfg.args,
                env: cfg.env,
                url: cfg.url,
                headers: cfg.headers,
                enabled,
                source: "global".to_string(),
            }
        })
        .collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

/// Inserts or replaces one server in the global mcp.json.
pub fn upsert_global(name: &str, config: McpServerConfig) -> Result<(), String> {
    let name = name.trim();
    if name.is_empty() || name.contains('/') || name.contains('\\') {
        return Err("invalid MCP server name".into());
    }
    let path = global_mcp_path().ok_or_else(|| "home directory unavailable".to_string())?;
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let mut file = read_file(&path);
    file.mcp_servers.insert(name.to_string(), config);
    write_file(&path, &file)
}

/// Removes one server from the global mcp.json.
pub fn delete_global(name: &str) -> Result<(), String> {
    let path = global_mcp_path().ok_or_else(|| "home directory unavailable".to_string())?;
    let mut file = read_file(&path);
    if file.mcp_servers.remove(name).is_none() {
        return Err(format!("MCP server `{name}` not found"));
    }
    write_file(&path, &file)
}

fn read_file(path: &Path) -> McpFile {
    let Ok(text) = std::fs::read_to_string(path) else {
        return McpFile::default();
    };
    serde_json::from_str(&text).unwrap_or_default()
}

fn write_file(path: &Path, file: &McpFile) -> Result<(), String> {
    let json = serde_json::to_vec_pretty(file).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| format!("failed to write {}: {e}", path.display()))
}

/// Loads the merged MCP configuration for a session working dir: global
/// `~/.nex/mcp.json` first, project `.nex/mcp.json` overriding same-name
/// entries. Malformed files are skipped with a log. Returns entries sorted by
/// name so tool specs are byte-stable.
pub fn load_configs(cwd: &Path) -> Vec<(String, McpServerConfig)> {
    let mut paths: Vec<std::path::PathBuf> = Vec::new();
    if let Some(home) = super::home::nex_home() {
        paths.push(home.join("mcp.json"));
    }
    paths.push(cwd.join(".nex").join("mcp.json"));
    merge_files(&paths)
}

/// Merges `mcp.json` files in order (later files win per name) and sorts the
/// result by name for a byte-stable tool catalog.
fn merge_files(paths: &[std::path::PathBuf]) -> Vec<(String, McpServerConfig)> {
    let mut merged: HashMap<String, McpServerConfig> = HashMap::new();
    for p in paths {
        merge_file(&mut merged, p);
    }
    let mut out: Vec<(String, McpServerConfig)> = merged.into_iter().collect();
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

fn merge_file(merged: &mut HashMap<String, McpServerConfig>, path: &Path) {
    let Ok(text) = std::fs::read_to_string(path) else {
        return;
    };
    let Ok(file) = serde_json::from_str::<McpFile>(&text) else {
        log::warn!("ignoring malformed MCP config {}", path.display());
        return;
    };
    for (name, cfg) in file.mcp_servers {
        merged.insert(name, cfg);
    }
}

/// One tool exposed by a connected server (from `tools/list`).
#[derive(Debug, Clone)]
pub struct McpToolInfo {
    pub name: String,
    pub description: String,
    pub schema: serde_json::Value,
}

/// Per-connection mutable transport state; guarded by the call mutex so
/// concurrent tool executions serialize their request/response cycles.
enum Transport {
    Stdio {
        stdin: Option<ChildStdin>,
        stdout: Option<BufReader<ChildStdout>>,
        next_id: u64,
    },
    Http {
        client: reqwest::Client,
        url: String,
        headers: HashMap<String, String>,
        session_id: Option<String>,
        next_id: u64,
    },
}

/// A connected MCP server (stdio or Streamable HTTP). Shared between the
/// session (lifecycle) and the per-session tool proxies (`Rc`); dropping the
/// last handle kills the stdio child when present.
pub struct McpClient {
    pub name: String,
    /// Stdio child only; `None` for HTTP transports.
    child: Option<Child>,
    transport: Arc<Mutex<Transport>>,
    pub tools: Vec<McpToolInfo>,
}

impl std::fmt::Debug for McpClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("McpClient")
            .field("name", &self.name)
            .field(
                "tools",
                &self
                    .tools
                    .iter()
                    .map(|t| t.name.as_str())
                    .collect::<Vec<_>>(),
            )
            .finish()
    }
}

impl McpClient {
    /// Connects `config` and performs the handshake. Prefer Streamable HTTP
    /// when `url` is set; otherwise spawn the stdio `command`. On error nothing
    /// keeps running (stdio children are dropped and killed).
    pub async fn connect(name: &str, config: &McpServerConfig) -> Result<Self, String> {
        if let Some(url) = config.url.as_deref().filter(|u| !u.is_empty()) {
            return Self::connect_http(name, url, &config.headers).await;
        }
        let Some(command) = &config.command else {
            return Err(format!("MCP server `{name}` has no `command`"));
        };
        Self::connect_stdio(name, command, config).await
    }

    async fn connect_http(
        name: &str,
        url: &str,
        headers: &HashMap<String, String>,
    ) -> Result<Self, String> {
        // No automatic redirects: MCP session headers / auth must not follow
        // off-origin Location targets silently.
        let client = reqwest::Client::builder()
            .timeout(CALL_TIMEOUT)
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|e| format!("failed to build HTTP client for MCP server `{name}`: {e}"))?;
        let transport = Arc::new(Mutex::new(Transport::Http {
            client,
            url: url.to_string(),
            headers: headers.clone(),
            session_id: None,
            next_id: 1,
        }));
        let mut mcp = Self {
            name: name.to_string(),
            child: None,
            transport: transport.clone(),
            tools: Vec::new(),
        };
        mcp.run_handshake(transport).await?;
        Ok(mcp)
    }

    async fn connect_stdio(
        name: &str,
        command: &str,
        config: &McpServerConfig,
    ) -> Result<Self, String> {
        let mut cmd = tokio::process::Command::new(command);
        cmd.args(&config.args)
            .envs(&config.env)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::inherit())
            .kill_on_drop(true);
        let mut child = cmd
            .spawn()
            .map_err(|e| format!("failed to spawn MCP server `{name}`: {e}"))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| format!("MCP server `{name}` has no stdin"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| format!("MCP server `{name}` has no stdout"))?;
        let transport = Arc::new(Mutex::new(Transport::Stdio {
            stdin: Some(stdin),
            stdout: Some(BufReader::new(stdout)),
            next_id: 1,
        }));
        let mut mcp = Self {
            name: name.to_string(),
            child: Some(child),
            transport: transport.clone(),
            tools: Vec::new(),
        };
        mcp.run_handshake(transport).await?;
        Ok(mcp)
    }

    async fn run_handshake(&mut self, transport: Arc<Mutex<Transport>>) -> Result<(), String> {
        let name = self.name.clone();
        let handshake = async {
            let mut t = transport.lock().await;
            let init = t
                .request(
                    1,
                    "initialize",
                    serde_json::json!({
                        "protocolVersion": "2025-06-18",
                        "capabilities": {},
                        "clientInfo": { "name": "nex", "version": env!("CARGO_PKG_VERSION") }
                    }),
                )
                .await?;
            if let Some(err) = init.get("error") {
                return Err(format!("initialize failed: {err}"));
            }
            t.notify("notifications/initialized", serde_json::json!({}))
                .await?;
            let listed = t.request(2, "tools/list", serde_json::json!({})).await?;
            if let Some(err) = listed.get("error") {
                return Err(format!("tools/list failed: {err}"));
            }
            // Reserve ids used by the handshake for subsequent tools/call.
            t.set_next_id(3);
            let tools = listed
                .pointer("/result/tools")
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default();
            let mut parsed = Vec::new();
            for tool in tools {
                parsed.push(McpToolInfo {
                    name: tool
                        .get("name")
                        .and_then(|v| v.as_str())
                        .unwrap_or_default()
                        .to_string(),
                    description: tool
                        .get("description")
                        .and_then(|v| v.as_str())
                        .unwrap_or_default()
                        .to_string(),
                    schema: tool
                        .get("inputSchema")
                        .cloned()
                        .unwrap_or_else(|| serde_json::json!({ "type": "object" })),
                });
            }
            Ok(parsed)
        };
        match tokio::time::timeout(HANDSHAKE_TIMEOUT, handshake).await {
            Ok(Ok(tools)) => {
                self.tools = tools;
                Ok(())
            }
            Ok(Err(e)) => Err(format!("MCP server `{name}` handshake failed: {e}")),
            Err(_) => Err(format!("MCP server `{name}` handshake timed out")),
        }
    }

    /// Forwards one `tools/call` to the server and returns the full JSON-RPC
    /// response object. Server notifications (e.g. logging) are skipped while
    /// waiting for the matching response id (stdio); HTTP returns one response
    /// body / first matching SSE event.
    pub async fn call_tool(
        &self,
        tool: &str,
        args: serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        tokio::time::timeout(CALL_TIMEOUT, async {
            let mut t = self.transport.lock().await;
            let id = t.alloc_id();
            t.request(
                id,
                "tools/call",
                serde_json::json!({
                    "name": tool,
                    "arguments": args,
                }),
            )
            .await
        })
        .await
        .map_err(|_| format!("MCP tool `{}` timed out", self.name))?
    }
}

impl Drop for McpClient {
    fn drop(&mut self) {
        // Session teardown: kill the stdio server child when present
        // (kill_on_drop is a second net in case the child handle is lost first).
        if let Some(mut child) = self.child.take() {
            let _ = child.start_kill();
        }
    }
}

impl Transport {
    fn alloc_id(&mut self) -> u64 {
        let next = match self {
            Self::Stdio { next_id, .. } | Self::Http { next_id, .. } => next_id,
        };
        let id = *next;
        *next += 1;
        id
    }

    fn set_next_id(&mut self, id: u64) {
        match self {
            Self::Stdio { next_id, .. } | Self::Http { next_id, .. } => *next_id = id,
        }
    }

    /// Sends a JSON-RPC request and returns the matching response object.
    async fn request(
        &mut self,
        id: u64,
        method: &str,
        params: serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        let payload = serde_json::json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });
        match self {
            Self::Stdio { .. } => {
                self.stdio_write_frame(&payload).await?;
                loop {
                    let msg = self.stdio_read_message().await?;
                    if msg.get("id").and_then(|v| v.as_u64()) == Some(id) {
                        return Ok(msg);
                    }
                    // Notifications are ignored while awaiting the response.
                }
            }
            Self::Http { .. } => self.http_round_trip(Some(id), &payload).await,
        }
    }

    /// Fire-and-forget JSON-RPC notification.
    async fn notify(&mut self, method: &str, params: serde_json::Value) -> Result<(), String> {
        let payload = serde_json::json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
        });
        match self {
            Self::Stdio { .. } => self.stdio_write_frame(&payload).await,
            Self::Http { .. } => {
                let _ = self.http_round_trip(None, &payload).await?;
                Ok(())
            }
        }
    }

    async fn stdio_write_frame(&mut self, payload: &serde_json::Value) -> Result<(), String> {
        let Self::Stdio { stdin, .. } = self else {
            return Err("not a stdio transport".into());
        };
        let body = serde_json::to_vec(payload).map_err(|e| e.to_string())?;
        let header = format!("Content-Length: {}\r\n\r\n", body.len());
        let stdin = stdin
            .as_mut()
            .ok_or_else(|| "MCP stdin closed".to_string())?;
        stdin
            .write_all(header.as_bytes())
            .await
            .map_err(|e| format!("MCP write failed: {e}"))?;
        stdin
            .write_all(&body)
            .await
            .map_err(|e| format!("MCP write failed: {e}"))?;
        stdin
            .flush()
            .await
            .map_err(|e| format!("MCP write failed: {e}"))?;
        Ok(())
    }

    /// Reads one complete JSON-RPC message (Content-Length framed).
    async fn stdio_read_message(&mut self) -> Result<serde_json::Value, String> {
        let Self::Stdio { stdout, .. } = self else {
            return Err("not a stdio transport".into());
        };
        let stdout = stdout
            .as_mut()
            .ok_or_else(|| "MCP stdout closed".to_string())?;
        let mut content_length: Option<usize> = None;
        loop {
            let mut line = String::new();
            let n = stdout
                .read_line(&mut line)
                .await
                .map_err(|e| format!("MCP read failed: {e}"))?;
            if n == 0 {
                return Err("MCP server closed the stream".to_string());
            }
            if line.trim().is_empty() {
                break;
            }
            if let Some(v) = line
                .to_ascii_lowercase()
                .trim()
                .strip_prefix("content-length:")
            {
                content_length = v.trim().parse::<usize>().ok();
            }
        }
        let len = content_length.ok_or_else(|| "missing Content-Length header".to_string())?;
        let mut body = vec![0u8; len];
        stdout
            .read_exact(&mut body)
            .await
            .map_err(|e| format!("MCP read failed: {e}"))?;
        serde_json::from_slice(&body).map_err(|e| format!("bad MCP JSON: {e}"))
    }

    /// POST one JSON-RPC message over Streamable HTTP.
    ///
    /// When `expect_id` is `Some`, parse the JSON / SSE body for a matching
    /// response. Notifications pass `None` and only require a successful HTTP
    /// status (empty / non-JSON bodies are tolerated).
    async fn http_round_trip(
        &mut self,
        expect_id: Option<u64>,
        payload: &serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        let Self::Http {
            client,
            url,
            headers,
            session_id,
            ..
        } = self
        else {
            return Err("not an HTTP transport".into());
        };
        let mut req = client
            .post(url.as_str())
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .header(
                reqwest::header::ACCEPT,
                "application/json, text/event-stream",
            )
            .json(payload);
        for (k, v) in headers.iter() {
            req = req.header(k.as_str(), v.as_str());
        }
        if let Some(sid) = session_id.as_deref() {
            req = req.header("Mcp-Session-Id", sid);
        }
        let resp = req
            .send()
            .await
            .map_err(|e| format!("MCP HTTP request failed: {e}"))?;

        if let Some(sid) = resp.headers().get("mcp-session-id") {
            if let Ok(s) = sid.to_str() {
                if !s.is_empty() {
                    *session_id = Some(s.to_string());
                }
            }
        }

        let status = resp.status();
        let content_type = resp
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_ascii_lowercase();
        let body = resp
            .text()
            .await
            .map_err(|e| format!("MCP HTTP read failed: {e}"))?;

        if !status.is_success() {
            return Err(format!("MCP HTTP {status}: {body}"));
        }

        let Some(id) = expect_id else {
            // Notification: accept empty / opaque success bodies.
            if body.trim().is_empty() {
                return Ok(serde_json::json!({}));
            }
            if content_type.contains("text/event-stream") {
                return Ok(serde_json::json!({}));
            }
            return serde_json::from_str(&body).or_else(|_| Ok(serde_json::json!({})));
        };

        if content_type.contains("text/event-stream") {
            parse_sse_jsonrpc(&body, id)
        } else {
            let msg: serde_json::Value =
                serde_json::from_str(&body).map_err(|e| format!("bad MCP HTTP JSON: {e}"))?;
            let got = msg.get("id").and_then(|v| v.as_u64());
            if got != Some(id) {
                return Err(format!(
                    "MCP HTTP JSON-RPC id mismatch: expected {id}, got {got:?}"
                ));
            }
            Ok(msg)
        }
    }
}

/// Parse the first SSE event whose JSON-RPC `id` matches.
///
/// Multi-line `data:` fields are concatenated (SSE spec) before JSON parse.
fn parse_sse_jsonrpc(body: &str, id: u64) -> Result<serde_json::Value, String> {
    let mut data_buf = String::new();

    for line in body.lines() {
        if line.is_empty() {
            if let Some(msg) = take_sse_jsonrpc_event(&mut data_buf, id) {
                return Ok(msg);
            }
            continue;
        }
        let trimmed = line.trim_end();
        if let Some(rest) = trimmed.strip_prefix("data:") {
            if !data_buf.is_empty() {
                data_buf.push('\n');
            }
            // SSE allows optional leading space after `data:`.
            data_buf.push_str(rest.strip_prefix(' ').unwrap_or(rest));
        }
        // Ignore other field names (event:, id:, retry:, comments).
    }
    if let Some(msg) = take_sse_jsonrpc_event(&mut data_buf, id) {
        return Ok(msg);
    }
    Err(format!(
        "no SSE JSON-RPC response with id {id} in event stream"
    ))
}

fn take_sse_jsonrpc_event(buf: &mut String, id: u64) -> Option<serde_json::Value> {
    if buf.is_empty() {
        return None;
    }
    let data = buf.trim();
    if data.is_empty() || data == "[DONE]" {
        buf.clear();
        return None;
    }
    let msg = serde_json::from_str::<serde_json::Value>(data).ok();
    buf.clear();
    msg.filter(|m| m.get("id").and_then(|v| v.as_u64()) == Some(id))
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;
    use std::rc::Rc;
    use std::time::Duration;

    use super::*;
    use crate::agent::native::tools::mcp::McpProxy;
    use crate::agent::native::tools::{ToolCtx, ToolRegistry};

    /// A JSON-RPC stdio server speaking MCP over Content-Length frames.
    const FAKE_SERVER: &str = r#"
import json, sys

def read_msg():
    headers = {}
    line = sys.stdin.buffer.readline()
    while line not in (b"\r\n", b"\n", b""):
        k, _, v = line.decode(errors="replace").partition(":")
        headers[k.strip().lower()] = v.strip()
        line = sys.stdin.buffer.readline()
    n = int(headers.get("content-length", "0") or 0)
    return json.loads(sys.stdin.buffer.read(n)) if n else {}

def write_msg(obj):
    body = json.dumps(obj).encode()
    sys.stdout.buffer.write(("Content-Length: %d\r\n\r\n" % len(body)).encode() + body)
    sys.stdout.buffer.flush()

while True:
    msg = read_msg()
    if not msg:
        break
    method = msg.get("method")
    rid = msg.get("id")
    if method == "notifications/initialized":
        continue
    if method == "initialize":
        write_msg({"jsonrpc": "2.0", "id": rid, "result": {
            "protocolVersion": "2025-06-18",
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "fake", "version": "1.0"}}})
    elif method == "tools/list":
        write_msg({"jsonrpc": "2.0", "id": rid, "result": {"tools": [
            {"name": "echo", "description": "Echo text back",
             "inputSchema": {"type": "object",
                             "properties": {"text": {"type": "string"}}}},
            {"name": "boom", "description": "Always fails",
             "inputSchema": {"type": "object", "properties": {}}}
        ]}})
    elif method == "tools/call":
        params = msg.get("params", {})
        if params.get("name") == "boom":
            write_msg({"jsonrpc": "2.0", "id": rid, "result": {
                "content": [{"type": "text", "text": "boom failed"}],
                "isError": True}})
        else:
            text = params.get("arguments", {}).get("text", "")
            write_msg({"jsonrpc": "2.0", "id": rid, "result": {
                "content": [{"type": "text", "text": "echo:" + text}],
                "isError": False}})
    else:
        write_msg({"jsonrpc": "2.0", "id": rid, "error": {
            "code": -32601, "message": "nope"}})
"#;

    /// Writes the fake server to a temp file; `None` when python3 is missing
    /// (the stdio round-trip tests then skip, like other env-dependent tests).
    fn fake_server_script(dir: &std::path::Path) -> Option<std::path::PathBuf> {
        if std::process::Command::new("python3")
            .arg("-c")
            .arg("pass")
            .output()
            .is_err()
        {
            return None;
        }
        let path = dir.join("fake_mcp_server.py");
        std::fs::write(&path, FAKE_SERVER).ok()?;
        Some(path)
    }

    #[test]
    fn merge_files_global_then_project_wins_and_sorts() {
        let tmp = tempfile::tempdir().unwrap();
        let global = tmp.path().join("global.json");
        let project = tmp.path().join("project.json");
        std::fs::write(
            &global,
            r#"{"mcpServers": {
                "zeta": {"command": "g-z", "args": ["a"]},
                "alpha": {"command": "g-a"}
            }}"#,
        )
        .unwrap();
        std::fs::write(
            &project,
            r#"{"mcpServers": {
                "alpha": {"command": "p-a", "env": {"K": "V"}},
                "beta": {"url": "https://x"}
            }}"#,
        )
        .unwrap();
        // Malformed files are skipped.
        std::fs::write(tmp.path().join("bad.json"), "not json").unwrap();

        let merged = merge_files(&[global, project, tmp.path().join("bad.json")]);
        let names: Vec<&str> = merged.iter().map(|(n, _)| n.as_str()).collect();
        assert_eq!(names, vec!["alpha", "beta", "zeta"]);
        // Project overrides global for `alpha`.
        assert_eq!(merged[0].1.command.as_deref(), Some("p-a"));
        // `url`-only servers are kept (connect() uses Streamable HTTP).
        assert_eq!(merged[1].1.url.as_deref(), Some("https://x"));
        assert_eq!(merged[1].1.command, None);
    }

    #[test]
    fn parse_sse_jsonrpc_picks_matching_id() {
        let body = "\
event: message\n\
data: {\"jsonrpc\":\"2.0\",\"method\":\"notifications/message\",\"params\":{}}\n\
\n\
data: {\"jsonrpc\":\"2.0\",\"id\":2,\"result\":{\"ok\":true}}\n\
\n\
data: {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"tools\":[]}}\n\
";
        let msg = parse_sse_jsonrpc(body, 1).expect("id=1");
        assert_eq!(msg.pointer("/result/tools").and_then(|v| v.as_array()).map(|a| a.len()), Some(0));
        let err = parse_sse_jsonrpc(body, 99).expect_err("missing id");
        assert!(err.contains("id 99"), "got: {err}");
    }

    #[test]
    fn parse_sse_jsonrpc_joins_multiline_data() {
        let body = "\
data: {\"jsonrpc\":\"2.0\",\"id\":1,\n\
data: \"result\":{\"ok\":true}}\n\
\n\
";
        let msg = parse_sse_jsonrpc(body, 1).expect("multiline");
        assert_eq!(msg.pointer("/result/ok").and_then(|v| v.as_bool()), Some(true));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn stdio_handshake_and_tool_call_round_trip() {
        let tmp = tempfile::tempdir().unwrap();
        let Some(script) = fake_server_script(tmp.path()) else {
            return;
        };
        let cfg = McpServerConfig {
            command: Some("python3".to_string()),
            args: vec![script.to_string_lossy().to_string()],
            env: HashMap::new(),
            url: None,
            headers: HashMap::new(),
        };
        let client = McpClient::connect("fake", &cfg).await.expect("handshake");
        let names: Vec<&str> = client.tools.iter().map(|t| t.name.as_str()).collect();
        assert_eq!(names, vec!["echo", "boom"]);

        // tools/call forwarding.
        let resp = client
            .call_tool("echo", serde_json::json!({ "text": "hi" }))
            .await
            .expect("call");
        assert_eq!(
            resp.pointer("/result/content/0/text")
                .and_then(|v| v.as_str()),
            Some("echo:hi")
        );

        // isError surfaces in the response for the proxy to turn into an error.
        let resp = client
            .call_tool("boom", serde_json::json!({}))
            .await
            .expect("call");
        assert_eq!(
            resp.pointer("/result/isError").and_then(|v| v.as_bool()),
            Some(true)
        );
    }

    /// The session-level proxy: registered under `mcp__{server}__{tool}` and
    /// surfaced through the registry; `isError` results become tool errors.
    #[tokio::test(flavor = "current_thread")]
    async fn mcp_proxy_registers_and_maps_iserror() {
        let tmp = tempfile::tempdir().unwrap();
        let Some(script) = fake_server_script(tmp.path()) else {
            return;
        };
        let cfg = McpServerConfig {
            command: Some("python3".to_string()),
            args: vec![script.to_string_lossy().to_string()],
            env: HashMap::new(),
            url: None,
            headers: HashMap::new(),
        };
        let client = Rc::new(McpClient::connect("fake", &cfg).await.expect("handshake"));

        let mut registry = ToolRegistry::builtins();
        for info in &client.tools {
            registry.add(Box::new(McpProxy {
                name: format!("mcp__fake__{}", info.name),
                server: "fake".to_string(),
                tool_name: info.name.clone(),
                description: info.description.clone(),
                schema: info.schema.clone(),
                client: client.clone(),
            }));
        }
        let proxy = registry.get("mcp__fake__echo").expect("registered");
        assert!(
            !proxy.read_only(),
            "MCP tools must go through permission flow"
        );
        assert!(registry.get("mcp__fake__boom").is_some());

        let ctx = ToolCtx {
            cwd: std::env::temp_dir(),
            bash_timeout: Duration::from_secs(5),
            archive_dir: std::env::temp_dir(),
            jobs: Rc::new(RefCell::new(
                crate::agent::native::tools::jobs::JobTable::default(),
            )),
            harness: None,
            mutations: Rc::new(RefCell::new(Vec::new())),
            mode_id: None,
        };
        let ok = proxy
            .execute(serde_json::json!({ "text": "yo" }), &ctx)
            .await
            .expect("echo ok");
        assert!(ok.contains("echo:yo"));
        let err = registry
            .get("mcp__fake__boom")
            .unwrap()
            .execute(serde_json::json!({}), &ctx)
            .await
            .expect_err("isError must become a tool error");
        assert!(err.contains("boom failed"));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn url_servers_attempt_http_not_unsupported() {
        // Unreachable local port: exercises the HTTP path without needing the
        // network (connection refused / handshake failure).
        let cfg = McpServerConfig {
            command: Some("should-not-spawn".to_string()),
            args: vec![],
            env: HashMap::new(),
            url: Some("http://127.0.0.1:9".to_string()),
            headers: HashMap::new(),
        };
        let err = McpClient::connect("http", &cfg)
            .await
            .expect_err("must fail");
        assert!(
            !err.contains("not supported"),
            "url servers must use HTTP, got: {err}"
        );
        assert!(
            err.contains("handshake failed")
                || err.contains("timed out")
                || err.contains("HTTP"),
            "got: {err}"
        );
        // Prefer url over command: failure must be HTTP, not spawn.
        assert!(!err.contains("failed to spawn"), "got: {err}");

        let err = McpClient::connect(
            "none",
            &McpServerConfig {
                command: None,
                args: vec![],
                env: HashMap::new(),
                url: None,
                headers: HashMap::new(),
            },
        )
        .await
        .expect_err("must fail");
        assert!(err.contains("no `command`"), "got: {err}");
    }
}
