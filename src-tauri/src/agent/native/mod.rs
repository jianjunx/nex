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
pub mod home;
pub mod instructions;
pub mod provider;
pub mod session;
pub mod skills;
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
    /// Composite `<providerId>/<modelId>` selecting the active provider.
    model_id: String,
    /// Per-session reasoning-effort choice (Composer config option).
    reasoning: ReasoningControl,
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

    /// Reasoning effort actually applied for a session: the Composer choice,
    /// forced to `Off` once the model is known to reject `reasoning_effort`.
    fn effective_reasoning(cfg: &NativeAgentConfig, session: &NativeSession) -> ReasoningControl {
        match cfg.resolve_model(&session.model_id) {
            Some((_, m)) if m.reasoning_support == config::ReasoningSupport::No => {
                ReasoningControl::Off
            }
            _ => session.reasoning,
        }
    }

    /// The `reasoning` config option payload for `_meta.configOptions`,
    /// rendered by the Composer's generic config-option menu.
    fn reasoning_config_option(current: ReasoningControl) -> serde_json::Value {
        serde_json::json!({
            "id": "reasoning",
            "name": "Reasoning",
            "category": "reasoning",
            "currentValueId": current.as_str(),
            "options": [
                { "id": "off", "name": "Off" },
                { "id": "low", "name": "Low" },
                { "id": "medium", "name": "Medium" },
                { "id": "high", "name": "High" }
            ]
        })
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

        // Aggregate every configured provider's models into the session model
        // list; ids are composite `<providerId>/<modelId>`.
        let available_models: Vec<acp::ModelInfo> = cfg
            .providers
            .iter()
            .flat_map(|p| {
                p.models.iter().map(move |m| acp::ModelInfo {
                    model_id: acp::ModelId(Arc::from(format!("{}/{}", p.id, m.id).as_str())),
                    name: format!("{}/{}", p.name, m.id),
                    description: None,
                    meta: None,
                })
            })
            .collect();
        let current_model = cfg
            .default_selection()
            .unwrap_or_else(|| "deepseek/deepseek-chat".to_string());

        let session = NativeSession {
            cwd: args.cwd.clone(),
            mode_id: "code".to_string(),
            model_id: current_model.clone(),
            reasoning: ReasoningControl::Medium,
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
                    acp::SessionMode {
                        id: acp::SessionModeId(Arc::from("plan")),
                        name: "Plan".to_string(),
                        description: Some("Read-only research, then a step-by-step plan".to_string()),
                        meta: None,
                    },
                    acp::SessionMode {
                        id: acp::SessionModeId(Arc::from("auto")),
                        name: "Auto".to_string(),
                        description: Some("Run without per-tool approval prompts".to_string()),
                        meta: None,
                    },
                ],
                meta: None,
            }),
            models: if available_models.is_empty() {
                None
            } else {
                Some(acp::SessionModelState {
                    current_model_id: acp::ModelId(Arc::from(current_model.as_str())),
                    available_models,
                    meta: None,
                })
            },
            // The Composer reads `configOptions` out of `_meta` (see
            // `config_options_from_json` in acp_adapter).
            meta: Some(serde_json::json!({
                "configOptions": [Self::reasoning_config_option(ReasoningControl::Medium)]
            })),
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

        let mut cfg = self.load_config();
        let conn = self.inner.conn.borrow().clone();

        // Route to the provider owning the session's composite model id.
        // `raw_model_id` is the provider's native model name (no composite
        // prefix) and is what actually goes into the API request body.
        let Some((prov_base_url, prov_api_key, raw_model_id)) = cfg
            .resolve_model(&session.model_id)
            .map(|(p, m)| (p.base_url.clone(), p.api_key.clone(), m.id.clone()))
        else {
            self.emit_text(
                &args.session_id,
                &format!("未找到模型 {} 对应的供应商配置，请在设置中检查", session.model_id),
            )
            .await;
            self.inner.sessions.borrow_mut().insert(session_key, session);
            return Ok(acp::PromptResponse { stop_reason: acp::StopReason::EndTurn, meta: None });
        };

        // Seed the transcript with the byte-stable system prompt once, plus
        // the session's extension blocks: skills catalog (progressive
        // disclosure), user rules and the project AGENTS.md.
        if session.history.is_empty() {
            let mut sys = context::system_prompt(&session.cwd, &raw_model_id);
            let discovered = home::skills_dir()
                .map(|root| skills::discover(&root))
                .unwrap_or_default();
            for block in [
                skills::catalog_block(&discovered),
                instructions::rules_block(&session.cwd),
                instructions::agents_md_block(&session.cwd),
            ] {
                if !block.is_empty() {
                    sys.push_str("\n\n");
                    sys.push_str(block.trim_end());
                }
            }
            session.history.push(ChatMessage::system(sys));
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
        // Per-turn mode instructions (modes can change between turns, so this
        // lives in the user turn rather than the byte-stable system prompt).
        let user_text = mode_preamble(&session.mode_id, user_text);

        let stop_reason = match conn {
            Some(conn) => {
                let provider = Arc::new(provider::deepseek::DeepSeekProvider::new(
                    prov_base_url,
                    prov_api_key,
                ));
                let reasoning = Self::effective_reasoning(&cfg, &session);
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
                    model: raw_model_id.clone(),
                    reasoning,
                    max_sub_steps: cfg.agent.max_steps.min(20),
                    concurrency: (cfg.agent.max_subagent_concurrency as usize).max(1),
                    cwd: session.cwd.clone(),
                    bash_timeout,
                    archive_dir: archive_dir.clone(),
                    cancelled: session.cancelled.clone(),
                    auto_approve: session.mode_id == "auto",
                });

                let env = TurnEnv {
                    conn,
                    session_id: args.session_id.clone(),
                    provider: provider.clone(),
                    tool_specs: registry.specs(),
                    registry,
                    model: raw_model_id.clone(),
                    reasoning,
                    max_steps: cfg.agent.max_steps,
                    // `ask` and `plan` refuse write/execute tools; `auto`
                    // skips the per-tool approval popup instead.
                    read_only_mode: matches!(session.mode_id.as_str(), "ask" | "plan"),
                    auto_approve: session.mode_id == "auto",
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
                // Runtime reasoning-support detection: the provider strips
                // `reasoning_effort` and retries when the endpoint rejects it.
                // Remember the result so later turns skip the parameter.
                if provider.reasoning_downgraded()
                    && cfg.set_reasoning_support(&session.model_id, config::ReasoningSupport::No)
                {
                    let _ = cfg.save(&self.inner.config_path);
                    self.emit_text(
                        &args.session_id,
                        "提示：当前模型不支持推理强度参数，已自动关闭并记住该设置。",
                    )
                    .await;
                }
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
        // Only the four advertised modes are accepted; anything else is a
        // client bug and must not silently change session behavior.
        let mode = args.mode_id.0.as_ref();
        if !matches!(mode, "code" | "ask" | "plan" | "auto") {
            return Err(acp::Error::invalid_params()
                .with_data(format!("unknown session mode: {mode}")));
        }
        if let Some(s) = self.inner.sessions.borrow_mut().get_mut(args.session_id.0.as_ref()) {
            s.mode_id = mode.to_string();
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

    async fn ext_method(&self, args: acp::ExtRequest) -> acp::Result<acp::ExtResponse> {
        if args.method.as_ref() == "session/set_config_option" {
            let params: serde_json::Value =
                serde_json::from_str(args.params.get()).map_err(|e| {
                    acp::Error::invalid_params().with_data(format!("bad params: {e}"))
                })?;
            let session_id = params
                .get("sessionId")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string();
            let config_id = params.get("configId").and_then(|v| v.as_str()).unwrap_or_default();
            let value = params.get("value").and_then(|v| v.as_str()).unwrap_or_default();
            if config_id != "reasoning" {
                return Err(acp::Error::invalid_params()
                    .with_data(format!("unknown config option: {config_id}")));
            }
            let reasoning = ReasoningControl::parse(value);
            if let Some(s) = self.inner.sessions.borrow_mut().get_mut(session_id.as_str()) {
                s.reasoning = reasoning;
            }
            let payload = serde_json::json!({
                "configOptions": [Self::reasoning_config_option(reasoning)]
            });
            return Ok(Arc::from(
                serde_json::value::RawValue::from_string(payload.to_string())
                    .map_err(|e| acp::Error::internal_error().with_data(format!("{e}")))?,
            ));
        }
        Err(acp::Error::method_not_found())
    }
}

/// Prepends mode-specific instructions to the user text of every turn. Empty
/// for `code` (the default behavior) and `ask` (read-only enforcement alone
/// is enough).
fn mode_preamble(mode_id: &str, user_text: String) -> String {
    match mode_id {
        "plan" => format!(
            "[Mode: Plan] You are in plan mode: research with read-only tools only \
             (writes, edits and commands are refused). Produce a concrete, \
             step-by-step implementation plan — files to change, what changes in \
             each, how to verify — and end by asking for confirmation. Do not try \
             to make changes yourself.\n\n{user_text}"
        ),
        "auto" => format!(
            "[Mode: Auto] You are in auto mode: tools run without per-step user \
             approval, so move efficiently, but still verify your work and stop \
             when the task is done.\n\n{user_text}"
        ),
        _ => user_text,
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
                let ids: Vec<&str> = modes
                    .available_modes
                    .iter()
                    .map(|m| m.id.0.as_ref())
                    .collect();
                assert_eq!(ids, vec!["code", "ask", "plan", "auto"]);
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

    /// `new_session` aggregates configured providers into the model list and
    /// emits the `reasoning` config option in `_meta.configOptions`; ext_method
    /// updates the per-session choice and echoes the refreshed options.
    #[tokio::test(flavor = "current_thread")]
    async fn reasoning_config_option_round_trip() {
        let agent = NexNativeAgent::new(std::env::temp_dir());
        let session = agent
            .new_session(acp::NewSessionRequest {
                cwd: std::env::temp_dir(),
                mcp_servers: vec![],
                meta: None,
            })
            .await
            .expect("new_session failed");

        // Default config yields one provider with deepseek-chat; the model id
        // is the composite `<providerId>/<modelId>`.
        let models = session.models.expect("models");
        assert_eq!(models.current_model_id.0.as_ref(), "deepseek/deepseek-chat");
        assert_eq!(models.available_models[0].model_id.0.as_ref(), "deepseek/deepseek-chat");

        let meta = session.meta.as_ref().expect("_meta");
        let options = meta.get("configOptions").expect("configOptions");
        assert_eq!(options[0]["id"], "reasoning");
        assert_eq!(options[0]["currentValueId"], "medium");
        assert_eq!(options[0]["options"].as_array().expect("options").len(), 4);

        let response = agent
            .ext_method(acp::ExtRequest {
                method: Arc::from("session/set_config_option"),
                params: Arc::from(
                    serde_json::value::RawValue::from_string(
                        serde_json::json!({
                            "sessionId": session.session_id.0.to_string(),
                            "configId": "reasoning",
                            "value": "high"
                        })
                        .to_string(),
                    )
                    .expect("raw params"),
                ),
            })
            .await
            .expect("ext_method failed");
        let payload: serde_json::Value =
            serde_json::from_str(response.get()).expect("payload json");
        assert_eq!(payload["configOptions"][0]["currentValueId"], "high");

        let sessions = agent.inner.sessions.borrow();
        let s = sessions
            .get(session.session_id.0.as_ref())
            .expect("session");
        assert_eq!(s.reasoning, ReasoningControl::High);

        // Unknown config ids are rejected.
        let err = agent
            .ext_method(acp::ExtRequest {
                method: Arc::from("session/set_config_option"),
                params: Arc::from(
                    serde_json::value::RawValue::from_string(
                        serde_json::json!({ "configId": "nope", "value": "x" }).to_string(),
                    )
                    .expect("raw params"),
                ),
            })
            .await
            .expect_err("unknown config id must fail");
        assert!(err.to_string().contains("unknown config option"));
    }

    /// Minimal client stub for the wire-level test: the native agent never
    /// sends requests our way, so any inbound request is unexpected.
    struct PipeStubClient;

    impl acp::MessageHandler<acp::ClientSide> for PipeStubClient {
        async fn handle_request(
            &self,
            _req: acp::AgentRequest,
        ) -> acp::Result<acp::ClientResponse> {
            Err(acp::Error::method_not_found())
        }

        async fn handle_notification(&self, _n: acp::AgentNotification) -> acp::Result<()> {
            Ok(())
        }
    }

    /// Wire-level round trip through the duplex pipe: the decode layer only
    /// routes `_`-prefixed methods to `ext_method`, everything else answers
    /// method_not_found. Guards the exact bug where the unprefixed
    /// `session/set_config_option` was rejected over the wire while direct
    /// `ext_method` unit calls passed.
    #[tokio::test(flavor = "current_thread")]
    async fn set_config_option_round_trips_through_rpc_pipe() {
        // The in-process pipe spawns its IO tasks via `spawn_local`, so the
        // whole wire interaction must run inside a task::LocalSet.
        tokio::task::LocalSet::new()
            .run_until(async {
        let agent = NexNativeAgent::new(std::env::temp_dir());

        let (client_end, agent_end) = tokio::io::duplex(64 * 1024);
        let (agent_read, agent_write) = tokio::io::split(agent_end);
        let (agent_conn, agent_io) = acp::AgentSideConnection::new(
            agent.clone(),
            agent_write.compat_write(),
            agent_read.compat(),
            |fut| {
                tokio::task::spawn_local(fut);
            },
        );
        agent.set_conn(Arc::new(agent_conn));
        tokio::task::spawn_local(agent_io);

        let (client_read, client_write) = tokio::io::split(client_end);
        let (client_conn, client_io) = acp::ClientSideConnection::new(
            PipeStubClient,
            client_write.compat_write(),
            client_read.compat(),
            |fut| {
                tokio::task::spawn_local(fut);
            },
        );
        tokio::task::spawn_local(client_io);

        // `session/new` goes through the same decode layer and must still work.
        let new_resp = client_conn
            .request_raw(
                "session/new",
                serde_json::json!({
                    "cwd": std::env::temp_dir(),
                    "mcpServers": []
                }),
            )
            .await
            .expect("session/new over pipe");
        let session_id = new_resp["sessionId"].as_str().expect("sessionId").to_string();

        // `_`-prefixed extension method reaches ext_method and updates the session.
        let raw = client_conn
            .request_raw(
                "_session/set_config_option",
                serde_json::json!({
                    "sessionId": session_id,
                    "configId": "reasoning",
                    "value": "high"
                }),
            )
            .await
            .expect("set_config_option over pipe");
        assert_eq!(raw["configOptions"][0]["currentValueId"], "high");

        let sessions = agent.inner.sessions.borrow();
        let s = sessions.get(&session_id).expect("session");
        assert_eq!(s.reasoning, ReasoningControl::High);
        drop(sessions);

        // Without the `_` prefix the decode layer must reject the method.
        let err = client_conn
            .request_raw(
                "session/set_config_option",
                serde_json::json!({
                    "sessionId": session_id,
                    "configId": "reasoning",
                    "value": "high"
                }),
            )
            .await
            .expect_err("unprefixed ext method must fail");
        assert!(
            err.to_string().to_ascii_lowercase().contains("method not found"),
            "unexpected error: {err}"
        );
            })
            .await;
    }

    /// Regression: the `model` field sent to the provider must be the raw
    /// model name (e.g. `deepseek-chat`), NOT the composite
    /// `<providerId>/<modelId>` used for session routing. DeepSeek rejects the
    /// prefixed form with a 400.
    #[tokio::test(flavor = "current_thread")]
    async fn prompt_sends_raw_model_id_not_composite() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let captured: Arc<std::sync::Mutex<Option<String>>> =
            Arc::new(std::sync::Mutex::new(None));

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let cap = captured.clone();
        let server = tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut buf = [0u8; 8192];
            let mut acc = String::new();
            // Read until headers + full body (per Content-Length) are present.
            loop {
                let n = sock.read(&mut buf).await.unwrap();
                if n == 0 {
                    break;
                }
                acc.push_str(&String::from_utf8_lossy(&buf[..n]));
                if let Some(pos) = acc.find("\r\n\r\n") {
                    let cl: usize = acc[..pos]
                        .lines()
                        .find_map(|l| {
                            let l = l.to_ascii_lowercase();
                            l.strip_prefix("content-length:").map(|v| v.trim().parse().unwrap_or(0))
                        })
                        .unwrap_or(0);
                    let body_start = pos + 4;
                    if acc.len() - body_start >= cl {
                        let body = &acc[body_start..body_start + cl];
                        if let Ok(v) = serde_json::from_str::<serde_json::Value>(body) {
                            *cap.lock().unwrap() =
                                v.get("model").and_then(|m| m.as_str()).map(String::from);
                        }
                        break;
                    }
                }
            }
            // 400 without any `reasoning_effort` mention → no downgrade retry.
            let _ = sock
                .write_all(b"HTTP/1.1 400 Bad Request\r\nContent-Length: 2\r\n\r\nno")
                .await;
        });

        // Config whose provider points at the fake server.
        let dir = std::env::temp_dir().join(format!("nex-model-id-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let cfg = serde_json::json!({
            "providers": [{
                "id": "deepseek",
                "name": "DeepSeek",
                "baseUrl": format!("http://{addr}"),
                "apiKey": "sk-test",
                "models": [{ "id": "deepseek-chat", "reasoningSupport": "unknown" }]
            }],
            "defaultModel": null,
            "agent": { "maxSteps": 1, "contextWindow": 0, "bashTimeoutSecs": 10, "maxSubagentConcurrency": 1 }
        });
        std::fs::write(dir.join("nex-agent.json"), cfg.to_string()).unwrap();

        tokio::task::LocalSet::new()
            .run_until(async {
                let (client_end, agent_end) = tokio::io::duplex(64 * 1024);
                let agent = NexNativeAgent::new(dir.clone());
                let (agent_read, agent_write) = tokio::io::split(agent_end);
                let (agent_conn, agent_io) = acp::AgentSideConnection::new(
                    agent.clone(),
                    agent_write.compat_write(),
                    agent_read.compat(),
                    |fut| {
                        tokio::task::spawn_local(fut);
                    },
                );
                agent.set_conn(Arc::new(agent_conn));
                tokio::task::spawn_local(agent_io);

                let chunks: Rc<RefCell<Vec<String>>> = Rc::new(RefCell::new(Vec::new()));
                let (client_read, client_write) = tokio::io::split(client_end);
                let (conn, client_io) = acp::ClientSideConnection::new(
                    TestClient { chunks: chunks.clone() },
                    client_write.compat_write(),
                    client_read.compat(),
                    |fut| {
                        tokio::task::spawn_local(fut);
                    },
                );
                tokio::task::spawn_local(client_io);

                let session = conn
                    .new_session(acp::NewSessionRequest {
                        cwd: dir.clone(),
                        mcp_servers: vec![],
                        meta: None,
                    })
                    .await
                    .expect("new_session");

                // The provider 400s; the turn still completes with the error streamed.
                let _ = conn
                    .prompt(acp::PromptRequest {
                        session_id: session.session_id.clone(),
                        prompt: vec![acp::ContentBlock::Text(acp::TextContent {
                            annotations: None,
                            text: "hi".to_string(),
                            meta: None,
                        })],
                        meta: None,
                    })
                    .await
                    .expect("prompt");
            })
            .await;

        tokio::time::timeout(std::time::Duration::from_secs(5), server)
            .await
            .expect("server timed out")
            .unwrap();
        assert_eq!(
            captured.lock().unwrap().as_deref(),
            Some("deepseek-chat"),
            "API must receive the raw model id, not the composite provider/model id"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
