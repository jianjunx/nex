//! The in-process Nex native coding agent.
//!
//! `NexNativeAgent` implements the *agent* side of ACP (`acp::Agent`) and is
//! wired to Nex's client side over an in-memory duplex pipe (see
//! `acp_adapter::run_session_native`). Phase 1 delivers the real harness:
//! DeepSeek streaming, the tool-call main loop (`session.rs`), the builtin
//! tool set (`tools/`), and a byte-stable system prompt (`context.rs`).

use std::cell::RefCell;
use std::collections::HashMap;
use std::path::PathBuf;
use std::rc::Rc;
use std::sync::Arc;

use agent_client_protocol::{self as acp};

pub mod compact;
pub mod config;
pub mod context;
pub mod provider;
pub mod session;
pub mod tools;

pub use config::NativeAgentConfig;

use provider::{ChatMessage, ReasoningControl};
use session::TurnEnv;
use tools::{ToolCtx, ToolRegistry};

/// Per-session mutable state held by the native agent.
struct NativeSession {
    /// Session working dir (the tool sandbox root).
    cwd: PathBuf,
    mode_id: String,
    model_id: String,
    /// Set by `cancel`; the harness loop polls this to stop early.
    cancelled: Rc<std::cell::Cell<bool>>,
    /// Append-only OpenAI-format transcript (system prompt pushed lazily on
    /// the first turn so config edits take effect for fresh sessions).
    history: Vec<ChatMessage>,
    /// Background shell jobs survive across turns within a session.
    jobs: Rc<RefCell<tools::jobs::JobTable>>,
}

struct NativeInner {
    /// Agent-side connection used to push `session/update` notifications back
    /// to Nex. Installed right after `AgentSideConnection::new` returns.
    conn: RefCell<Option<Arc<acp::AgentSideConnection>>>,
    sessions: RefCell<HashMap<String, NativeSession>>,
    config_path: PathBuf,
}

/// A cloneable handle to the shared native-agent state. The instance handed to
/// `AgentSideConnection::new` and the one Nex keeps are both clones of this.
#[derive(Clone)]
pub struct NexNativeAgent {
    inner: Rc<NativeInner>,
}

impl NexNativeAgent {
    pub fn new(config_path: PathBuf) -> Self {
        Self {
            inner: Rc::new(NativeInner {
                conn: RefCell::new(None),
                sessions: RefCell::new(HashMap::new()),
                config_path,
            }),
        }
    }

    /// Installs the agent-side connection used to emit session notifications.
    /// Must be called once, after `AgentSideConnection::new`, before prompts.
    pub fn set_conn(&self, conn: Arc<acp::AgentSideConnection>) {
        *self.inner.conn.borrow_mut() = Some(conn);
    }

    /// Loads the persisted native-agent config (defaults when absent).
    pub fn load_config(&self) -> NativeAgentConfig {
        NativeAgentConfig::load(&self.inner.config_path)
    }

    async fn emit_text(&self, session_id: &acp::SessionId, text: &str) {
        let conn = self.inner.conn.borrow().clone();
        let Some(conn) = conn else { return };
        let notification = acp::SessionNotification {
            session_id: session_id.clone(),
            update: acp::SessionUpdate::AgentMessageChunk(acp::ContentChunk {
                content: acp::ContentBlock::Text(acp::TextContent {
                    annotations: None,
                    text: text.to_string(),
                    meta: None,
                }),
                meta: None,
            }),
            meta: None,
        };
        // Best-effort: a dropped client shouldn't fail the prompt turn.
        use acp::Client as _;
        let _ = conn.session_notification(notification).await;
    }
}

#[async_trait::async_trait(?Send)]
impl acp::Agent for NexNativeAgent {
    async fn initialize(&self, args: acp::InitializeRequest) -> acp::Result<acp::InitializeResponse> {
        Ok(acp::InitializeResponse {
            protocol_version: args.protocol_version,
            agent_capabilities: acp::AgentCapabilities {
                load_session: false,
                prompt_capabilities: acp::PromptCapabilities {
                    image: true,
                    audio: false,
                    embedded_context: true,
                    meta: None,
                },
                mcp_capabilities: acp::McpCapabilities::default(),
                meta: None,
            },
            auth_methods: vec![],
            agent_info: Some(acp::Implementation {
                name: "nex".to_string(),
                title: Some("Nex Agent".to_string()),
                version: env!("CARGO_PKG_VERSION").to_string(),
            }),
            meta: None,
        })
    }

    async fn authenticate(
        &self,
        _args: acp::AuthenticateRequest,
    ) -> acp::Result<acp::AuthenticateResponse> {
        // No auth: credentials come from the config file.
        Ok(acp::AuthenticateResponse { meta: None })
    }

    async fn new_session(&self, args: acp::NewSessionRequest) -> acp::Result<acp::NewSessionResponse> {
        let cfg = self.load_config();
        let session_id = acp::SessionId(Arc::from(uuid::Uuid::new_v4().to_string().as_str()));

        let session = NativeSession {
            cwd: args.cwd.clone(),
            mode_id: "code".to_string(),
            model_id: cfg.provider.model.clone(),
            cancelled: Rc::new(std::cell::Cell::new(false)),
            history: Vec::new(),
            jobs: Rc::new(RefCell::new(tools::jobs::JobTable::default())),
        };
        self.inner
            .sessions
            .borrow_mut()
            .insert(session_id.0.to_string(), session);

        Ok(acp::NewSessionResponse {
            session_id,
            modes: Some(acp::SessionModeState {
                current_mode_id: acp::SessionModeId(Arc::from("code")),
                available_modes: vec![
                    acp::SessionMode {
                        id: acp::SessionModeId(Arc::from("code")),
                        name: "Code".to_string(),
                        description: Some("Edit files and run tools".to_string()),
                        meta: None,
                    },
                    acp::SessionMode {
                        id: acp::SessionModeId(Arc::from("ask")),
                        name: "Ask".to_string(),
                        description: Some("Read-only questions and analysis".to_string()),
                        meta: None,
                    },
                ],
                meta: None,
            }),
            models: Some(acp::SessionModelState {
                current_model_id: acp::ModelId(Arc::from(cfg.provider.model.as_str())),
                available_models: vec![
                    acp::ModelInfo {
                        model_id: acp::ModelId(Arc::from("deepseek-chat")),
                        name: "DeepSeek Chat".to_string(),
                        description: Some("Fast general coding model".to_string()),
                        meta: None,
                    },
                    acp::ModelInfo {
                        model_id: acp::ModelId(Arc::from("deepseek-reasoner")),
                        name: "DeepSeek Reasoner".to_string(),
                        description: Some("Deep reasoning model".to_string()),
                        meta: None,
                    },
                ],
                meta: None,
            }),
            meta: None,
        })
    }

    async fn prompt(&self, args: acp::PromptRequest) -> acp::Result<acp::PromptResponse> {
        // Take the session out of the map for the whole turn (no borrows held
        // across awaits); it is restored afterwards.
        let session_key = args.session_id.0.to_string();
        let Some(mut session) = self.inner.sessions.borrow_mut().remove(&session_key) else {
            return Err(acp::Error::invalid_params());
        };
        session.cancelled.set(false);

        let cfg = self.load_config();
        let conn = self.inner.conn.borrow().clone();

        // Seed the transcript with the byte-stable system prompt once.
        if session.history.is_empty() {
            session.history.push(ChatMessage::system(context::system_prompt(
                &session.cwd,
                &session.model_id,
            )));
        }

        // Flatten the incoming prompt blocks into user text.
        let user_text = args
            .prompt
            .iter()
            .filter_map(|b| match b {
                acp::ContentBlock::Text(t) => Some(t.text.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n");

        let stop_reason = match conn {
            Some(conn) => {
                let provider = Arc::new(provider::deepseek::DeepSeekProvider::new(
                    cfg.provider.base_url.clone(),
                    cfg.provider.api_key.clone(),
                ));
                let registry = Rc::new(ToolRegistry::builtins());
                let archive_dir = session.cwd.join(".nex-archive");
                let bash_timeout = std::time::Duration::from_secs(cfg.agent.bash_timeout_secs);

                // Subagent orchestration support (task/fleet/read_subagent_result).
                let sub_registry = Rc::new(ToolRegistry::subagents());
                let harness = Rc::new(session::SubagentHarness {
                    conn: conn.clone(),
                    parent_session_id: args.session_id.clone(),
                    provider: provider.clone(),
                    tool_specs: sub_registry.specs(),
                    registry: sub_registry,
                    model: session.model_id.clone(),
                    reasoning: ReasoningControl::parse(&cfg.provider.reasoning),
                    max_sub_steps: cfg.agent.max_steps.min(20),
                    concurrency: (cfg.agent.max_subagent_concurrency as usize).max(1),
                    cwd: session.cwd.clone(),
                    bash_timeout,
                    archive_dir: archive_dir.clone(),
                    cancelled: session.cancelled.clone(),
                });

                let env = TurnEnv {
                    conn,
                    session_id: args.session_id.clone(),
                    provider,
                    tool_specs: registry.specs(),
                    registry,
                    model: session.model_id.clone(),
                    reasoning: ReasoningControl::parse(&cfg.provider.reasoning),
                    max_steps: cfg.agent.max_steps,
                    read_only_mode: session.mode_id == "ask",
                    cancelled: session.cancelled.clone(),
                    auto_allow: RefCell::new(std::collections::HashSet::new()),
                    tool_ctx: ToolCtx {
                        cwd: session.cwd.clone(),
                        bash_timeout,
                        archive_dir,
                        jobs: session.jobs.clone(),
                        harness: Some(harness),
                        mutations: Rc::new(RefCell::new(Vec::new())),
                    },
                    context_window: cfg.agent.context_window as u64,
                    usage: RefCell::new(provider::Usage::default()),
                };
                let stop = session::run_turn(&env, &mut session.history, &user_text).await;
                // Observability: report the turn's token accounting.
                let usage = env.usage.borrow().clone();
                log::info!(
                    "native agent turn done: prompt_tokens={} completion_tokens={} cache_hit_tokens={}",
                    usage.prompt_tokens,
                    usage.completion_tokens,
                    usage.cache_hit_tokens
                );
                stop
            }
            None => {
                // No connection (shouldn't happen in production wiring).
                self.emit_text(&args.session_id, "agent 连接未就绪").await;
                acp::StopReason::EndTurn
            }
        };

        self.inner.sessions.borrow_mut().insert(session_key, session);
        Ok(acp::PromptResponse { stop_reason, meta: None })
    }

    async fn cancel(&self, args: acp::CancelNotification) -> acp::Result<()> {
        if let Some(s) = self.inner.sessions.borrow().get(args.session_id.0.as_ref()) {
            s.cancelled.set(true);
        }
        Ok(())
    }

    async fn set_session_mode(
        &self,
        args: acp::SetSessionModeRequest,
    ) -> acp::Result<acp::SetSessionModeResponse> {
        if let Some(s) = self.inner.sessions.borrow_mut().get_mut(args.session_id.0.as_ref()) {
            s.mode_id = args.mode_id.0.to_string();
        }
        Ok(acp::SetSessionModeResponse { meta: None })
    }

    async fn set_session_model(
        &self,
        args: acp::SetSessionModelRequest,
    ) -> acp::Result<acp::SetSessionModelResponse> {
        if let Some(s) = self.inner.sessions.borrow_mut().get_mut(args.session_id.0.as_ref()) {
            s.model_id = args.model_id.0.to_string();
        }
        Ok(acp::SetSessionModelResponse { meta: None })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use agent_client_protocol::Agent as _;
    use tokio_util::compat::{TokioAsyncReadCompatExt, TokioAsyncWriteCompatExt};

    /// Minimal client that records streamed agent message chunks.
    struct TestClient {
        chunks: Rc<RefCell<Vec<String>>>,
    }

    #[async_trait::async_trait(?Send)]
    impl acp::Client for TestClient {
        async fn session_notification(&self, args: acp::SessionNotification) -> acp::Result<()> {
            if let acp::SessionUpdate::AgentMessageChunk(chunk) = &args.update {
                if let acp::ContentBlock::Text(t) = &chunk.content {
                    self.chunks.borrow_mut().push(t.text.clone());
                }
            }
            Ok(())
        }

        async fn request_permission(
            &self,
            _args: acp::RequestPermissionRequest,
        ) -> acp::Result<acp::RequestPermissionResponse> {
            Err(acp::Error::method_not_found())
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

        async fn ext_method(&self, _args: acp::ExtRequest) -> acp::Result<acp::ExtResponse> {
            Err(acp::Error::method_not_found())
        }

        async fn ext_notification(&self, _args: acp::ExtNotification) -> acp::Result<()> {
            Ok(())
        }
    }

    /// Phase 0 end-to-end handshake: the exact wiring `run_session_native`
    /// uses (duplex pipe + AgentSideConnection + ClientSideConnection,
    /// all `spawn_local` on one LocalSet) must complete initialize /
    /// new_session / prompt and stream the placeholder chunk.
    #[tokio::test(flavor = "current_thread")]
    async fn native_handshake_over_duplex() {
        let local = tokio::task::LocalSet::new();
        local
            .run_until(async {
                let (client_end, agent_end) = tokio::io::duplex(64 * 1024);

                let agent = NexNativeAgent::new(std::env::temp_dir());
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
                    let _ = agent_io_task.await;
                });

                let chunks: Rc<RefCell<Vec<String>>> = Rc::new(RefCell::new(Vec::new()));
                let (client_read, client_write) = tokio::io::split(client_end);
                let (conn, client_io_task) = acp::ClientSideConnection::new(
                    TestClient { chunks: chunks.clone() },
                    client_write.compat_write(),
                    client_read.compat(),
                    |fut| {
                        tokio::task::spawn_local(fut);
                    },
                );
                tokio::task::spawn_local(async move {
                    let _ = client_io_task.await;
                });

                let init = conn
                    .initialize(acp::InitializeRequest {
                        protocol_version: acp::VERSION,
                        client_capabilities: acp::ClientCapabilities::default(),
                        client_info: None,
                        meta: None,
                    })
                    .await
                    .expect("initialize failed");
                assert_eq!(init.agent_info.expect("agent_info").name, "nex");
                assert!(init.auth_methods.is_empty());

                let session = conn
                    .new_session(acp::NewSessionRequest {
                        cwd: std::env::temp_dir(),
                        mcp_servers: vec![],
                        meta: None,
                    })
                    .await
                    .expect("new_session failed");
                let modes = session.modes.expect("modes");
                assert_eq!(modes.current_mode_id.0.as_ref(), "code");
                assert_eq!(modes.available_modes.len(), 2);
                assert!(session.models.is_some());

                let response = conn
                    .prompt(acp::PromptRequest {
                        session_id: session.session_id.clone(),
                        prompt: vec![acp::ContentBlock::Text(acp::TextContent {
                            annotations: None,
                            text: "hello".to_string(),
                            meta: None,
                        })],
                        meta: None,
                    })
                    .await
                    .expect("prompt failed");
                assert!(matches!(response.stop_reason, acp::StopReason::EndTurn));
                // The turn streams at least one chunk (with no API key the real
                // DeepSeek request errors out and the error text is streamed).
                assert!(!chunks.borrow().is_empty());
            })
            .await;
    }
}
