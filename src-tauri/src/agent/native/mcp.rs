//! Minimal MCP (Model Context Protocol) client.
//!
//! Reads global `~/.nex/mcp.json` plus project-local `.nex/mcp.json` files
//! (Claude-compatible `{"mcpServers": {"<name>": {"command", "args", "env",
//! "url"}}}` layout). Project entries are executable configuration, so they
//! are only connected after a user explicitly trusts that server for the
//! exact config-file hash. Trusted project entries override global entries by
//! name; untrusted ones remain visible in Settings but have no runtime effect.
//! Connected servers use stdio via `command`, or Streamable HTTP via `url`
//! (`url` wins), perform the JSON-RPC 2.0 handshake (`initialize` →
//! `notifications/initialized` → `tools/list`), and proxy `tools/call` for
//! the harness.
//!
//! Failure policy: a single failing server degrades to a log entry — it never
//! blocks session creation. Dropping the last [`McpClient`] handle kills the
//! stdio child *process group* (`process_tree`) when present so wrappers like
//! `uvx` cannot leave a Python grandchild behind; HTTP clients have no child.

use std::collections::HashMap;
use std::ffi::OsString;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use sha2::{Digest, Sha256};
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout};
use tokio::sync::Mutex;

use super::config::ProjectMcpApproval;

/// Handshake (spawn/connect → initialize → tools/list) budget per server.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(20);
/// Per-`tools/call` response budget.
const CALL_TIMEOUT: Duration = Duration::from_secs(300);
/// Largest complete MCP JSON-RPC message accepted from either transport.
/// Stdio servers and HTTP endpoints are configured code, not trusted input.
const MAX_MCP_MESSAGE_BYTES: usize = 8 * 1024 * 1024;
/// Header lines are much smaller than JSON bodies and get a separate cap so a
/// server cannot consume memory by omitting the frame terminator.
const MAX_MCP_HEADER_BYTES: usize = 16 * 1024;

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
    /// `global` for `~/.nex/mcp.json`, `project` for `<cwd>/.nex/mcp.json`.
    pub source: String,
}

#[derive(Debug, Clone)]
struct ProjectMcpConfig {
    project_path: String,
    config_hash: String,
    mcp_servers: HashMap<String, McpServerConfig>,
}

/// Path to the user-global MCP config (`~/.nex/mcp.json`).
pub fn global_mcp_path() -> Option<std::path::PathBuf> {
    super::home::nex_home().map(|h| h.join("mcp.json"))
}

/// Path to a project-local MCP config.
pub fn project_mcp_path(cwd: &Path) -> PathBuf {
    cwd.join(".nex").join("mcp.json")
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

/// Lists global servers and (when `cwd` is supplied) all project servers.
/// Project rows are intentionally returned even when disabled/untrusted so
/// users can inspect what a repository is asking Nex to execute.
pub fn list_servers(
    cwd: Option<&Path>,
    disabled_global: &[String],
    approvals: &[ProjectMcpApproval],
) -> Vec<McpServerInfo> {
    let mut out = list_global(disabled_global);
    let Some(cwd) = cwd else {
        return out;
    };
    match read_project_config(cwd) {
        Ok(Some(project)) => {
            out.extend(project.mcp_servers.into_iter().map(|(name, cfg)| {
                let enabled = is_project_approved(
                    approvals,
                    &project.project_path,
                    &project.config_hash,
                    &name,
                );
                McpServerInfo {
                    name,
                    command: cfg.command,
                    args: cfg.args,
                    env: cfg.env,
                    url: cfg.url,
                    headers: cfg.headers,
                    enabled,
                    source: "project".to_string(),
                }
            }));
        }
        Ok(None) => {}
        Err(e) => log::warn!("ignoring project MCP config: {e}"),
    }
    out.sort_by(|a, b| a.source.cmp(&b.source).then_with(|| a.name.cmp(&b.name)));
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
    let mut options = std::fs::OpenOptions::new();
    options.create(true).write(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut output = options
        .open(path)
        .map_err(|e| format!("failed to open {}: {e}", path.display()))?;
    output
        .write_all(&json)
        .map_err(|e| format!("failed to write {}: {e}", path.display()))?;
    output
        .sync_all()
        .map_err(|e| format!("failed to flush {}: {e}", path.display()))?;
    #[cfg(unix)]
    std::fs::set_permissions(path, {
        use std::os::unix::fs::PermissionsExt;
        std::fs::Permissions::from_mode(0o600)
    })
    .map_err(|e| format!("failed to protect {}: {e}", path.display()))?;
    Ok(())
}

/// Loads the runtime MCP configuration for a session. Global servers retain
/// their existing enable/disable setting. Project entries are merged only
/// when their path, server name, and exact config hash match an explicit
/// approval; an untrusted project entry therefore cannot shadow a global one.
pub fn load_configs(
    cwd: &Path,
    disabled_global: &[String],
    approvals: &[ProjectMcpApproval],
) -> Vec<(String, McpServerConfig)> {
    let mut merged: HashMap<String, McpServerConfig> = HashMap::new();
    if let Some(path) = global_mcp_path() {
        let mut global = HashMap::new();
        merge_file(&mut global, &path);
        for (name, cfg) in global {
            if !disabled_global.iter().any(|disabled| disabled == &name) {
                merged.insert(name, cfg);
            }
        }
    }

    match read_project_config(cwd) {
        Ok(Some(project)) => merge_approved_project_configs(&mut merged, project, approvals),
        Ok(None) => {}
        Err(e) => log::warn!("ignoring project MCP config: {e}"),
    }

    let mut out: Vec<(String, McpServerConfig)> = merged.into_iter().collect();
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

fn merge_approved_project_configs(
    merged: &mut HashMap<String, McpServerConfig>,
    project: ProjectMcpConfig,
    approvals: &[ProjectMcpApproval],
) {
    for (name, cfg) in project.mcp_servers {
        if is_project_approved(
            approvals,
            &project.project_path,
            &project.config_hash,
            &name,
        ) {
            merged.insert(name, cfg);
        }
    }
}

/// Gets the current project identity and named server. Used by Settings to
/// record a trust decision, and never by the session loader directly.
pub fn project_server(cwd: &Path, name: &str) -> Result<(String, String, McpServerConfig), String> {
    let project =
        read_project_config(cwd)?.ok_or_else(|| "project MCP config not found".to_string())?;
    let server = project
        .mcp_servers
        .get(name)
        .cloned()
        .ok_or_else(|| format!("project MCP server `{name}` not found"))?;
    Ok((project.project_path, project.config_hash, server))
}

/// Resolves a settings probe to a server that is actually allowed to connect.
/// This repeats the runtime trust check so a direct frontend command cannot
/// turn an untrusted repository config into a process spawn.
pub fn configured_server(
    cwd: Option<&Path>,
    source: &str,
    name: &str,
    disabled_global: &[String],
    approvals: &[ProjectMcpApproval],
) -> Result<McpServerConfig, String> {
    match source {
        "global" => {
            if disabled_global.iter().any(|disabled| disabled == name) {
                return Err(format!("global MCP server `{name}` is disabled"));
            }
            let path = global_mcp_path().ok_or_else(|| "home directory unavailable".to_string())?;
            read_file(&path)
                .mcp_servers
                .remove(name)
                .ok_or_else(|| format!("global MCP server `{name}` not found"))
        }
        "project" => {
            let cwd = cwd.ok_or_else(|| "project path is required for project MCP".to_string())?;
            let (project_path, config_hash, server) = project_server(cwd, name)?;
            if !is_project_approved(approvals, &project_path, &config_hash, name) {
                return Err(format!(
                    "project MCP server `{name}` requires explicit approval before it can connect"
                ));
            }
            Ok(server)
        }
        _ => Err(format!("unknown MCP source `{source}`")),
    }
}

fn is_project_approved(
    approvals: &[ProjectMcpApproval],
    project_path: &str,
    config_hash: &str,
    name: &str,
) -> bool {
    approvals.iter().any(|approval| {
        approval.project_path == project_path
            && approval.config_hash == config_hash
            && approval.server_name == name
    })
}

fn read_project_config(cwd: &Path) -> Result<Option<ProjectMcpConfig>, String> {
    let project_path = std::fs::canonicalize(cwd)
        .map_err(|e| format!("failed to resolve project path {}: {e}", cwd.display()))?;
    if !project_path.is_dir() {
        return Err(format!(
            "project path {} is not a directory",
            project_path.display()
        ));
    }
    let path = project_mcp_path(&project_path);
    let bytes = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("failed to read {}: {e}", path.display())),
    };
    let file: McpFile = serde_json::from_slice(&bytes)
        .map_err(|e| format!("malformed MCP config {}: {e}", path.display()))?;
    Ok(Some(ProjectMcpConfig {
        project_path: project_path.to_string_lossy().into_owned(),
        config_hash: format!("{:x}", Sha256::digest(&bytes)),
        mcp_servers: file.mcp_servers,
    }))
}

/// Merges `mcp.json` files in order (later files win per name) and sorts the
/// result by name for a byte-stable tool catalog.
#[cfg(test)]
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
        /// Login-shell/project environment used to resolve `${NAME}` header
        /// references. GUI apps frequently do not inherit the user's shell
        /// environment, so consulting only `std::env` is insufficient.
        header_env: HashMap<String, String>,
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
    /// Server advertised MCP resource support during initialize.
    pub supports_resources: bool,
    /// Server advertised resource templates (part of the resources capability).
    pub supports_resource_templates: bool,
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
            .field("supports_resources", &self.supports_resources)
            .field(
                "supports_resource_templates",
                &self.supports_resource_templates,
            )
            .finish()
    }
}

/// Validates an MCP HTTP endpoint for SSRF safety:
/// - only `http`/`https` schemes are accepted (no `file:`, `ftp:`, …);
/// - literal link-local (169.254.0.0/16 — the cloud-metadata namespace),
///   unspecified (0.0.0.0/::) and multicast addresses are refused;
/// - loopback and RFC1918 ranges stay allowed — local MCP servers commonly
///   run on `localhost` or an intranet host.
///
/// Note: hostnames that *resolve* to link-local (e.g. `metadata.internal`)
/// are not caught here; that would require a DNS hook on the client.
fn validate_mcp_url(raw: &str) -> Result<(), String> {
    let parsed = reqwest::Url::parse(raw).map_err(|e| format!("invalid MCP url `{raw}`: {e}"))?;
    match parsed.scheme() {
        "http" | "https" => {}
        other => {
            return Err(format!(
                "MCP url scheme `{other}` not allowed (http/https only)"
            ))
        }
    }
    let Some(host) = parsed.host_str() else {
        return Err("MCP url has no host".to_string());
    };
    if host.is_empty() {
        return Err("MCP url has no host".to_string());
    }
    if let Ok(ip) = host.parse::<std::net::IpAddr>() {
        let blocked = match ip {
            std::net::IpAddr::V4(v4) => {
                v4.is_link_local() || v4.is_unspecified() || v4.is_multicast()
            }
            std::net::IpAddr::V6(v6) => {
                // `is_unicast_link_local` is stable only since Rust 1.84; the
                // project MSRV is 1.77, so test fe80::/10 by hand.
                let link_local = v6.segments()[0] & 0xffc0 == 0xfe80;
                link_local || v6.is_unspecified() || v6.is_multicast()
            }
        };
        if blocked {
            return Err(format!("MCP url host `{host}` is not allowed"));
        }
    }
    Ok(())
}

fn resolve_command(
    command: &str,
    config: &McpServerConfig,
    base_env: &HashMap<String, String>,
) -> OsString {
    let candidate = PathBuf::from(command);
    if candidate.components().count() > 1 || candidate.is_absolute() {
        return candidate.into_os_string();
    }

    let path = config
        .env
        .get("PATH")
        .or_else(|| config.env.get("Path"))
        .cloned()
        .or_else(|| base_env.get("PATH").cloned())
        .or_else(|| base_env.get("Path").cloned())
        .map(OsString::from)
        .or_else(|| std::env::var_os("PATH"));

    which::which_in(command, path, Path::new("/"))
        .map(|p| p.into_os_string())
        .unwrap_or_else(|_| OsString::from(command))
}

impl McpClient {
    /// Connects `config` and performs the handshake. Prefer Streamable HTTP
    /// when `url` is set; otherwise spawn the stdio `command`. On error nothing
    /// keeps running (stdio children are dropped and killed).
    pub async fn connect(name: &str, config: &McpServerConfig) -> Result<Self, String> {
        Self::connect_with_base_env(name, config, &HashMap::new()).await
    }

    pub async fn connect_with_base_env(
        name: &str,
        config: &McpServerConfig,
        base_env: &HashMap<String, String>,
    ) -> Result<Self, String> {
        if let Some(url) = config.url.as_deref().filter(|u| !u.is_empty()) {
            return Self::connect_http(name, url, &config.headers, base_env).await;
        }
        let Some(command) = &config.command else {
            return Err(format!("MCP server `{name}` has no `command`"));
        };
        Self::connect_stdio(name, command, config, base_env).await
    }

    async fn connect_http(
        name: &str,
        url: &str,
        headers: &HashMap<String, String>,
        base_env: &HashMap<String, String>,
    ) -> Result<Self, String> {
        validate_mcp_url(url)?;
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
            header_env: base_env.clone(),
            session_id: None,
            next_id: 1,
        }));
        let mut mcp = Self {
            name: name.to_string(),
            child: None,
            transport: transport.clone(),
            tools: Vec::new(),
            supports_resources: false,
            supports_resource_templates: false,
        };
        mcp.run_handshake(transport).await?;
        Ok(mcp)
    }

    async fn connect_stdio(
        name: &str,
        command: &str,
        config: &McpServerConfig,
        base_env: &HashMap<String, String>,
    ) -> Result<Self, String> {
        let command = resolve_command(command, config, base_env);
        let mut cmd = tokio::process::Command::new(&command);
        cmd.args(&config.args)
            .envs(base_env)
            .envs(&config.env)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::inherit())
            .kill_on_drop(true);
        // `uvx` / `uv` / `pipx` keep a wrapper as the direct child and run
        // the real server (often Python 3.12) as a grandchild. Without a
        // dedicated process group, Drop only kills the wrapper.
        crate::agent::process_tree::configure_new_group(&mut cmd);
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
            supports_resources: false,
            supports_resource_templates: false,
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
            let supports_resources = init.pointer("/result/capabilities/resources").is_some();
            let supports_resource_templates = supports_resources;
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
            Ok((parsed, supports_resources, supports_resource_templates))
        };
        match tokio::time::timeout(HANDSHAKE_TIMEOUT, handshake).await {
            Ok(Ok((tools, supports_resources, supports_resource_templates))) => {
                self.tools = tools;
                self.supports_resources = supports_resources;
                self.supports_resource_templates = supports_resource_templates;
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

    /// Lists one page of resources exposed by the server. The raw MCP result
    /// is retained so callers can preserve annotations, MIME types and cursor.
    pub async fn list_resources(
        &self,
        cursor: Option<String>,
    ) -> Result<serde_json::Value, String> {
        let mut params = serde_json::json!({});
        if let Some(cursor) = cursor.filter(|cursor| !cursor.is_empty()) {
            params["cursor"] = serde_json::Value::String(cursor);
        }
        self.request("resources/list", params, "resources/list")
            .await
    }

    /// Reads one MCP resource by URI.
    pub async fn read_resource(&self, uri: &str) -> Result<serde_json::Value, String> {
        self.request(
            "resources/read",
            serde_json::json!({ "uri": uri }),
            "resources/read",
        )
        .await
    }

    /// Lists one page of URI templates exposed by the server.
    pub async fn list_resource_templates(
        &self,
        cursor: Option<String>,
    ) -> Result<serde_json::Value, String> {
        let mut params = serde_json::json!({});
        if let Some(cursor) = cursor.filter(|cursor| !cursor.is_empty()) {
            params["cursor"] = serde_json::Value::String(cursor);
        }
        self.request(
            "resources/templates/list",
            params,
            "resources/templates/list",
        )
        .await
    }

    async fn request(
        &self,
        method: &str,
        params: serde_json::Value,
        label: &str,
    ) -> Result<serde_json::Value, String> {
        tokio::time::timeout(CALL_TIMEOUT, async {
            let mut transport = self.transport.lock().await;
            let id = transport.alloc_id();
            transport.request(id, method, params).await
        })
        .await
        .map_err(|_| format!("MCP {label} timed out for `{}`", self.name))?
    }
}

impl Drop for McpClient {
    fn drop(&mut self) {
        // Session teardown: kill the stdio server *tree* when present.
        // `start_kill` / `kill_on_drop` only cover the direct child.
        if let Some(mut child) = self.child.take() {
            crate::agent::process_tree::kill_tree_sync(&mut child);
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
        let mut body = serde_json::to_vec(payload).map_err(|e| e.to_string())?;
        body.push(b'\n');
        let stdin = stdin
            .as_mut()
            .ok_or_else(|| "MCP stdin closed".to_string())?;
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

    /// Reads one complete JSON-RPC message from stdio. Supports both
    /// newline-delimited JSON (current MCP SDK stdio transport) and
    /// legacy `Content-Length` framed messages.
    async fn stdio_read_message(&mut self) -> Result<serde_json::Value, String> {
        let Self::Stdio { stdout, .. } = self else {
            return Err("not a stdio transport".into());
        };
        let stdout = stdout
            .as_mut()
            .ok_or_else(|| "MCP stdout closed".to_string())?;
        let Some(first_line) = read_limited_line(stdout, MAX_MCP_MESSAGE_BYTES).await? else {
            return Err("MCP server closed the stream".to_string());
        };
        let first_line = String::from_utf8(first_line)
            .map_err(|_| "MCP frame header is not valid UTF-8".to_string())?;

        if let Some(msg) = parse_stdio_line_message(&first_line)? {
            return Ok(msg);
        }
        if first_line.len() > MAX_MCP_HEADER_BYTES {
            return Err(format!(
                "MCP frame header exceeds {} byte limit",
                MAX_MCP_HEADER_BYTES
            ));
        }

        let mut content_length = parse_content_length(&first_line);
        let mut header_bytes = first_line.len();
        loop {
            let remaining = MAX_MCP_HEADER_BYTES.saturating_sub(header_bytes);
            let Some(line) = read_limited_line(stdout, remaining).await? else {
                return Err("MCP server closed the stream".to_string());
            };
            header_bytes = header_bytes.saturating_add(line.len());
            let line = String::from_utf8(line)
                .map_err(|_| "MCP frame header is not valid UTF-8".to_string())?;
            if line.trim().is_empty() {
                break;
            }
            if let Some(len) = parse_content_length(&line) {
                content_length = Some(len);
            }
        }
        let len = content_length.ok_or_else(|| "missing Content-Length header".to_string())?;
        if len > MAX_MCP_MESSAGE_BYTES {
            return Err(format!(
                "MCP Content-Length {len} exceeds {} byte limit",
                MAX_MCP_MESSAGE_BYTES
            ));
        }
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
            header_env,
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
            let value = resolve_header_value(v, header_env)?;
            req = req.header(k.as_str(), value);
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
        let body = read_http_body_limited(resp).await?;

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

/// Header values may reference a process/project environment variable as
/// `${NAME}`. This is especially useful for OAuth bearer tokens: mcp.json
/// stores only `"Authorization": "Bearer ${MCP_ACCESS_TOKEN}"`.
fn resolve_header_value(raw: &str, env: &HashMap<String, String>) -> Result<String, String> {
    let mut out = String::with_capacity(raw.len());
    let mut rest = raw;
    while let Some(start) = rest.find("${") {
        out.push_str(&rest[..start]);
        let tail = &rest[start + 2..];
        let Some(end) = tail.find('}') else {
            return Err("unterminated MCP header environment reference".to_string());
        };
        let name = &tail[..end];
        if name.is_empty() || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
            return Err(format!("invalid MCP header environment variable `{name}`"));
        }
        let value = env
            .get(name)
            .cloned()
            .or_else(|| std::env::var(name).ok())
            .ok_or_else(|| format!("MCP header requires environment variable `{name}`"))?;
        out.push_str(&value);
        rest = &tail[end + 1..];
    }
    out.push_str(rest);
    Ok(out)
}

/// Read one newline-terminated frame/header line without allocating beyond
/// `limit`. `AsyncBufReadExt::read_line` has no receive cap and would let a
/// malicious stdio server grow a `String` until memory exhaustion.
async fn read_limited_line<R>(reader: &mut R, limit: usize) -> Result<Option<Vec<u8>>, String>
where
    R: AsyncBufRead + Unpin,
{
    let mut line = Vec::new();
    loop {
        let consumed = {
            let buf = reader
                .fill_buf()
                .await
                .map_err(|e| format!("MCP read failed: {e}"))?;
            if buf.is_empty() {
                if line.is_empty() {
                    return Ok(None);
                }
                return Err("MCP server closed mid-frame".to_string());
            }
            let take = buf
                .iter()
                .position(|byte| *byte == b'\n')
                .map(|pos| pos + 1)
                .unwrap_or(buf.len());
            if line.len().saturating_add(take) > limit {
                return Err(format!("MCP line exceeds {limit} byte limit"));
            }
            line.extend_from_slice(&buf[..take]);
            take
        };
        reader.consume(consumed);
        if line.last() == Some(&b'\n') {
            return Ok(Some(line));
        }
    }
}

fn parse_content_length(line: &str) -> Option<usize> {
    line.trim()
        .split_once(':')
        .filter(|(name, _)| name.eq_ignore_ascii_case("content-length"))
        .and_then(|(_, value)| value.trim().parse::<usize>().ok())
}

/// Bounded HTTP body receive for JSON and SSE MCP transports. Content-Length
/// is merely an early rejection hint; chunked bodies are counted while read.
async fn read_http_body_limited(mut resp: reqwest::Response) -> Result<String, String> {
    if let Some(length) = resp.content_length() {
        if length > MAX_MCP_MESSAGE_BYTES as u64 {
            return Err(format!(
                "MCP HTTP response Content-Length {length} exceeds {} byte limit",
                MAX_MCP_MESSAGE_BYTES
            ));
        }
    }
    let mut body = Vec::new();
    while let Some(chunk) = resp
        .chunk()
        .await
        .map_err(|e| format!("MCP HTTP read failed: {e}"))?
    {
        if body.len().saturating_add(chunk.len()) > MAX_MCP_MESSAGE_BYTES {
            return Err(format!(
                "MCP HTTP response exceeds {} byte limit",
                MAX_MCP_MESSAGE_BYTES
            ));
        }
        body.extend_from_slice(&chunk);
    }
    String::from_utf8(body).map_err(|_| "MCP HTTP response is not valid UTF-8".to_string())
}

fn parse_stdio_line_message(line: &str) -> Result<Option<serde_json::Value>, String> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    if trimmed.starts_with('{') {
        return serde_json::from_str(trimmed)
            .map(Some)
            .map_err(|e| format!("bad MCP JSON: {e}"));
    }
    Ok(None)
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

    /// A JSON-RPC stdio server speaking MCP over newline-delimited JSON.
    const FAKE_SERVER: &str = r#"
import json, sys

def read_msg():
    line = sys.stdin.buffer.readline()
    if not line:
        return {}
    return json.loads(line)

def write_msg(obj):
    body = json.dumps(obj).encode()
    sys.stdout.buffer.write(body + b"\n")
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
    /// Checks the probe's *exit status*, not just spawn success — the Windows
    /// App Execution Alias stub for python3 spawns fine but exits non-zero.
    fn fake_server_script(dir: &std::path::Path) -> Option<std::path::PathBuf> {
        let probe = std::process::Command::new("python3")
            .arg("-c")
            .arg("pass")
            .output()
            .ok()?;
        if !probe.status.success() {
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
    fn project_mcp_requires_exact_explicit_approval() {
        let tmp = tempfile::tempdir().unwrap();
        let project_dir = tmp.path().join("project");
        std::fs::create_dir_all(project_dir.join(".nex")).unwrap();
        let project_file = project_mcp_path(&project_dir);
        std::fs::write(
            &project_file,
            r#"{"mcpServers":{"shadow":{"command":"project-command"},"only-project":{"command":"never-spawn-until-approved"}}}"#,
        )
        .unwrap();
        let project = read_project_config(&project_dir).unwrap().unwrap();

        // A repo config cannot shadow an enabled global server before a user
        // approves it. This is the map session setup uses before it considers
        // spawning a stdio MCP process.
        let mut runtime = HashMap::from([(
            "shadow".to_string(),
            McpServerConfig {
                command: Some("global-command".to_string()),
                args: Vec::new(),
                env: HashMap::new(),
                url: None,
                headers: HashMap::new(),
            },
        )]);
        merge_approved_project_configs(&mut runtime, project.clone(), &[]);
        assert_eq!(
            runtime.get("shadow").and_then(|cfg| cfg.command.as_deref()),
            Some("global-command")
        );
        assert!(!runtime.contains_key("only-project"));
        assert!(
            configured_server(Some(&project_dir), "project", "only-project", &[], &[])
                .unwrap_err()
                .contains("requires explicit approval")
        );

        let approvals = vec![ProjectMcpApproval {
            project_path: project.project_path.clone(),
            config_hash: project.config_hash.clone(),
            server_name: "shadow".to_string(),
        }];
        merge_approved_project_configs(&mut runtime, project.clone(), &approvals);
        assert_eq!(
            runtime.get("shadow").and_then(|cfg| cfg.command.as_deref()),
            Some("project-command")
        );

        // Editing any part of the file changes the hash and immediately
        // invalidates even a previously approved server.
        std::fs::write(
            &project_file,
            r#"{"mcpServers":{"shadow":{"command":"changed-command"}}}"#,
        )
        .unwrap();
        let changed = read_project_config(&project_dir).unwrap().unwrap();
        let mut after_change = HashMap::new();
        merge_approved_project_configs(&mut after_change, changed, &approvals);
        assert!(after_change.is_empty());
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
        assert_eq!(
            msg.pointer("/result/tools")
                .and_then(|v| v.as_array())
                .map(|a| a.len()),
            Some(0)
        );
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
        assert_eq!(
            msg.pointer("/result/ok").and_then(|v| v.as_bool()),
            Some(true)
        );
    }

    #[test]
    fn parse_stdio_line_message_parses_newline_json() {
        let msg =
            parse_stdio_line_message("{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"ok\":true}}\n")
                .unwrap()
                .expect("json line");
        assert_eq!(msg.get("id").and_then(|v| v.as_u64()), Some(1));
        assert_eq!(
            msg.pointer("/result/ok").and_then(|v| v.as_bool()),
            Some(true)
        );
    }

    #[tokio::test]
    async fn bounded_stdio_lines_reject_oversized_input_before_allocation() {
        let (mut writer, reader) = tokio::io::duplex(128);
        writer.write_all(b"0123456789\n").await.unwrap();
        drop(writer);
        let mut reader = BufReader::new(reader);
        let err = read_limited_line(&mut reader, 8).await.unwrap_err();
        assert!(err.contains("exceeds 8 byte limit"), "got: {err}");
    }

    #[test]
    fn content_length_parser_is_case_insensitive_and_strict() {
        assert_eq!(parse_content_length("Content-Length: 42\r\n"), Some(42));
        assert_eq!(parse_content_length("content-length: 7"), Some(7));
        assert_eq!(parse_content_length("Content-Length: nope"), None);
        assert_eq!(parse_content_length("Other: 42"), None);
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
            shell_sandbox: crate::agent::native::config::ShellSandboxMode::ApprovalOnly,
            path_env: std::env::var_os("PATH").unwrap_or_default(),
            archive_dir: std::env::temp_dir(),
            jobs: Rc::new(RefCell::new(
                crate::agent::native::tools::jobs::JobTable::default(),
            )),
            harness: None,
            mutations: Rc::new(RefCell::new(Vec::new())),
            mode_id: None,
            memory: crate::agent::native::tools::test_memory_handle(),
            graph: None,
            conn: None,
            session_id: None,
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
            err.contains("handshake failed") || err.contains("timed out") || err.contains("HTTP"),
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

    #[test]
    fn validate_mcp_url_allows_safe_endpoints() {
        assert!(validate_mcp_url("https://api.example.com/mcp").is_ok());
        assert!(validate_mcp_url("http://127.0.0.1:3000/mcp").is_ok());
        assert!(validate_mcp_url("http://localhost:8080/sse").is_ok());
        assert!(validate_mcp_url("http://192.168.1.10/mcp").is_ok());
        assert!(validate_mcp_url("http://10.0.0.5/mcp").is_ok());
    }

    #[test]
    fn validate_mcp_url_rejects_unsafe_endpoints() {
        // Cloud metadata namespace.
        assert!(validate_mcp_url("http://169.254.169.254/latest/meta-data").is_err());
        assert!(validate_mcp_url("http://169.254.170.2/credentials").is_err());
        // Unspecified / multicast.
        assert!(validate_mcp_url("http://0.0.0.0:80/").is_err());
        assert!(validate_mcp_url("http://224.0.0.1:80/").is_err());
        // Non-http schemes.
        assert!(validate_mcp_url("file:///etc/passwd").is_err());
        assert!(validate_mcp_url("ftp://example.com/x").is_err());
        // Missing host.
        assert!(
            validate_mcp_url("http:///nohost").is_ok(),
            "parser normalizes to host=nohost"
        );
        assert!(validate_mcp_url("http://:8080/x").is_err());
    }

    #[test]
    fn resolve_command_uses_base_env_path() {
        let dir = tempfile::tempdir().unwrap();
        let script = dir.path().join("fake-mcp");
        std::fs::write(&script, "#!/bin/sh\nexit 0\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = std::fs::metadata(&script).unwrap().permissions();
            perms.set_mode(0o755);
            std::fs::set_permissions(&script, perms).unwrap();
        }
        let cfg = McpServerConfig {
            command: Some("fake-mcp".to_string()),
            args: vec![],
            env: HashMap::new(),
            url: None,
            headers: HashMap::new(),
        };
        let mut base_env = HashMap::new();
        base_env.insert(
            "PATH".to_string(),
            dir.path().to_string_lossy().into_owned(),
        );
        let resolved = resolve_command("fake-mcp", &cfg, &base_env);
        assert_eq!(resolved, script.into_os_string());
    }

    #[test]
    fn header_values_expand_environment_references_without_persisting_tokens() {
        let name = "NEX_MCP_TEST_TOKEN";
        let env = HashMap::from([(name.to_string(), "secret-token".to_string())]);
        let rendered = resolve_header_value(&format!("Bearer ${{{name}}}"), &env).unwrap();
        assert_eq!(rendered, "Bearer secret-token");
        assert!(resolve_header_value("Bearer ${MISSING_NEX_TOKEN}", &env).is_err());
        assert!(resolve_header_value("Bearer ${BAD-NAME}", &env).is_err());
    }
}
