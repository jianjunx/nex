//! ACP-over-stdio adapter: the v1 concrete agent transport.
//!
//! Nex is the *client* side of ACP: it implements [`acp::Client`] to receive
//! session updates and permission requests from the agent, and drives the agent
//! through [`acp::ClientSideConnection`] (initialize / new_session / prompt /
//! cancel). This is the official `agent_client_protocol` SDK — the same
//! transport Zed's `acp.rs` uses — so no hand-rolled JSON-RPC here.
//!
//! The SDK spawns connection handler tasks as `LocalBoxFuture`s (not `Send`),
//! so each session owns a dedicated thread running a current-thread tokio
//! runtime with a `LocalSet`. The `ClientSideConnection` itself is `Send`, so
//! after the initialize + new_session handshake it is handed back to the
//! manager and Tauri commands call `prompt`/`cancel` on it directly.
//!
//! Handshake failures are enriched with the agent's stderr tail and exit status
//! (see `diag`) so the frontend's error is self-explanatory instead of the
//! opaque `server shut down unexpectedly`.

use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use agent_client_protocol::{self as acp, Agent as _};
use tauri::{AppHandle, Emitter};
use tokio::sync::oneshot;
use tokio_util::compat::{TokioAsyncReadCompatExt, TokioAsyncWriteCompatExt};

use super::launch::{spawn_agent, LaunchSpec};
use super::types::{AgentNotification, AgentPermissionRequest, AgentSessionTerminated, PermissionOption};
use crate::error::NexError;

/// Event names; must match the `EVENTS` constants in `src/bridge/events.ts`.
const AGENT_NOTIFICATION_EVENT: &str = "agent-notification";
const AGENT_PERMISSION_REQUEST_EVENT: &str = "agent-permission-request";
const AGENT_SESSION_TERMINATED_EVENT: &str = "agent-session-terminated";

/// Upper bound for the initialize + new_session handshake. Without this a
/// spawned-but-unresponsive agent (wrong flags, waiting on auth, protocol
/// mismatch) would leave `agent_create_session` pending forever and the
/// frontend's Create button looking dead.
const HANDSHAKE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// How many recent stderr lines to retain for enriching handshake errors.
const STDERR_TAIL_LINES: usize = 50;

/// A permission request that is waiting for the user's answer. Dropping `tx`
/// without sending resolves the pending handler with `Cancelled`.
struct PendingPermission {
    session_key: String,
    tx: oneshot::Sender<acp::RequestPermissionOutcome>,
}

/// One live agent session. Held behind `Arc` so commands can use the connection
/// without holding the sessions lock across `.await`s.
struct SessionHandle {
    conn: acp::ClientSideConnection,
    /// The session id assigned by the agent during `session/new`.
    agent_session_id: acp::SessionId,
    #[allow(dead_code)]
    conversation_id: String,
    /// Guards against overlapping `session/prompt` turns on one session.
    prompt_in_flight: AtomicBool,
    /// Dropped on session removal / manager shutdown, which signals the
    /// session thread to kill the agent process.
    _shutdown: oneshot::Sender<()>,
}

/// Manages active ACP sessions, keyed by a Nex-generated session id (the id
/// returned to the frontend by `agent_create_session`). This is the ACP-stdio
/// transport; `super::server::AgentSessionManager` wraps it behind a
/// method-agnostic facade.
pub struct AcpSessionManager {
    sessions: Arc<Mutex<HashMap<String, Arc<SessionHandle>>>>,
    /// Permission requests awaiting a user answer, keyed by request id.
    pending_permissions: Arc<Mutex<HashMap<String, PendingPermission>>>,
}

/// ACP `Client` implementation for one session: forwards session notifications
/// and permission requests from the agent to the frontend as Tauri events.
struct NexAcpClient {
    app: AppHandle,
    session_key: String,
    pending_permissions: Arc<Mutex<HashMap<String, PendingPermission>>>,
}

impl acp::Client for NexAcpClient {
    async fn session_notification(&self, args: acp::SessionNotification) -> Result<(), acp::Error> {
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
    ) -> Result<acp::RequestPermissionResponse, acp::Error> {
        let request_id = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = oneshot::channel();
        self.pending_permissions.lock().unwrap().insert(
            request_id.clone(),
            PendingPermission { session_key: self.session_key.clone(), tx },
        );

        let options = args
            .options
            .iter()
            .map(|o| PermissionOption { option_id: o.id.to_string(), label: o.name.clone() })
            .collect();
        let _ = self.app.emit(
            AGENT_PERMISSION_REQUEST_EVENT,
            AgentPermissionRequest { session_id: self.session_key.clone(), request_id, options },
        );

        // A dropped sender means the session ended (or was cancelled) before
        // the user answered; the protocol requires `Cancelled` in that case.
        let outcome = rx.await.unwrap_or(acp::RequestPermissionOutcome::Cancelled);
        Ok(acp::RequestPermissionResponse { outcome })
    }

    // Filesystem capabilities are not advertised (`ClientCapabilities::default()`
    // reports them as unsupported), so well-behaved agents never call these.
    async fn write_text_file(&self, _args: acp::WriteTextFileRequest) -> Result<(), acp::Error> {
        Err(acp::Error::method_not_found())
    }

    async fn read_text_file(&self, _args: acp::ReadTextFileRequest) -> Result<acp::ReadTextFileResponse, acp::Error> {
        Err(acp::Error::method_not_found())
    }
}

impl AcpSessionManager {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
            pending_permissions: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Spawns the agent described by `spec`, performs the ACP initialize +
    /// new_session handshake, and returns the Nex session id on success.
    pub async fn create_session(
        &self,
        app: &AppHandle,
        conversation_id: &str,
        spec: LaunchSpec,
    ) -> Result<String, NexError> {
        let session_key = uuid::Uuid::new_v4().to_string();
        let (init_tx, init_rx) =
            oneshot::channel::<Result<(acp::ClientSideConnection, acp::SessionId), NexError>>();
        let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();

        let thread_app = app.clone();
        let thread_key = session_key.clone();
        let thread_sessions = Arc::clone(&self.sessions);
        let thread_pending = Arc::clone(&self.pending_permissions);

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
                        thread_sessions,
                        init_tx,
                        shutdown_rx,
                    )
                    .await;
                });
            })
            .map_err(|e| NexError::Agent(format!("failed to spawn session thread: {e}")))?;

        let (conn, agent_session_id) = init_rx
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
        Ok(session_key)
    }

    /// Sends a user prompt and resolves when the agent finishes the turn.
    /// Session updates stream to the frontend via `agent-notification` events
    /// while this is in flight.
    pub async fn send_prompt(&self, session_id: &str, content: &str) -> Result<(), NexError> {
        let handle = self.session(session_id)?;
        if handle
            .prompt_in_flight
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return Err(NexError::Agent("a prompt is already in flight for this session".to_string()));
        }
        let result = handle
            .conn
            .prompt(acp::PromptRequest {
                session_id: handle.agent_session_id.clone(),
                prompt: vec![content.into()],
            })
            .await;
        handle.prompt_in_flight.store(false, Ordering::SeqCst);
        result.map(|_| ()).map_err(NexError::from)
    }

    /// Cancels the current prompt turn. Per the ACP spec, any pending
    /// permission requests for the session are resolved with `Cancelled`.
    pub async fn cancel(&self, session_id: &str) -> Result<(), NexError> {
        let handle = self.session(session_id)?;
        self.resolve_session_permissions(session_id, Some(acp::RequestPermissionOutcome::Cancelled));
        handle
            .conn
            .cancel(acp::CancelNotification { session_id: handle.agent_session_id.clone() })
            .await
            .map_err(NexError::from)
    }

    /// Delivers the user's answer to a pending permission request.
    /// `option_id: None` means the user dismissed/denied, which maps to the
    /// ACP `cancelled` outcome.
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

    /// Removes the session; the agent process is killed once the last handle
    /// is dropped (via the shutdown signal to the session thread).
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

    /// Resolves every pending permission request for a session. With `Some`
    /// the given outcome is sent; with `None` the senders are dropped, which
    /// the handler observes as `Cancelled`.
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
}

/// Body of a session thread: spawn the agent, run the ACP handshake, hand the
/// connection back through `init_tx`, then keep the connection's I/O alive
/// until the agent exits or the session is shut down.
#[allow(clippy::too_many_arguments)]
async fn run_session(
    app: AppHandle,
    session_key: String,
    spec: LaunchSpec,
    pending_permissions: Arc<Mutex<HashMap<String, PendingPermission>>>,
    sessions: Arc<Mutex<HashMap<String, Arc<SessionHandle>>>>,
    init_tx: oneshot::Sender<Result<(acp::ClientSideConnection, acp::SessionId), NexError>>,
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

    // Capture the agent's stderr both into the app log and into a bounded ring
    // buffer we can quote if the handshake fails — a `claude`-not-found under
    // `cmd /c`, an auth prompt, or a protocol mismatch otherwise vanishes.
    let stderr_tail: Arc<Mutex<VecDeque<String>>> = Arc::new(Mutex::new(VecDeque::new()));
    if let Some(stderr) = child.stderr.take() {
        drain_stderr(stderr, program.clone(), Arc::clone(&stderr_tail));
    }

    // The ACP SDK speaks futures-io; tokio-util's compat layer bridges the
    // child's tokio-based stdio pipes.
    let outgoing = child.stdin.take().expect("agent stdin not piped").compat_write();
    let incoming = child.stdout.take().expect("agent stdout not piped").compat();

    let client = NexAcpClient {
        app: app.clone(),
        session_key: session_key.clone(),
        pending_permissions: Arc::clone(&pending_permissions),
    };
    let (conn, io_task) = acp::ClientSideConnection::new(client, outgoing, incoming, |fut| {
        tokio::task::spawn_local(fut);
    });

    // Drives the JSON-RPC I/O; completes when the agent closes its stdout
    // (process exit) or the connection is torn down.
    let (io_done_tx, io_done_rx) = oneshot::channel::<()>();
    tokio::task::spawn_local(async move {
        if let Err(e) = io_task.await {
            log::error!("agent session io failed: {e}");
        }
        let _ = io_done_tx.send(());
    });

    let handshake = tokio::time::timeout(HANDSHAKE_TIMEOUT, async {
        conn.initialize(acp::InitializeRequest {
            protocol_version: acp::V1,
            client_capabilities: acp::ClientCapabilities::default(),
        })
        .await
        .map_err(NexError::from)?;
        let response = conn
            .new_session(acp::NewSessionRequest { cwd: PathBuf::from(&cwd), mcp_servers: Vec::new() })
            .await
            .map_err(NexError::from)?;
        Ok(response.session_id)
    })
    .await;

    let handshake: Result<acp::SessionId, NexError> = match handshake {
        Ok(Ok(agent_session_id)) => Ok(agent_session_id),
        // The agent rejected the handshake (e.g. closed stdout -> "server shut
        // down unexpectedly"); enrich with stderr tail + exit status.
        Ok(Err(e)) => Err(enrich(e, &mut child, &stderr_tail, &program, &spec.args)),
        Err(_) => Err(NexError::Agent(format!(
            "agent `{program}` did not complete the ACP handshake within {}s{}",
            HANDSHAKE_TIMEOUT.as_secs(),
            diag(&mut child, &stderr_tail, &program, &spec.args)
        ))),
    };

    match handshake {
        Ok(agent_session_id) => {
            if init_tx.send(Ok((conn, agent_session_id))).is_err() {
                // The caller gave up waiting; nothing owns the connection.
                let _ = child.kill().await;
                return;
            }
        }
        Err(e) => {
            let _ = init_tx.send(Err(e));
            let _ = child.kill().await;
            return;
        }
    }

    // The connection now lives in the SessionHandle. Keep the local task set
    // running (I/O task + permission/notification handlers) until the agent
    // exits or the session is removed / the manager is dropped.
    tokio::select! {
        _ = io_done_rx => {},
        _ = shutdown_rx => {},
    }

    // start_kill is a single synchronous syscall (unlike `kill().await`, which
    // also waits for reaping) — the session thread may be racing process exit
    // here, so make termination as likely as possible to actually land.
    let _ = child.start_kill();
    // Dropping the senders resolves pending handlers with `Cancelled`.
    let mut map = pending_permissions.lock().unwrap();
    let keys: Vec<String> = map
        .iter()
        .filter(|(_, p)| p.session_key == session_key)
        .map(|(k, _)| k.clone())
        .collect();
    for key in keys {
        map.remove(&key);
    }
    drop(map);

    sessions.lock().unwrap().remove(&session_key);
    let _ = app.emit(AGENT_SESSION_TERMINATED_EVENT, AgentSessionTerminated { session_id: session_key });
}

/// Builds a human-readable diagnostics suffix: the child's exit status (if it
/// has exited) plus the captured stderr tail.
fn diag(
    child: &mut tokio::process::Child,
    tail: &Mutex<VecDeque<String>>,
    program: &str,
    args: &[String],
) -> String {
    let mut out = String::new();
    out.push_str(&format!("\ncommand: {program} {}", args.join(" ")));
    match child.try_wait() {
        Ok(Some(status)) => out.push_str(&format!("\nagent process exited ({status})")),
        Ok(None) => out.push_str(
            "\nagent process still running but not responding on stdout \
             — the binary may not support ACP v1; try the agent CLI directly \
             to verify it accepts ACP-over-stdio protocol",
        ),
        Err(e) => out.push_str(&format!("\nfailed to query agent process status: {e}")),
    }
    let lines = tail.lock().unwrap();
    if !lines.is_empty() {
        out.push_str("\nagent stderr:");
        for line in lines.iter() {
            out.push_str(&format!("\n  {line}"));
        }
    }
    out
}

/// Appends `diag` to an existing agent error so the raw protocol message
/// (e.g. `server shut down unexpectedly`) is followed by actionable detail.
fn enrich(e: NexError, child: &mut tokio::process::Child, tail: &Mutex<VecDeque<String>>, program: &str, args: &[String]) -> NexError {
    match e {
        NexError::Agent(msg) => NexError::Agent(format!("{msg}{}", diag(child, tail, program, args))),
        other => other,
    }
}

/// Streams the agent's stderr into the app log (capped) and into `tail` (a
/// bounded ring buffer for error enrichment). Must be spawned on the session's
/// LocalSet (it outlives the handshake; the LocalSet runs until teardown).
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
