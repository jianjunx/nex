//! ACP-over-stdio adapter: the v1 concrete agent transport.
//!
//! Nex is the *client* side of ACP: it implements [`acp::Client`] to receive
//! session updates and permission requests from the agent, and drives the agent
//! through [`acp::ClientSideConnection`] (initialize / new_session / prompt /
//! cancel / set_session_mode). Uses `agent-client-protocol` 0.7 (with unstable
//! model selection) — the same family of transport Zed's ACP client uses.

use std::collections::{HashMap, VecDeque};
use std::future::Future;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use agent_client_protocol::{self as acp, Agent as _};
use tauri::{AppHandle, Emitter};
use tokio::sync::oneshot;
use tokio_util::compat::{TokioAsyncReadCompatExt, TokioAsyncWriteCompatExt};

use super::launch::{spawn_agent, LaunchSpec};
use super::native::NexNativeAgent;
use super::types::{
    AgentNotification, AgentPermissionRequest, AgentPlanApprovalRequest, AgentSessionTerminated,
    CreateSessionResult, CursorTodoDto, PermissionOption, PromptBlock, SessionConfigOptionDto,
    SessionConfigValueDto, SessionModeDto, SessionModesDto, SessionModelDto, SessionModelsDto,
};
use crate::error::NexError;

const AGENT_NOTIFICATION_EVENT: &str = "agent-notification";
const AGENT_PERMISSION_REQUEST_EVENT: &str = "agent-permission-request";
const AGENT_PLAN_APPROVAL_REQUEST_EVENT: &str = "agent-plan-approval-request";
const AGENT_SESSION_TERMINATED_EVENT: &str = "agent-session-terminated";

// 120s covers the worst case: cold-cache `npm install` of a new agent
// (downloads the package + transitive deps) plus the agent's own bootstrap.
// Steady-state restarts complete in well under a second.
const HANDSHAKE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);
const STDERR_TAIL_LINES: usize = 50;

/// Session metadata delivered by a successful handshake.
type SessionHandshakeInfo = (
    acp::SessionId,
    Option<SessionModesDto>,
    Option<SessionModelsDto>,
    Option<Vec<SessionConfigOptionDto>>,
);

/// What run_session reports back through its oneshot channel: the live
/// connection plus the flattened handshake metadata.
type SessionInitResult = Result<
    (
        acp::ClientSideConnection,
        acp::SessionId,
        Option<SessionModesDto>,
        Option<SessionModelsDto>,
        Option<Vec<SessionConfigOptionDto>>,
    ),
    NexError,
>;

fn permission_option_kind_str(kind: acp::PermissionOptionKind) -> &'static str {
    match kind {
        acp::PermissionOptionKind::AllowOnce => "allow_once",
        acp::PermissionOptionKind::AllowAlways => "allow_always",
        acp::PermissionOptionKind::RejectOnce => "reject_once",
        acp::PermissionOptionKind::RejectAlways => "reject_always",
    }
}

fn tool_kind_str(kind: acp::ToolKind) -> &'static str {
    match kind {
        acp::ToolKind::Read => "read",
        acp::ToolKind::Edit => "edit",
        acp::ToolKind::Delete => "delete",
        acp::ToolKind::Move => "move",
        acp::ToolKind::Search => "search",
        acp::ToolKind::Execute => "execute",
        acp::ToolKind::Think => "think",
        acp::ToolKind::Fetch => "fetch",
        acp::ToolKind::SwitchMode => "switch_mode",
        acp::ToolKind::Other => "other",
    }
}

struct PendingPermission {
    session_key: String,
    tx: oneshot::Sender<acp::RequestPermissionOutcome>,
}

/// Outcome the UI returns for a Cursor `cursor/create_plan` request.
#[derive(Debug, Clone)]
enum PlanApprovalOutcome {
    Accepted,
    Rejected { reason: Option<String> },
    Cancelled,
}

struct PendingPlanApproval {
    session_key: String,
    tx: oneshot::Sender<PlanApprovalOutcome>,
}

struct SessionHandle {
    conn: acp::ClientSideConnection,
    agent_session_id: acp::SessionId,
    #[allow(dead_code)]
    conversation_id: String,
    prompt_in_flight: AtomicBool,
    _shutdown: oneshot::Sender<()>,
}

pub struct AcpSessionManager {
    sessions: Arc<Mutex<HashMap<String, Arc<SessionHandle>>>>,
    pending_permissions: Arc<Mutex<HashMap<String, PendingPermission>>>,
    pending_plan_approvals: Arc<Mutex<HashMap<String, PendingPlanApproval>>>,
}

struct NexAcpClient {
    app: AppHandle,
    session_key: String,
    pending_permissions: Arc<Mutex<HashMap<String, PendingPermission>>>,
    pending_plan_approvals: Arc<Mutex<HashMap<String, PendingPlanApproval>>>,
    /// Latest Cursor todo list for this session (supports `update_todos` merge).
    cursor_todos: Mutex<Vec<CursorTodoDto>>,
}

#[async_trait::async_trait(?Send)]
impl acp::Client for NexAcpClient {
    async fn session_notification(&self, args: acp::SessionNotification) -> acp::Result<()> {
        let update = serde_json::to_value(&args.update).unwrap_or(serde_json::Value::Null);
        let _ = self.app.emit(
            AGENT_NOTIFICATION_EVENT,
            AgentNotification { session_id: self.session_key.clone(), update },
        );
        Ok(())
    }

    async fn request_permission(
        &self,
        args: acp::RequestPermissionRequest,
    ) -> acp::Result<acp::RequestPermissionResponse> {
        let request_id = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = oneshot::channel();
        self.pending_permissions.lock().unwrap().insert(
            request_id.clone(),
            PendingPermission { session_key: self.session_key.clone(), tx },
        );

        let tool_call_id = Some(args.tool_call.id.0.to_string());
        let fields = &args.tool_call.fields;
        let tool_title = fields.title.clone();
        let tool_kind = fields.kind.map(tool_kind_str).map(str::to_string);
        let tool_content = fields
            .content
            .as_ref()
            .and_then(|c| serde_json::to_value(c).ok());
        let tool_raw_input = fields.raw_input.clone();
        let options = args
            .options
            .iter()
            .map(|o| PermissionOption {
                option_id: o.id.to_string(),
                label: o.name.clone(),
                kind: Some(permission_option_kind_str(o.kind).to_string()),
            })
            .collect();
        let _ = self.app.emit(
            AGENT_PERMISSION_REQUEST_EVENT,
            AgentPermissionRequest {
                session_id: self.session_key.clone(),
                request_id,
                tool_call_id,
                tool_title,
                tool_kind,
                tool_content,
                tool_raw_input,
                options,
            },
        );

        let outcome = rx.await.unwrap_or(acp::RequestPermissionOutcome::Cancelled);
        Ok(acp::RequestPermissionResponse { outcome, meta: None })
    }

    async fn write_text_file(
        &self,
        _args: acp::WriteTextFileRequest,
    ) -> acp::Result<acp::WriteTextFileResponse> {
        Err(acp::Error::method_not_found())
    }

    async fn read_text_file(
        &self,
        _args: acp::ReadTextFileRequest,
    ) -> acp::Result<acp::ReadTextFileResponse> {
        Err(acp::Error::method_not_found())
    }

    async fn ext_method(&self, args: acp::ExtRequest) -> acp::Result<acp::ExtResponse> {
        let method = args.method.as_ref();
        let params: serde_json::Value =
            serde_json::from_str(args.params.get()).unwrap_or(serde_json::Value::Null);

        let result = match method {
            "cursor/create_plan" => self.handle_create_plan(params).await,
            "cursor/update_todos" => {
                // Spec: notification; some agents may still send as a request.
                let todos = self.apply_cursor_todos(&params);
                self.emit_plan_from_todos(&todos);
                serde_json::json!({ "outcome": { "outcome": "accepted", "todos": todos } })
            }
            "cursor/ask_question" => {
                self.forward_ext("ext_method", method, &params);
                serde_json::json!({
                    "outcome": {
                        "outcome": "skipped",
                        "reason": "Nex has not implemented this prompt UI yet"
                    }
                })
            }
            "cursor/task" => {
                self.forward_ext("ext_method", method, &params);
                serde_json::json!({ "outcome": { "outcome": "completed" } })
            }
            "cursor/generate_image" => {
                self.forward_ext("ext_method", method, &params);
                serde_json::json!({ "outcome": { "outcome": "accepted" } })
            }
            _ => {
                self.forward_ext("ext_method", method, &params);
                serde_json::Value::Null
            }
        };
        let raw = serde_json::value::RawValue::from_string(result.to_string()).map_err(|e| {
            acp::Error::internal_error().with_data(format!("ext_method encode failed: {e}"))
        })?;
        Ok(raw.into())
    }

    async fn ext_notification(&self, args: acp::ExtNotification) -> acp::Result<()> {
        let method = args.method.as_ref();
        let params: serde_json::Value =
            serde_json::from_str(args.params.get()).unwrap_or(serde_json::Value::Null);

        // Unknown session/update variants (config_option_update on older schema)
        // arrive here; forward the inner `update` so the frontend reducer sees it.
        if method == "session/update" {
            let update = params.get("update").cloned().unwrap_or(params);
            let _ = self.app.emit(
                AGENT_NOTIFICATION_EVENT,
                AgentNotification {
                    session_id: self.session_key.clone(),
                    update,
                },
            );
            return Ok(());
        }

        if method == "cursor/update_todos" {
            let todos = self.apply_cursor_todos(&params);
            self.emit_plan_from_todos(&todos);
            return Ok(());
        }

        self.forward_ext("ext_notification", method, &params);
        Ok(())
    }
}

impl NexAcpClient {
    fn forward_ext(&self, kind: &str, method: &str, params: &serde_json::Value) {
        let _ = self.app.emit(
            AGENT_NOTIFICATION_EVENT,
            AgentNotification {
                session_id: self.session_key.clone(),
                update: serde_json::json!({
                    "sessionUpdate": kind,
                    "method": method,
                    "params": params,
                }),
            },
        );
    }

    fn emit_plan_from_todos(&self, todos: &[CursorTodoDto]) {
        let entries: Vec<serde_json::Value> = todos
            .iter()
            .map(|t| {
                serde_json::json!({
                    "content": t.content,
                    "priority": "medium",
                    "status": normalize_plan_status(&t.status),
                })
            })
            .collect();
        let _ = self.app.emit(
            AGENT_NOTIFICATION_EVENT,
            AgentNotification {
                session_id: self.session_key.clone(),
                update: serde_json::json!({
                    "sessionUpdate": "plan",
                    "entries": entries,
                }),
            },
        );
    }

    fn apply_cursor_todos(&self, params: &serde_json::Value) -> Vec<CursorTodoDto> {
        let incoming = parse_cursor_todos(params);
        let merge = params
            .get("merge")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let mut guard = self.cursor_todos.lock().unwrap();
        merge_cursor_todos(&mut guard, incoming, merge);
        guard.clone()
    }

    async fn handle_create_plan(&self, params: serde_json::Value) -> serde_json::Value {
        let name = params
            .get("name")
            .and_then(|v| v.as_str())
            .map(str::to_string);
        let overview = params
            .get("overview")
            .and_then(|v| v.as_str())
            .map(str::to_string);
        let plan = params
            .get("plan")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        let mut todos = parse_cursor_todos(&params);
        if todos.is_empty() {
            todos = parse_cursor_todos_from_phases(&params);
        }
        {
            let mut guard = self.cursor_todos.lock().unwrap();
            *guard = todos.clone();
        }
        self.emit_plan_from_todos(&todos);

        let request_id = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = oneshot::channel();
        self.pending_plan_approvals.lock().unwrap().insert(
            request_id.clone(),
            PendingPlanApproval {
                session_key: self.session_key.clone(),
                tx,
            },
        );

        let _ = self.app.emit(
            AGENT_PLAN_APPROVAL_REQUEST_EVENT,
            AgentPlanApprovalRequest {
                session_id: self.session_key.clone(),
                request_id,
                name,
                overview,
                plan,
                todos,
            },
        );

        let outcome = rx.await.unwrap_or(PlanApprovalOutcome::Cancelled);
        match outcome {
            PlanApprovalOutcome::Accepted => {
                serde_json::json!({ "outcome": { "outcome": "accepted" } })
            }
            PlanApprovalOutcome::Rejected { reason } => {
                let mut body = serde_json::json!({ "outcome": { "outcome": "rejected" } });
                if let Some(reason) = reason {
                    body["outcome"]["reason"] = serde_json::Value::String(reason);
                }
                body
            }
            PlanApprovalOutcome::Cancelled => {
                serde_json::json!({ "outcome": { "outcome": "cancelled" } })
            }
        }
    }
}

fn normalize_plan_status(status: &str) -> &str {
    match status {
        "in_progress" | "completed" | "pending" | "cancelled" => status,
        _ => "pending",
    }
}

fn parse_cursor_todo_item(item: &serde_json::Value) -> Option<CursorTodoDto> {
    let content = item.get("content").and_then(|v| v.as_str())?.trim();
    if content.is_empty() {
        return None;
    }
    let id = item
        .get("id")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let status = item
        .get("status")
        .and_then(|v| v.as_str())
        .unwrap_or("pending")
        .to_string();
    Some(CursorTodoDto {
        id,
        content: content.to_string(),
        status,
    })
}

fn parse_cursor_todos(params: &serde_json::Value) -> Vec<CursorTodoDto> {
    params
        .get("todos")
        .and_then(|v| v.as_array())
        .into_iter()
        .flatten()
        .filter_map(parse_cursor_todo_item)
        .collect()
}

fn parse_cursor_todos_from_phases(params: &serde_json::Value) -> Vec<CursorTodoDto> {
    params
        .get("phases")
        .and_then(|v| v.as_array())
        .into_iter()
        .flatten()
        .filter_map(|phase| phase.get("todos").and_then(|v| v.as_array()))
        .flatten()
        .filter_map(parse_cursor_todo_item)
        .collect()
}

fn merge_cursor_todos(existing: &mut Vec<CursorTodoDto>, incoming: Vec<CursorTodoDto>, merge: bool) {
    if !merge {
        *existing = incoming;
        return;
    }
    for todo in incoming {
        if let Some(slot) = existing.iter_mut().find(|e| !todo.id.is_empty() && e.id == todo.id) {
            *slot = todo;
        } else {
            existing.push(todo);
        }
    }
}

fn prompt_blocks_to_acp(blocks: Vec<PromptBlock>) -> Vec<acp::ContentBlock> {
    blocks
        .into_iter()
        .map(|b| match b {
            PromptBlock::Text { text } => acp::ContentBlock::from(text),
            PromptBlock::Image { data, mime_type, uri } => acp::ContentBlock::Image(
                acp::ImageContent {
                    annotations: None,
                    data,
                    mime_type,
                    uri,
                    meta: None,
                },
            ),
            PromptBlock::Resource { uri, mime_type, text } => acp::ContentBlock::Resource(
                acp::EmbeddedResource {
                    annotations: None,
                    resource: acp::EmbeddedResourceResource::TextResourceContents(
                        acp::TextResourceContents {
                            mime_type,
                            text,
                            uri,
                            meta: None,
                        },
                    ),
                    meta: None,
                },
            ),
            PromptBlock::ResourceLink { uri, name, mime_type } => {
                acp::ContentBlock::ResourceLink(acp::ResourceLink {
                    annotations: None,
                    description: None,
                    mime_type,
                    name,
                    size: None,
                    title: None,
                    uri,
                    meta: None,
                })
            }
        })
        .collect()
}

fn config_options_from_json(value: &serde_json::Value) -> Option<Vec<SessionConfigOptionDto>> {
    // Native agents carry config options in the `_meta` extension point (the
    // 0.7 schema drops configOptions from NewSessionResponse), so fall back to
    // `_meta.configOptions` when no top-level field exists.
    let arr = value
        .get("configOptions")
        .or_else(|| value.get("config_options"))
        .or_else(|| value.get("_meta").and_then(|m| m.get("configOptions")))?;
    let items = arr.as_array()?;
    let mut out = Vec::new();
    for item in items {
        let id = item.get("id")?.as_str()?.to_string();
        let name = item
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let category = item
            .get("category")
            .and_then(|v| v.as_str())
            .map(str::to_string);
        let current_value_id = item
            .get("currentValue")
            .or_else(|| item.get("current_value"))
            .or_else(|| item.get("currentValueId"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let options = item
            .get("options")
            .and_then(|v| v.as_array())
            .map(|opts| {
                opts.iter()
                    .filter_map(|o| {
                        let oid = o
                            .get("value")
                            .or_else(|| o.get("id"))
                            .and_then(|v| v.as_str())?
                            .to_string();
                        let oname = o
                            .get("name")
                            .and_then(|v| v.as_str())
                            .unwrap_or(oid.as_str())
                            .to_string();
                        Some(SessionConfigValueDto { id: oid, name: oname })
                    })
                    .collect()
            })
            .unwrap_or_default();
        // Only surface select-style options in the composer for now.
        if item.get("type").and_then(|v| v.as_str()) == Some("boolean") {
            continue;
        }
        out.push(SessionConfigOptionDto {
            id,
            name,
            category,
            current_value_id,
            options,
        });
    }
    Some(out).filter(|o| !o.is_empty())
}

fn modes_from_json(value: &serde_json::Value) -> Option<SessionModesDto> {
    let modes = value.get("modes")?;
    let current = modes
        .get("currentModeId")
        .or_else(|| modes.get("current_mode_id"))
        .and_then(|v| v.as_str())?
        .to_string();
    let available = modes
        .get("availableModes")
        .or_else(|| modes.get("available_modes"))
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|m| {
                    Some(SessionModeDto {
                        id: m.get("id")?.as_str()?.to_string(),
                        name: m.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                        description: m
                            .get("description")
                            .and_then(|v| v.as_str())
                            .map(str::to_string),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    Some(SessionModesDto {
        current_mode_id: current,
        available_modes: available,
    })
}

fn models_from_json(value: &serde_json::Value) -> Option<SessionModelsDto> {
    let models = value.get("models")?;
    let current = models
        .get("currentModelId")
        .or_else(|| models.get("current_model_id"))
        .and_then(|v| v.as_str())?
        .to_string();
    let available = models
        .get("availableModels")
        .or_else(|| models.get("available_models"))
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|m| {
                    let id = m
                        .get("modelId")
                        .or_else(|| m.get("model_id"))
                        .or_else(|| m.get("id"))
                        .and_then(|v| v.as_str())?
                        .to_string();
                    Some(SessionModelDto {
                        id,
                        name: m.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                        description: m
                            .get("description")
                            .and_then(|v| v.as_str())
                            .map(str::to_string),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    Some(SessionModelsDto {
        current_model_id: current,
        available_models: available,
    })
}

/// ACP 0.7 agent methods return `!Send` futures (`async_trait(?Send)`).
/// Tauri commands require `Send` futures, so we drive those calls with
/// `block_on` on a current-thread runtime.
///
/// The runtimes live on a fixed pool of dedicated worker threads instead of
/// being built per call: constructing+tearing down a tokio runtime on every
/// prompt/cancel/mode-switch was pure overhead (each call pays the builder
/// cost and occupies a blocking-pool thread for the whole agent turn). A
/// prompt blocks its worker until the turn completes, so the pool keeps one
/// worker per concurrently drivable session and dispatches round-robin.
type AcpJob = Box<dyn FnOnce(Option<&tokio::runtime::Runtime>) + Send>;

static ACP_WORKERS: OnceLock<(Vec<std::sync::mpsc::SyncSender<AcpJob>>, AtomicUsize)> =
    OnceLock::new();

fn acp_worker_count() -> usize {
    std::thread::available_parallelism()
        .map(|n| n.get().clamp(4, 8))
        .unwrap_or(4)
}

fn acp_workers() -> &'static (Vec<std::sync::mpsc::SyncSender<AcpJob>>, AtomicUsize) {
    ACP_WORKERS.get_or_init(|| {
        let n = acp_worker_count();
        let mut senders = Vec::with_capacity(n);
        for i in 0..n {
            let (tx, rx) = std::sync::mpsc::sync_channel::<AcpJob>(64);
            // If the thread fails to spawn, drop the sender: dispatch reports
            // a dead worker as an Internal error instead of hanging.
            if std::thread::Builder::new()
                .name(format!("acp-worker-{i}"))
                .spawn(move || {
                    // One long-lived current-thread runtime per worker; jobs
                    // run sequentially, and the future is built + polled on
                    // this thread so `!Send` futures are fine.
                    let rt = tokio::runtime::Builder::new_current_thread()
                        .enable_all()
                        .build()
                        .ok();
                    for job in rx {
                        job(rt.as_ref());
                    }
                })
                .is_ok()
            {
                senders.push(tx);
            }
        }
        (senders, AtomicUsize::new(0))
    })
}

async fn run_acp<T, F, Fut>(op: F) -> Result<T, NexError>
where
    T: Send + 'static,
    F: FnOnce() -> Fut + Send + 'static,
    Fut: Future<Output = Result<T, acp::Error>> + 'static,
{
    let (senders, next) = acp_workers();
    if senders.is_empty() {
        return Err(NexError::Internal(
            "no acp worker thread could be started".to_string(),
        ));
    }
    let (tx, rx) = oneshot::channel::<Result<T, NexError>>();
    let job: AcpJob = Box::new(move |rt| {
        let result = match rt {
            Some(rt) => rt.block_on(op()).map_err(NexError::from),
            None => Err(NexError::Internal(
                "failed to start acp worker runtime".to_string(),
            )),
        };
        let _ = tx.send(result);
    });
    // Round-robin so concurrent sessions spread across workers instead of
    // stacking behind one busy worker's queue.
    let idx = next.fetch_add(1, Ordering::Relaxed) % senders.len();
    senders[idx]
        .send(job)
        .map_err(|_| NexError::Internal("acp worker thread died".to_string()))?;
    rx.await
        .map_err(|_| NexError::Agent("acp worker dropped the job".to_string()))?
}

impl Default for AcpSessionManager {
    fn default() -> Self {
        Self::new()
    }
}

impl AcpSessionManager {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
            pending_permissions: Arc::new(Mutex::new(HashMap::new())),
            pending_plan_approvals: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub async fn create_session(
        &self,
        app: &AppHandle,
        conversation_id: &str,
        spec: LaunchSpec,
    ) -> Result<CreateSessionResult, NexError> {
        let session_key = uuid::Uuid::new_v4().to_string();
        let (init_tx, init_rx) = oneshot::channel::<
            Result<(acp::ClientSideConnection, acp::SessionId, Option<SessionModesDto>, Option<SessionModelsDto>, Option<Vec<SessionConfigOptionDto>>), NexError>,
        >();
        let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();

        let thread_app = app.clone();
        let thread_key = session_key.clone();
        let thread_sessions = Arc::clone(&self.sessions);
        let thread_pending = Arc::clone(&self.pending_permissions);
        let thread_plans = Arc::clone(&self.pending_plan_approvals);

        std::thread::Builder::new()
            .name(format!("agent-session-{session_key}"))
            .spawn(move || {
                let runtime = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
                    Ok(rt) => rt,
                    Err(e) => {
                        let _ = init_tx.send(Err(NexError::Agent(format!("failed to start session runtime: {e}"))));
                        return;
                    }
                };
                let local = tokio::task::LocalSet::new();
                local.block_on(&runtime, async move {
                    run_session(
                        thread_app,
                        thread_key,
                        spec,
                        thread_pending,
                        thread_plans,
                        thread_sessions,
                        init_tx,
                        shutdown_rx,
                    )
                    .await;
                });
            })
            .map_err(|e| NexError::Agent(format!("failed to spawn session thread: {e}")))?;

        let (conn, agent_session_id, modes, models, config_options) = init_rx
            .await
            .map_err(|_| NexError::Agent("session thread stopped during initialization".to_string()))??;

        let handle = Arc::new(SessionHandle {
            conn,
            agent_session_id,
            conversation_id: conversation_id.to_string(),
            prompt_in_flight: AtomicBool::new(false),
            _shutdown: shutdown_tx,
        });
        self.sessions.lock().unwrap().insert(session_key.clone(), handle);
        Ok(CreateSessionResult {
            session_id: session_key,
            modes,
            models,
            config_options,
        })
    }

    /// Starts the in-process native agent. Mirrors [`Self::create_session`] but
    /// routes the session thread to `run_session_native` (duplex pipe + agent
    /// side) instead of spawning an external child process.
    pub async fn create_native_session(
        &self,
        app: &AppHandle,
        conversation_id: &str,
        cwd: &str,
        config_path: std::path::PathBuf,
    ) -> Result<CreateSessionResult, NexError> {
        let session_key = uuid::Uuid::new_v4().to_string();
        let (init_tx, init_rx) = oneshot::channel::<
            Result<(acp::ClientSideConnection, acp::SessionId, Option<SessionModesDto>, Option<SessionModelsDto>, Option<Vec<SessionConfigOptionDto>>), NexError>,
        >();
        let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();

        let thread_app = app.clone();
        let thread_key = session_key.clone();
        let thread_cwd = cwd.to_string();
        let thread_sessions = Arc::clone(&self.sessions);
        let thread_pending = Arc::clone(&self.pending_permissions);
        let thread_plans = Arc::clone(&self.pending_plan_approvals);

        std::thread::Builder::new()
            .name(format!("agent-session-{session_key}"))
            .spawn(move || {
                let runtime = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
                    Ok(rt) => rt,
                    Err(e) => {
                        let _ = init_tx.send(Err(NexError::Agent(format!("failed to start session runtime: {e}"))));
                        return;
                    }
                };
                let local = tokio::task::LocalSet::new();
                local.block_on(&runtime, async move {
                    run_session_native(
                        thread_app,
                        thread_key,
                        thread_cwd,
                        config_path,
                        thread_pending,
                        thread_plans,
                        thread_sessions,
                        init_tx,
                        shutdown_rx,
                    )
                    .await;
                });
            })
            .map_err(|e| NexError::Agent(format!("failed to spawn session thread: {e}")))?;

        let (conn, agent_session_id, modes, models, config_options) = init_rx
            .await
            .map_err(|_| NexError::Agent("session thread stopped during initialization".to_string()))??;

        let handle = Arc::new(SessionHandle {
            conn,
            agent_session_id,
            conversation_id: conversation_id.to_string(),
            prompt_in_flight: AtomicBool::new(false),
            _shutdown: shutdown_tx,
        });
        self.sessions.lock().unwrap().insert(session_key.clone(), handle);
        Ok(CreateSessionResult {
            session_id: session_key,
            modes,
            models,
            config_options,
        })
    }

    pub async fn send_prompt(&self, session_id: &str, blocks: Vec<PromptBlock>) -> Result<(), NexError> {
        let handle = self.session(session_id)?;
        if handle
            .prompt_in_flight
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return Err(NexError::Agent("a prompt is already in flight for this session".to_string()));
        }
        let prompt = prompt_blocks_to_acp(blocks);
        let agent_session_id = handle.agent_session_id.clone();
        let result = run_acp({
            let handle = Arc::clone(&handle);
            move || async move {
                handle
                    .conn
                    .prompt(acp::PromptRequest {
                        session_id: agent_session_id,
                        prompt,
                        meta: None,
                    })
                    .await
            }
        })
        .await;
        handle.prompt_in_flight.store(false, Ordering::SeqCst);
        result.map(|_| ())
    }

    pub async fn set_session_mode(&self, session_id: &str, mode_id: &str) -> Result<(), NexError> {
        let handle = self.session(session_id)?;
        let agent_session_id = handle.agent_session_id.clone();
        let mode_id = mode_id.to_string();
        run_acp({
            let handle = Arc::clone(&handle);
            move || async move {
                handle
                    .conn
                    .set_session_mode(acp::SetSessionModeRequest {
                        session_id: agent_session_id,
                        mode_id: acp::SessionModeId(Arc::from(mode_id.as_str())),
                        meta: None,
                    })
                    .await
            }
        })
        .await
        .map(|_| ())
    }

    pub async fn set_session_model(
        &self,
        session_id: &str,
        model_id: &str,
    ) -> Result<Option<Vec<SessionConfigOptionDto>>, NexError> {
        let handle = self.session(session_id)?;
        let agent_session_id = handle.agent_session_id.clone();
        let model_id = model_id.to_string();
        let resp = run_acp({
            let handle = Arc::clone(&handle);
            move || async move {
                handle
                    .conn
                    .set_session_model(acp::SetSessionModelRequest {
                        session_id: agent_session_id,
                        model_id: acp::ModelId(Arc::from(model_id.as_str())),
                        meta: None,
                    })
                    .await
            }
        })
        .await?;
        Ok(resp.meta.as_ref().and_then(config_options_from_json))
    }

    pub async fn set_session_config_option(
        &self,
        session_id: &str,
        config_id: &str,
        value: &str,
    ) -> Result<Option<Vec<SessionConfigOptionDto>>, NexError> {
        let handle = self.session(session_id)?;
        let agent_session_id = handle.agent_session_id.to_string();
        let config_id = config_id.to_string();
        let value = value.to_string();
        let raw = run_acp({
            let handle = Arc::clone(&handle);
            move || async move {
                handle
                    .conn
                    .request_raw(
                        // ACP `session/set_config_option` is the standard method
                        // name external agents (Claude Code / Codex / Cursor)
                        // register. Our in-process native agent's decode layer
                        // (patched in `agent-client-protocol/src/lib.rs`) routes
                        // this same unprefixed name into `Agent::ext_method`,
                        // so the same call works for both transports.
                        "session/set_config_option",
                        serde_json::json!({
                            "sessionId": agent_session_id,
                            "configId": config_id,
                            "value": value,
                        }),
                    )
                    .await
            }
        })
        .await?;
        Ok(config_options_from_json(&raw))
    }

    pub async fn cancel(&self, session_id: &str) -> Result<(), NexError> {
        let handle = self.session(session_id)?;
        self.resolve_session_permissions(session_id, Some(acp::RequestPermissionOutcome::Cancelled));
        self.resolve_session_plan_approvals(session_id, PlanApprovalOutcome::Cancelled);
        let agent_session_id = handle.agent_session_id.clone();
        run_acp({
            let handle = Arc::clone(&handle);
            move || async move {
                handle
                    .conn
                    .cancel(acp::CancelNotification {
                        session_id: agent_session_id,
                        meta: None,
                    })
                    .await
            }
        })
        .await
    }

    pub fn respond_permission(&self, request_id: &str, option_id: Option<String>) -> Result<(), NexError> {
        let pending = self.pending_permissions.lock().unwrap().remove(request_id);
        let pending = pending
            .ok_or_else(|| NexError::Agent(format!("unknown permission request `{request_id}`")))?;
        let outcome = match option_id {
            Some(id) => acp::RequestPermissionOutcome::Selected {
                option_id: acp::PermissionOptionId(Arc::from(id.as_str())),
            },
            None => acp::RequestPermissionOutcome::Cancelled,
        };
        pending
            .tx
            .send(outcome)
            .map_err(|_| NexError::Agent("permission request already resolved".to_string()))
    }

    /// Resolves a Cursor `cursor/create_plan` approval (`accepted` / `rejected` / `cancelled`).
    pub fn respond_plan(
        &self,
        request_id: &str,
        outcome: &str,
        reason: Option<String>,
    ) -> Result<(), NexError> {
        let pending = self
            .pending_plan_approvals
            .lock()
            .unwrap()
            .remove(request_id)
            .ok_or_else(|| NexError::Agent(format!("unknown plan approval request `{request_id}`")))?;
        let mapped = match outcome {
            "accepted" => PlanApprovalOutcome::Accepted,
            "rejected" => PlanApprovalOutcome::Rejected { reason },
            "cancelled" => PlanApprovalOutcome::Cancelled,
            other => {
                return Err(NexError::Agent(format!(
                    "invalid plan approval outcome `{other}` (expected accepted|rejected|cancelled)"
                )));
            }
        };
        pending
            .tx
            .send(mapped)
            .map_err(|_| NexError::Agent("plan approval request already resolved".to_string()))
    }

    pub fn remove_session(&self, session_id: &str) {
        self.sessions.lock().unwrap().remove(session_id);
    }

    fn session(&self, session_id: &str) -> Result<Arc<SessionHandle>, NexError> {
        self.sessions
            .lock()
            .unwrap()
            .get(session_id)
            .cloned()
            .ok_or_else(|| NexError::Agent(format!("no such session `{session_id}`")))
    }

    fn resolve_session_permissions(&self, session_id: &str, outcome: Option<acp::RequestPermissionOutcome>) {
        let mut map = self.pending_permissions.lock().unwrap();
        let keys: Vec<String> = map
            .iter()
            .filter(|(_, p)| p.session_key == session_id)
            .map(|(k, _)| k.clone())
            .collect();
        for key in keys {
            if let (Some(outcome), Some(pending)) = (outcome.clone(), map.remove(&key)) {
                let _ = pending.tx.send(outcome);
            }
        }
    }

    fn resolve_session_plan_approvals(&self, session_id: &str, outcome: PlanApprovalOutcome) {
        let mut map = self.pending_plan_approvals.lock().unwrap();
        let keys: Vec<String> = map
            .iter()
            .filter(|(_, p)| p.session_key == session_id)
            .map(|(k, _)| k.clone())
            .collect();
        for key in keys {
            if let Some(pending) = map.remove(&key) {
                let _ = pending.tx.send(outcome.clone());
            }
        }
    }
}

/// Diagnostics + lifecycle context for the spawned transport behind a session.
///
/// External agents carry their child process here (so handshake failures can be
/// enriched with stderr and the process can be killed). The in-process native
/// agent has no child, so `child` is `None` and the kill helpers are no-ops.
struct DiagCtx {
    program: String,
    args: Vec<String>,
    child: Option<tokio::process::Child>,
    stderr_tail: Arc<Mutex<VecDeque<String>>>,
}

#[allow(clippy::too_many_arguments)]
async fn run_session(
    app: AppHandle,
    session_key: String,
    spec: LaunchSpec,
    pending_permissions: Arc<Mutex<HashMap<String, PendingPermission>>>,
    pending_plan_approvals: Arc<Mutex<HashMap<String, PendingPlanApproval>>>,
    sessions: Arc<Mutex<HashMap<String, Arc<SessionHandle>>>>,
    init_tx: oneshot::Sender<SessionInitResult>,
    shutdown_rx: oneshot::Receiver<()>,
) {
    let program = spec.program.clone();
    let cwd = spec.cwd.clone();
    log::info!(
        "spawning ACP agent: {} {} (cwd: {cwd})",
        spec.program,
        spec.args.join(" ")
    );
    let mut child = match spawn_agent(&spec) {
        Ok(child) => child,
        Err(e) => {
            let _ = init_tx.send(Err(e));
            return;
        }
    };

    let stderr_tail: Arc<Mutex<VecDeque<String>>> = Arc::new(Mutex::new(VecDeque::new()));
    if let Some(stderr) = child.stderr.take() {
        drain_stderr(stderr, program.clone(), Arc::clone(&stderr_tail));
    }

    let outgoing = child.stdin.take().expect("agent stdin not piped").compat_write();
    let incoming = child.stdout.take().expect("agent stdout not piped").compat();

    let diag = DiagCtx {
        program: program.clone(),
        args: spec.args.clone(),
        child: Some(child),
        stderr_tail,
    };

    run_acp_session(
        app,
        session_key,
        cwd,
        outgoing,
        incoming,
        pending_permissions,
        pending_plan_approvals,
        sessions,
        init_tx,
        shutdown_rx,
        diag,
    )
    .await;
}

/// Starts the in-process native agent over an in-memory duplex pipe.
///
/// One end of the pipe is handed to `NexNativeAgent` (via `AgentSideConnection`),
/// the other end flows into the shared `run_acp_session` pipeline so the client
/// handshake / notification / permission / cancel plumbing is identical to an
/// external agent — only the byte transport differs.
#[allow(clippy::too_many_arguments)]
async fn run_session_native(
    app: AppHandle,
    session_key: String,
    cwd: String,
    config_path: std::path::PathBuf,
    pending_permissions: Arc<Mutex<HashMap<String, PendingPermission>>>,
    pending_plan_approvals: Arc<Mutex<HashMap<String, PendingPlanApproval>>>,
    sessions: Arc<Mutex<HashMap<String, Arc<SessionHandle>>>>,
    init_tx: oneshot::Sender<SessionInitResult>,
    shutdown_rx: oneshot::Receiver<()>,
) {
    log::info!("starting in-process native Nex agent (cwd: {cwd})");

    // Two bidirectional in-memory endpoints. `client_end` talks to the agent;
    // `agent_end` is driven by the agent's connection.
    let (client_end, agent_end) = tokio::io::duplex(64 * 1024);

    let agent = NexNativeAgent::new(config_path);

    // Split the agent endpoint into read/write halves and build the agent side.
    let (agent_read, agent_write) = tokio::io::split(agent_end);
    let (agent_conn, agent_io_task) = acp::AgentSideConnection::new(
        agent.clone(),
        agent_write.compat_write(),
        agent_read.compat(),
        |fut| {
            tokio::task::spawn_local(fut);
        },
    );
    agent.set_conn(Arc::new(agent_conn));
    tokio::task::spawn_local(async move {
        if let Err(e) = agent_io_task.await {
            log::error!("native agent io failed: {e}");
        }
    });

    // Split the client endpoint and run the shared ACP pipeline.
    let (client_read, client_write) = tokio::io::split(client_end);
    let diag = DiagCtx {
        program: "nex".to_string(),
        args: Vec::new(),
        child: None,
        stderr_tail: Arc::new(Mutex::new(VecDeque::new())),
    };

    run_acp_session(
        app,
        session_key,
        cwd,
        client_write.compat_write(),
        client_read.compat(),
        pending_permissions,
        pending_plan_approvals,
        sessions,
        init_tx,
        shutdown_rx,
        diag,
    )
    .await;
}

/// Transport-agnostic session pipeline: everything after the byte streams are
/// ready. Builds the client connection, performs the ACP handshake, reports it
/// through `init_tx`, then keeps the session alive until the IO task ends or a
/// shutdown is requested. Used by both external (child process) and native
/// (duplex pipe) transports.
#[allow(clippy::too_many_arguments)]
async fn run_acp_session<W, R>(
    app: AppHandle,
    session_key: String,
    cwd: String,
    outgoing: W,
    incoming: R,
    pending_permissions: Arc<Mutex<HashMap<String, PendingPermission>>>,
    pending_plan_approvals: Arc<Mutex<HashMap<String, PendingPlanApproval>>>,
    sessions: Arc<Mutex<HashMap<String, Arc<SessionHandle>>>>,
    init_tx: oneshot::Sender<SessionInitResult>,
    shutdown_rx: oneshot::Receiver<()>,
    mut diag: DiagCtx,
) where
    W: futures::io::AsyncWrite + Unpin + 'static,
    R: futures::io::AsyncRead + Unpin + 'static,
{
    let client = NexAcpClient {
        app: app.clone(),
        session_key: session_key.clone(),
        pending_permissions: Arc::clone(&pending_permissions),
        pending_plan_approvals: Arc::clone(&pending_plan_approvals),
        cursor_todos: Mutex::new(Vec::new()),
    };
    let (conn, io_task) = acp::ClientSideConnection::new(client, outgoing, incoming, |fut| {
        tokio::task::spawn_local(fut);
    });

    let (io_done_tx, io_done_rx) = oneshot::channel::<()>();
    tokio::task::spawn_local(async move {
        if let Err(e) = io_task.await {
            log::error!("agent session io failed: {e}");
        }
        let _ = io_done_tx.send(());
    });

    let handshake = tokio::time::timeout(HANDSHAKE_TIMEOUT, async {
        let init = conn
            .initialize(acp::InitializeRequest {
                protocol_version: acp::VERSION,
                client_capabilities: acp::ClientCapabilities::default(),
                client_info: Some(acp::Implementation {
                    name: "nex".into(),
                    title: Some("Nex".into()),
                    version: env!("CARGO_PKG_VERSION").into(),
                }),
                meta: None,
            })
            .await
            .map_err(NexError::from)?;

        // Cursor (and similar agents) advertise auth methods such as
        // `cursor_login` and require `authenticate` before `session/new`.
        // Skipping this step either errors with "Authentication required" or
        // hangs until the handshake timeout.
        if let Some(method) = pick_auth_method(&init.auth_methods) {
            log::info!(
                "authenticating ACP agent via method `{}` ({})",
                method.id.0,
                method.name
            );
            conn.authenticate(acp::AuthenticateRequest {
                method_id: method.id.clone(),
                meta: None,
            })
            .await
            .map_err(|e| {
                NexError::Agent(format!(
                    "{e}\n\
                     Tip: for Cursor, run `agent login` in a terminal first \
                     (or set CURSOR_API_KEY), then retry creating the session."
                ))
            })?;
        }

        let response = conn
            .request_raw(
                "session/new",
                serde_json::json!({
                    "cwd": cwd,
                    "mcpServers": [],
                }),
            )
            .await
            .map_err(NexError::from)?;

        let session_id = response
            .get("sessionId")
            .or_else(|| response.get("session_id"))
            .and_then(|v| v.as_str())
            .ok_or_else(|| NexError::Agent("session/new response missing sessionId".into()))?;
        let session_id = acp::SessionId(Arc::from(session_id));

        // Prefer typed fields when present; also keep configOptions which the
        // 0.7 schema drops from NewSessionResponse.
        let modes = modes_from_json(&response);
        let models = models_from_json(&response);
        let config_options = config_options_from_json(&response);
        Ok((session_id, modes, models, config_options))
    })
    .await;

    let handshake: Result<SessionHandshakeInfo, NexError> = match handshake {
        Ok(Ok(v)) => Ok(v),
        Ok(Err(e)) => Err(enrich(e, &mut diag)),
        Err(_) => {
            let details = diag_details(&mut diag);
            Err(NexError::Agent(format!(
                "agent `{}` did not complete the ACP handshake within {}s{}",
                diag.program,
                HANDSHAKE_TIMEOUT.as_secs(),
                details
            )))
        }
    };

    match handshake {
        Ok((agent_session_id, modes, models, config_options)) => {
            if init_tx
                .send(Ok((conn, agent_session_id, modes, models, config_options)))
                .is_err()
            {
                kill_diag(&mut diag).await;
                return;
            }
        }
        Err(e) => {
            let _ = init_tx.send(Err(e));
            kill_diag(&mut diag).await;
            return;
        }
    }

    tokio::select! {
        _ = io_done_rx => {},
        _ = shutdown_rx => {},
    }

    start_kill_diag(&mut diag);
    {
        let mut map = pending_permissions.lock().unwrap();
        let keys: Vec<String> = map
            .iter()
            .filter(|(_, p)| p.session_key == session_key)
            .map(|(k, _)| k.clone())
            .collect();
        for key in keys {
            map.remove(&key);
        }
    }
    {
        let mut map = pending_plan_approvals.lock().unwrap();
        let keys: Vec<String> = map
            .iter()
            .filter(|(_, p)| p.session_key == session_key)
            .map(|(k, _)| k.clone())
            .collect();
        for key in keys {
            if let Some(pending) = map.remove(&key) {
                let _ = pending.tx.send(PlanApprovalOutcome::Cancelled);
            }
        }
    }

    sessions.lock().unwrap().remove(&session_key);
    let _ = app.emit(AGENT_SESSION_TERMINATED_EVENT, AgentSessionTerminated { session_id: session_key });
}

/// Prefer a known interactive login method when present; otherwise take the
/// first advertised method. Agents with an empty `authMethods` list (Claude
/// via npx, etc.) skip authentication entirely.
fn pick_auth_method(methods: &[acp::AuthMethod]) -> Option<&acp::AuthMethod> {
    const PREFERRED: &[&str] = &["cursor_login"];
    for id in PREFERRED {
        if let Some(m) = methods.iter().find(|m| m.id.0.as_ref() == *id) {
            return Some(m);
        }
    }
    methods.first()
}

/// Builds a human-readable diagnostic tail for handshake failures. External
/// agents contribute the command line, process state and stderr; the native
/// agent (no child) contributes nothing extra.
fn diag_details(diag: &mut DiagCtx) -> String {
    let mut out = String::new();
    let Some(child) = diag.child.as_mut() else {
        return out;
    };
    out.push_str(&format!("\ncommand: {} {}", diag.program, diag.args.join(" ")));
    match child.try_wait() {
        Ok(Some(status)) => out.push_str(&format!("\nagent process exited ({status})")),
        Ok(None) => out.push_str(
            "\nagent process still running but not responding on stdout \
             — the binary may not support ACP v1; try the agent CLI directly \
             to verify it accepts ACP-over-stdio protocol",
        ),
        Err(e) => out.push_str(&format!("\nfailed to query agent process status: {e}")),
    }
    let lines = diag.stderr_tail.lock().unwrap();
    if !lines.is_empty() {
        out.push_str("\nagent stderr:");
        for line in lines.iter() {
            out.push_str(&format!("\n  {line}"));
        }
    }
    out
}

fn enrich(e: NexError, diag: &mut DiagCtx) -> NexError {
    match e {
        NexError::Agent(msg) => NexError::Agent(format!("{msg}{}", diag_details(diag))),
        other => other,
    }
}

/// Forcefully terminates the transport on handshake failure. A child process is
/// killed; the native agent has nothing to stop here.
async fn kill_diag(diag: &mut DiagCtx) {
    if let Some(child) = diag.child.as_mut() {
        let _ = child.kill().await;
    }
}

/// Requests termination of the transport during normal teardown.
fn start_kill_diag(diag: &mut DiagCtx) {
    if let Some(child) = diag.child.as_mut() {
        let _ = child.start_kill();
    }
}

fn drain_stderr(stderr: tokio::process::ChildStderr, program: String, tail: Arc<Mutex<VecDeque<String>>>) {
    const MAX_LOGGED_LINES: u32 = 100;
    tokio::task::spawn_local(async move {
        use tokio::io::AsyncBufReadExt;
        let mut lines = tokio::io::BufReader::new(stderr).lines();
        let mut count: u32 = 0;
        loop {
            match lines.next_line().await {
                Ok(Some(line)) => {
                    count += 1;
                    if count <= MAX_LOGGED_LINES {
                        log::warn!("agent `{program}` stderr: {line}");
                    } else if count == MAX_LOGGED_LINES + 1 {
                        log::warn!("agent `{program}` stderr: (further output suppressed)");
                    }
                    let mut buf = tail.lock().unwrap();
                    if buf.len() == STDERR_TAIL_LINES {
                        buf.pop_front();
                    }
                    buf.push_back(line);
                }
                Ok(None) => break,
                Err(e) => {
                    log::error!("agent `{program}` stderr read failed: {e}");
                    break;
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_cursor_todos_reads_items() {
        let params = serde_json::json!({
            "todos": [
                { "id": "1", "content": "A", "status": "completed" },
                { "id": "2", "content": "  ", "status": "pending" },
                { "content": "B", "status": "in_progress" }
            ]
        });
        let todos = parse_cursor_todos(&params);
        assert_eq!(todos.len(), 2);
        assert_eq!(todos[0].id, "1");
        assert_eq!(todos[0].content, "A");
        assert_eq!(todos[1].content, "B");
        assert!(todos[1].id.is_empty());
    }

    #[test]
    fn parse_cursor_todos_from_phases_flattens() {
        let params = serde_json::json!({
            "phases": [
                { "name": "p1", "todos": [{ "id": "a", "content": "one", "status": "pending" }] },
                { "name": "p2", "todos": [{ "id": "b", "content": "two", "status": "completed" }] }
            ]
        });
        let todos = parse_cursor_todos_from_phases(&params);
        assert_eq!(todos.len(), 2);
        assert_eq!(todos[0].id, "a");
        assert_eq!(todos[1].content, "two");
    }

    #[test]
    fn merge_cursor_todos_replace_and_merge() {
        let mut existing = vec![CursorTodoDto {
            id: "1".into(),
            content: "old".into(),
            status: "pending".into(),
        }];
        merge_cursor_todos(
            &mut existing,
            vec![CursorTodoDto {
                id: "1".into(),
                content: "new".into(),
                status: "completed".into(),
            }],
            true,
        );
        assert_eq!(existing.len(), 1);
        assert_eq!(existing[0].content, "new");
        assert_eq!(existing[0].status, "completed");

        merge_cursor_todos(
            &mut existing,
            vec![CursorTodoDto {
                id: "x".into(),
                content: "only".into(),
                status: "pending".into(),
            }],
            false,
        );
        assert_eq!(existing.len(), 1);
        assert_eq!(existing[0].id, "x");
    }
}
