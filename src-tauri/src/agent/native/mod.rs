//! The in-process Nex native coding agent.
//!
//! `NexNativeAgent` implements the *agent* side of ACP (`acp::Agent`) and is
//! wired to Nex's client side over an in-memory duplex pipe (see
//! `acp_adapter::run_session_native`). Phase 1 delivers the real harness:
//! DeepSeek streaming, the tool-call main loop (`session.rs`), the builtin
//! tool set (`tools/`), and a byte-stable system prompt (`context.rs`).

use std::cell::{Cell, RefCell};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::Arc;

use agent_client_protocol::{self as acp};

pub mod archive;
pub mod bundled;
pub mod capabilities;
pub mod commands;
pub mod compact;
pub mod config;
pub mod context;
pub mod home;
pub mod instructions;
pub mod mcp;
pub mod probe;
pub mod provider;
pub mod session;
pub mod skills;
pub mod tools;

pub use config::NativeAgentConfig;

use provider::{ChatMessage, Content, ContentPart, ReasoningControl};
use session::TurnEnv;
use tools::{ToolCtx, ToolRegistry};

/// Shared control knobs for one session.
///
/// Kept in [`NativeInner::handles`] for the whole session lifetime so
/// `set_session_mode` / `cancel` still work while `prompt` has checked the
/// [`NativeSession`] out of the map. `TurnEnv` clones the same `Rc`s and
/// re-reads them on every tool call (Auto mid-turn takes effect immediately).
struct SessionHandles {
    mode_id: Rc<RefCell<String>>,
    model_id: Rc<RefCell<String>>,
    reasoning: Rc<Cell<ReasoningControl>>,
    cancelled: Rc<Cell<bool>>,
    /// Tools the user chose "始终允许该工具" for; survives across turns.
    auto_allow: Rc<RefCell<HashSet<String>>>,
    /// Set when the session enters Plan; cleared after the user confirms
    /// execution (switch to code/auto, or Composer `set_session_mode`).
    /// Blocks `plan → ask → code` bypasses of the plan gate.
    plan_pending_confirm: Rc<Cell<bool>>,
}

/// Per-session mutable state held by the native agent.
struct NativeSession {
    /// Session working dir (the tool sandbox root).
    cwd: PathBuf,
    handles: SessionHandles,
    /// Append-only OpenAI-format transcript (system prompt pushed lazily on
    /// the first turn so config edits take effect for fresh sessions).
    history: Vec<ChatMessage>,
    /// Background shell jobs survive across turns within a session.
    jobs: Rc<RefCell<tools::jobs::JobTable>>,
    /// Connected MCP servers (one client per `mcp.json` entry); dropping the
    /// session kills their child processes.
    mcp: Vec<Rc<mcp::McpClient>>,
}

impl SessionHandles {
    fn new(model_id: String, reasoning: ReasoningControl) -> Self {
        Self {
            mode_id: Rc::new(RefCell::new("code".to_string())),
            model_id: Rc::new(RefCell::new(model_id)),
            reasoning: Rc::new(Cell::new(reasoning)),
            cancelled: Rc::new(Cell::new(false)),
            auto_allow: Rc::new(RefCell::new(HashSet::new())),
            plan_pending_confirm: Rc::new(Cell::new(false)),
        }
    }

    fn clone_handles(&self) -> Self {
        Self {
            mode_id: self.mode_id.clone(),
            model_id: self.model_id.clone(),
            reasoning: self.reasoning.clone(),
            cancelled: self.cancelled.clone(),
            auto_allow: self.auto_allow.clone(),
            plan_pending_confirm: self.plan_pending_confirm.clone(),
        }
    }
}

struct NativeInner {
    /// Agent-side connection used to push `session/update` notifications back
    /// to Nex. Installed right after `AgentSideConnection::new` returns.
    conn: RefCell<Option<Arc<acp::AgentSideConnection>>>,
    sessions: RefCell<HashMap<String, NativeSession>>,
    /// Survives `prompt` checkout; see [`SessionHandles`].
    handles: RefCell<HashMap<String, SessionHandles>>,
    config_path: PathBuf,
    /// Parent dir of `nex-agent.json` = the app-data dir. Session archives
    /// (compaction + subagent spills) live under `<app_data>/.nex-archive/`
    /// so the user's workspace and git status stay clean.
    archive_root: PathBuf,
}

/// A cloneable handle to the shared native-agent state. The instance handed to
/// `AgentSideConnection::new` and the one Nex keeps are both clones of this.
#[derive(Clone)]
pub struct NexNativeAgent {
    inner: Rc<NativeInner>,
}

impl NexNativeAgent {
    pub fn new(config_path: PathBuf) -> Self {
        let archive_root = config_path
            .parent()
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|| PathBuf::from("."));
        Self {
            inner: Rc::new(NativeInner {
                conn: RefCell::new(None),
                sessions: RefCell::new(HashMap::new()),
                handles: RefCell::new(HashMap::new()),
                config_path,
                archive_root,
            }),
        }
    }

    /// Per-session archive directory: `<app_data>/.nex-archive/<cwd-hash>/`.
    /// The hash keeps projects separated (and is stable across restarts) while
    /// keeping everything out of the user's workspace tree.
    fn archive_dir_for(&self, cwd: &Path) -> PathBuf {
        use std::hash::{Hash, Hasher};
        let mut h = std::collections::hash_map::DefaultHasher::new();
        cwd.hash(&mut h);
        let digest = format!("{:016x}", h.finish());
        self.inner.archive_root.join(".nex-archive").join(digest)
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
        let model_id = session.handles.model_id.borrow().clone();
        match cfg.resolve_model(&model_id) {
            Some((_, m)) if m.reasoning_support == config::ReasoningSupport::No => {
                ReasoningControl::Off
            }
            _ => session.handles.reasoning.get(),
        }
    }

    /// The `reasoning` config option payload for `_meta.configOptions`,
    /// rendered by the Composer's generic config-option menu. Returns `None`
    /// when the model has no controllable reasoning levels.
    fn reasoning_config_option(
        current: ReasoningControl,
        levels: &[String],
    ) -> Option<serde_json::Value> {
        if levels.is_empty() {
            return None;
        }
        let options: Vec<serde_json::Value> = levels
            .iter()
            .map(|id| {
                let ctrl = ReasoningControl::parse(id);
                serde_json::json!({
                    "id": id,
                    "name": ctrl.display_name(),
                })
            })
            .collect();
        let current = current.clamp_to(levels);
        Some(serde_json::json!({
            "id": "reasoning",
            "name": "思考",
            "category": "reasoning",
            "currentValueId": current.as_str(),
            "options": options
        }))
    }

    fn config_options_meta(current: ReasoningControl, levels: &[String]) -> serde_json::Value {
        match Self::reasoning_config_option(current, levels) {
            Some(opt) => serde_json::json!({ "configOptions": [opt] }),
            None => serde_json::json!({ "configOptions": [] }),
        }
    }

    /// Session `_meta` for `session/new` / `session/load`: config options plus
    /// the slash-command catalog. Commands also go here (not only via
    /// `AvailableCommandsUpdate`) so the Composer can render them even when the
    /// notification races ahead of frontend session registration.
    fn session_create_meta(
        current: ReasoningControl,
        levels: &[String],
        commands: &[commands::Command],
    ) -> serde_json::Value {
        let mut meta = Self::config_options_meta(current, levels);
        let cmds: Vec<serde_json::Value> = commands
            .iter()
            .map(|c| {
                let mut obj = serde_json::json!({
                    "name": c.name,
                    "description": c.description,
                });
                if let Some(hint) = &c.argument_hint {
                    obj["input"] = serde_json::json!({ "hint": hint });
                }
                obj
            })
            .collect();
        meta["availableCommands"] = serde_json::Value::Array(cmds);
        meta
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

    /// Model list advertised on `session/new` / `session/load`.
    fn available_models(cfg: &NativeAgentConfig) -> Vec<acp::ModelInfo> {
        cfg.providers
            .iter()
            .flat_map(|p| {
                p.models.iter().map(move |m| acp::ModelInfo {
                    model_id: acp::ModelId(Arc::from(format!("{}/{}", p.id, m.id).as_str())),
                    name: m.id.clone(),
                    description: Some(p.name.clone()),
                    meta: Some(serde_json::json!({ "vision": m.capabilities.vision })),
                })
            })
            .collect()
    }

    fn session_mode_state(current_mode_id: &str) -> acp::SessionModeState {
        acp::SessionModeState {
            current_mode_id: acp::SessionModeId(Arc::from(current_mode_id)),
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
                    description: Some(
                        "Read-only research, then a step-by-step plan".to_string(),
                    ),
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
        }
    }

    /// Connect MCP servers and publish slash-command catalog (shared by new/load).
    ///
    /// Returns the discovered command catalog so callers can also embed it in
    /// the `session/new` / `session/load` `_meta` (avoids a create-session race
    /// where `AvailableCommandsUpdate` arrives before the frontend registers
    /// the session id).
    async fn setup_session_extras(
        &self,
        session_id: &acp::SessionId,
        cwd: &Path,
        cfg: &NativeAgentConfig,
    ) -> Vec<commands::Command> {
        if let Some(home) = home::nex_home() {
            bundled::ensure_bundled(&home);
        }

        for (name, server_cfg) in mcp::load_configs(cwd) {
            if cfg.disabled_mcp_servers.iter().any(|d| d == &name) {
                continue;
            }
            match mcp::McpClient::connect(&name, &server_cfg).await {
                Ok(client) => {
                    log::info!(
                        "MCP server `{name}` connected with {} tool(s)",
                        client.tools.len()
                    );
                    self.inner
                        .sessions
                        .borrow_mut()
                        .get_mut(session_id.0.as_ref())
                        .map(|s| s.mcp.push(Rc::new(client)));
                }
                Err(e) => log::warn!("{e}"),
            }
        }

        let commands = commands::discover(cwd);
        if let Some(conn) = self.inner.conn.borrow().clone() {
            if !commands.is_empty() {
                let notification = acp::SessionNotification {
                    session_id: session_id.clone(),
                    update: acp::SessionUpdate::AvailableCommandsUpdate(
                        acp::AvailableCommandsUpdate {
                            available_commands: commands
                                .iter()
                                .map(|c| acp::AvailableCommand {
                                    name: c.name.clone(),
                                    description: c.description.clone(),
                                    input: c.argument_hint.clone().map(|hint| {
                                        acp::AvailableCommandInput::Unstructured { hint }
                                    }),
                                    meta: None,
                                })
                                .collect(),
                            meta: None,
                        },
                    ),
                    meta: None,
                };
                use acp::Client as _;
                let _ = conn.session_notification(notification).await;
            }
        }
        commands
    }
}

#[async_trait::async_trait(?Send)]
impl acp::Agent for NexNativeAgent {
    async fn initialize(
        &self,
        args: acp::InitializeRequest,
    ) -> acp::Result<acp::InitializeResponse> {
        Ok(acp::InitializeResponse {
            protocol_version: args.protocol_version,
            agent_capabilities: acp::AgentCapabilities {
                load_session: true,
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

    async fn new_session(
        &self,
        args: acp::NewSessionRequest,
    ) -> acp::Result<acp::NewSessionResponse> {
        let cfg = self.load_config();
        // Stable id when the client passes `meta.nexConversationId` (Nex uses
        // the conversation id so `session/load` can resume across restarts).
        let session_id = args
            .meta
            .as_ref()
            .and_then(|m| m.get("nexConversationId"))
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .map(|id| acp::SessionId(Arc::from(id)))
            .unwrap_or_else(|| {
                acp::SessionId(Arc::from(uuid::Uuid::new_v4().to_string().as_str()))
            });

        // Aggregate every configured provider's models into the session model
        // list; ids are composite `<providerId>/<modelId>`. Display name is the
        // bare model id; provider name goes in `description` for Composer grouping.
        let available_models = Self::available_models(&cfg);
        let current_model = cfg
            .default_selection()
            .unwrap_or_else(|| "deepseek/deepseek-chat".to_string());
        let reasoning_levels = cfg.reasoning_levels_for(&current_model);
        let initial_reasoning = ReasoningControl::Medium.clamp_to(&reasoning_levels);

        let handles = SessionHandles::new(current_model.clone(), initial_reasoning);
        // Canonicalize the workspace root: the sandbox (`resolve_within`) and
        // every file/bash tool trust this path, and a non-canonical cwd would
        // let a symlinked project root alias the sandbox boundaries.
        let cwd = args
            .cwd
            .canonicalize()
            .map_err(|e| {
                acp::Error::invalid_params().with_data(format!(
                    "cwd `{}` is not a valid workspace directory: {e}",
                    args.cwd.display()
                ))
            })?;
        let session = NativeSession {
            cwd: cwd.clone(),
            handles: handles.clone_handles(),
            history: Vec::new(),
            jobs: Rc::new(RefCell::new(tools::jobs::JobTable::default())),
            mcp: Vec::new(),
        };
        self.inner
            .handles
            .borrow_mut()
            .insert(session_id.0.to_string(), handles);
        self.inner
            .sessions
            .borrow_mut()
            .insert(session_id.0.to_string(), session);

        let slash_commands = self
            .setup_session_extras(&session_id, &cwd, &cfg)
            .await;

        Ok(acp::NewSessionResponse {
            session_id,
            modes: Some(Self::session_mode_state("code")),
            models: if available_models.is_empty() {
                None
            } else {
                Some(acp::SessionModelState {
                    current_model_id: acp::ModelId(Arc::from(current_model.as_str())),
                    available_models,
                    meta: None,
                })
            },
            // Composer reads `configOptions` + `availableCommands` from `_meta`
            // (see `config_options_from_json` / `available_commands_from_json`).
            meta: Some(Self::session_create_meta(
                initial_reasoning,
                &reasoning_levels,
                &slash_commands,
            )),
        })
    }

    async fn load_session(
        &self,
        args: acp::LoadSessionRequest,
    ) -> acp::Result<acp::LoadSessionResponse> {
        let session_key = args.session_id.0.to_string();
        let Some(arch) = archive::load(&session_key) else {
            return Err(acp::Error::invalid_params()
                .with_data(format!("no archived session for `{session_key}`")));
        };

        let cfg = self.load_config();
        let available_models = Self::available_models(&cfg);
        let current_model = if cfg.resolve_model(&arch.model_id).is_some() {
            arch.model_id.clone()
        } else {
            cfg.default_selection()
                .unwrap_or_else(|| "deepseek/deepseek-chat".to_string())
        };
        let reasoning_levels = cfg.reasoning_levels_for(&current_model);
        let initial_reasoning = ReasoningControl::Medium.clamp_to(&reasoning_levels);

        let mode_id = match arch.mode_id.as_str() {
            "code" | "ask" | "plan" | "auto" => arch.mode_id.clone(),
            _ => "code".to_string(),
        };

        let handles = SessionHandles::new(current_model.clone(), initial_reasoning);
        *handles.mode_id.borrow_mut() = mode_id.clone();
        // Restored Plan sessions still need an explicit confirm before execute.
        if mode_id == "plan" {
            handles.plan_pending_confirm.set(true);
        }
        // Prefer the client's current cwd (project may have moved).
        let cwd = if args.cwd.as_os_str().is_empty() {
            arch.cwd.clone()
        } else {
            args.cwd.clone()
        };
        let cwd = cwd.canonicalize().map_err(|e| {
            acp::Error::invalid_params().with_data(format!(
                "cwd `{}` is not a valid workspace directory: {e}",
                cwd.display()
            ))
        })?;
        let session = NativeSession {
            cwd: cwd.clone(),
            handles: handles.clone_handles(),
            history: arch.history,
            jobs: Rc::new(RefCell::new(tools::jobs::JobTable::default())),
            mcp: Vec::new(),
        };
        self.inner
            .handles
            .borrow_mut()
            .insert(session_key.clone(), handles);
        self.inner
            .sessions
            .borrow_mut()
            .insert(session_key, session);

        let slash_commands = self
            .setup_session_extras(&args.session_id, &cwd, &cfg)
            .await;

        Ok(acp::LoadSessionResponse {
            modes: Some(Self::session_mode_state(&mode_id)),
            models: if available_models.is_empty() {
                None
            } else {
                Some(acp::SessionModelState {
                    current_model_id: acp::ModelId(Arc::from(current_model.as_str())),
                    available_models,
                    meta: None,
                })
            },
            meta: Some(Self::session_create_meta(
                initial_reasoning,
                &reasoning_levels,
                &slash_commands,
            )),
        })
    }

    async fn prompt(&self, args: acp::PromptRequest) -> acp::Result<acp::PromptResponse> {
        // Take the session out of the map for the whole turn (no borrows held
        // across awaits); it is restored afterwards.
        let session_key = args.session_id.0.to_string();
        let Some(mut session) = self.inner.sessions.borrow_mut().remove(&session_key) else {
            return Err(acp::Error::invalid_params());
        };
        session.handles.cancelled.set(false);

        let mut cfg = self.load_config();
        let conn = self.inner.conn.borrow().clone();

        // Route to the provider owning the session's composite model id.
        // `raw_model_id` is the provider's native model name (no composite
        // prefix) and is what actually goes into the API request body.
        let model_id = session.handles.model_id.borrow().clone();
        let Some((prov_base_url, prov_api_key, raw_model_id, supports_vision)) = cfg
            .resolve_model(&model_id)
            .map(|(p, m)| {
                (
                    p.base_url.clone(),
                    p.api_key.clone(),
                    m.id.clone(),
                    m.capabilities.vision,
                )
            })
        else {
            self.emit_text(
                &args.session_id,
                &format!("未找到模型 {} 对应的供应商配置，请在设置中检查", model_id),
            )
            .await;
            self.inner
                .sessions
                .borrow_mut()
                .insert(session_key, session);
            return Ok(acp::PromptResponse {
                stop_reason: acp::StopReason::EndTurn,
                meta: None,
            });
        };

        // Seed the transcript with the byte-stable system prompt once, plus
        // the session's extension blocks: skills catalog (progressive
        // disclosure), user rules and the project AGENTS.md.
        if session.history.is_empty() {
            let mut sys = context::system_prompt(&session.cwd, &raw_model_id);
            if let Some(home) = home::nex_home() {
                bundled::ensure_bundled(&home);
            }
            let disabled = &cfg.disabled_skills;
            let discovered = home::skills_dir()
                .map(|root| {
                    skills::discover(&root)
                        .into_iter()
                        .filter(|s| !disabled.iter().any(|d| d == &s.name))
                        .collect::<Vec<_>>()
                })
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

        // Build the multimodal user turn from the incoming prompt blocks
        // (text + images + embedded/mentioned files).
        let mut parts = prompt_parts(&session.cwd, &args.prompt);
        // Models without vision cannot accept image_url parts — strip them and
        // warn so the turn still proceeds with text/context only.
        if !supports_vision && parts.iter().any(|p| p.typ == "image_url") {
            parts.retain(|p| p.typ != "image_url");
            self.emit_text(
                &args.session_id,
                "当前模型不支持图片输入，已忽略本次消息中的图片。",
            )
            .await;
        }
        // Slash-command expansion: when the text portion starts with a known
        // `/name`, replace the text parts with the command's template body.
        if !parts.is_empty() {
            let joined: String = parts
                .iter()
                .filter_map(|p| p.text.clone())
                .collect::<Vec<_>>()
                .join(" ");
            let commands = commands::discover(&session.cwd);
            if let Some(expanded) = commands::expand(&joined, &commands) {
                let mut next: Vec<ContentPart> = Vec::new();
                let mut replaced = false;
                for p in parts {
                    if p.typ == "text" && !replaced {
                        next.push(ContentPart::text(expanded.clone()));
                        replaced = true;
                    } else if p.typ != "text" {
                        next.push(p);
                    }
                }
                if !replaced {
                    next.push(ContentPart::text(expanded));
                }
                parts = next;
            }
        }
        // Per-turn mode instructions (modes can change between turns, so this
        // lives in the user turn rather than the byte-stable system prompt).
        if let Some(preamble) = mode_preamble(session.handles.mode_id.borrow().as_str()) {
            parts.insert(0, ContentPart::text(preamble));
        }
        // A single-text turn stays the plain string wire form (keeps legacy
        // archives and providers byte-identical); anything richer becomes parts.
        let content = if parts.is_empty() {
            Content::Text(String::new())
        } else if parts.len() == 1 && parts[0].typ == "text" {
            Content::Text(parts.remove(0).text.unwrap_or_default())
        } else {
            Content::Parts(parts)
        };

        let (stop_reason, had_mutations) = match conn {
            Some(conn) => {
                let provider = Arc::new(provider::deepseek::DeepSeekProvider::new(
                    prov_base_url,
                    prov_api_key,
                ));
                let reasoning = Self::effective_reasoning(&cfg, &session);
                // Session-level MCP tool proxies (`mcp__{server}__{tool}`), so
                // the model can call configured MCP servers this turn. Built as
                // a plain registry first, then shared behind `Rc`.
                let mut registry = ToolRegistry::builtins();
                for client in &session.mcp {
                    for info in &client.tools {
                        registry.add(Box::new(tools::mcp::McpProxy {
                            name: format!("mcp__{}__{}", client.name, info.name),
                            server: client.name.clone(),
                            tool_name: info.name.clone(),
                            description: info.description.clone(),
                            schema: info.schema.clone(),
                            client: client.clone(),
                        }));
                    }
                }
                let registry = Rc::new(registry);
                let archive_dir = self.archive_dir_for(&session.cwd);
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
                    max_sub_steps: cfg.agent.max_steps,
                    concurrency: (cfg.agent.max_subagent_concurrency as usize).max(1),
                    cwd: session.cwd.clone(),
                    bash_timeout,
                    archive_dir: archive_dir.clone(),
                    cancelled: session.handles.cancelled.clone(),
                    mode_id: session.handles.mode_id.clone(),
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
                    // Live mode handle: Auto/Ask/Plan take effect even when the
                    // user switches mid-turn (session is checked out of the map).
                    mode_id: session.handles.mode_id.clone(),
                    plan_pending_confirm: session.handles.plan_pending_confirm.clone(),
                    cancelled: session.handles.cancelled.clone(),
                    auto_allow: session.handles.auto_allow.clone(),
                    tool_ctx: ToolCtx {
                        cwd: session.cwd.clone(),
                        bash_timeout,
                        archive_dir,
                        jobs: session.jobs.clone(),
                        harness: Some(harness),
                        mutations: Rc::new(RefCell::new(Vec::new())),
                        mode_id: Some(session.handles.mode_id.clone()),
                    },
                    context_window: cfg.context_window_for(&model_id),
                    usage: RefCell::new(provider::Usage::default()),
                };
                let stop = session::run_turn(&env, &mut session.history, content).await;
                // Auto-review only cares about workspace file edits, not bash /
                // background jobs / other non-readonly tools.
                let had_mutations =
                    tools::mutations_include_workspace_edit(&env.tool_ctx.mutations.borrow());
                // Runtime reasoning-support detection: the provider strips
                // `reasoning_effort` and retries when the endpoint rejects it.
                // Remember the result so later turns skip the parameter.
                let model_id = session.handles.model_id.borrow().clone();
                if provider.reasoning_downgraded()
                    && cfg.set_reasoning_support(&model_id, config::ReasoningSupport::No)
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
                (stop, had_mutations)
            }
            None => {
                // No connection (shouldn't happen in production wiring).
                self.emit_text(&args.session_id, "agent 连接未就绪").await;
                (acp::StopReason::EndTurn, false)
            }
        };

        // Persist history so `session/load` can resume after app restart.
        // Strip multimodal image payloads — archives must stay small/safe.
        let _ = archive::save(
            &session_key,
            &archive::SessionArchive {
                cwd: session.cwd.clone(),
                model_id: session.handles.model_id.borrow().clone(),
                mode_id: session.handles.mode_id.borrow().clone(),
                history: archive::history_without_images(&session.history),
            },
        );

        self.inner
            .sessions
            .borrow_mut()
            .insert(session_key, session);
        Ok(acp::PromptResponse {
            stop_reason,
            // Frontend uses this to chain a visible `/review` when autoReview is on.
            meta: Some(serde_json::json!({
                "hadMutations": had_mutations,
            })),
        })
    }

    async fn cancel(&self, args: acp::CancelNotification) -> acp::Result<()> {
        // Prefer handles: the session entry is removed for the whole prompt turn.
        if let Some(h) = self.inner.handles.borrow().get(args.session_id.0.as_ref()) {
            h.cancelled.set(true);
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
            return Err(
                acp::Error::invalid_params().with_data(format!("unknown session mode: {mode}"))
            );
        }
        let (mode_cell, pending) = {
            let handles = self.inner.handles.borrow();
            let Some(h) = handles.get(args.session_id.0.as_ref()) else {
                return Err(acp::Error::invalid_params());
            };
            (h.mode_id.clone(), h.plan_pending_confirm.clone())
        };
        // Composer `set_session_mode` is an explicit user action: entering
        // plan arms the gate; leaving to code/auto via the UI counts as confirm.
        if mode == "plan" {
            pending.set(true);
        } else if matches!(mode, "code" | "auto") && pending.get() {
            pending.set(false);
        }
        *mode_cell.borrow_mut() = mode.to_string();
        Ok(acp::SetSessionModeResponse { meta: None })
    }

    async fn set_session_model(
        &self,
        args: acp::SetSessionModelRequest,
    ) -> acp::Result<acp::SetSessionModelResponse> {
        let cfg = self.load_config();
        let model_id = args.model_id.0.to_string();
        let levels = cfg.reasoning_levels_for(&model_id);
        let (model_cell, reasoning_cell) = {
            let handles = self.inner.handles.borrow();
            let Some(h) = handles.get(args.session_id.0.as_ref()) else {
                return Err(acp::Error::invalid_params());
            };
            (h.model_id.clone(), h.reasoning.clone())
        };
        *model_cell.borrow_mut() = model_id;
        let next = reasoning_cell.get().clamp_to(&levels);
        reasoning_cell.set(next);
        Ok(acp::SetSessionModelResponse {
            meta: Some(Self::config_options_meta(next, &levels)),
        })
    }

    async fn ext_method(&self, args: acp::ExtRequest) -> acp::Result<acp::ExtResponse> {
        if args.method.as_ref() == "session/set_config_option" {
            let params: serde_json::Value = serde_json::from_str(args.params.get())
                .map_err(|e| acp::Error::invalid_params().with_data(format!("bad params: {e}")))?;
            let session_id = params
                .get("sessionId")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string();
            let config_id = params
                .get("configId")
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            let value = params
                .get("value")
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            if config_id != "reasoning" {
                return Err(acp::Error::invalid_params()
                    .with_data(format!("unknown config option: {config_id}")));
            }
            let cfg = self.load_config();
            let (model_id, reasoning_cell) = {
                let handles = self.inner.handles.borrow();
                let Some(h) = handles.get(session_id.as_str()) else {
                    return Err(acp::Error::invalid_params());
                };
                let model_id = h.model_id.borrow().clone();
                let reasoning_cell = h.reasoning.clone();
                (model_id, reasoning_cell)
            };
            let levels = cfg.reasoning_levels_for(&model_id);
            let reasoning = ReasoningControl::parse(value).clamp_to(&levels);
            reasoning_cell.set(reasoning);
            let payload = Self::config_options_meta(reasoning, &levels);
            return Ok(Arc::from(
                serde_json::value::RawValue::from_string(payload.to_string())
                    .map_err(|e| acp::Error::internal_error().with_data(format!("{e}")))?,
            ));
        }
        Err(acp::Error::method_not_found())
    }
}

/// Mode-specific instructions prepended to every user turn; `None` for `code`
/// (the default) and `ask` (read-only enforcement alone is enough).
fn mode_preamble(mode_id: &str) -> Option<String> {
    match mode_id {
        "plan" => Some(format!(
            "[Mode: Plan] You are in plan mode: research with read-only tools only \
             (writes, edits and commands are refused). Produce a concrete, \
             step-by-step implementation plan — files to change, what changes in \
             each, how to verify — and end by asking for confirmation. Do not try \
             to make changes yourself. After the user confirms the plan, call \
             `switch_mode` with `code` or `auto` before editing or running commands."
        )),
        "auto" => Some(format!(
            "[Mode: Auto] You are in auto mode: tools run without per-step user \
             approval, so move efficiently, but still verify your work and stop \
             when the task is done."
        )),
        _ => None,
    }
}

/// Maximum size of a `file://` resource link injected into the prompt.
const RESOURCE_INJECT_LIMIT: u64 = 256 * 1024;

/// Converts incoming ACP prompt blocks into OpenAI content parts:
/// - `Text` → text part
/// - `Image` → `image_url` data-URI part (the client sends bare base64)
/// - `Resource` (text) → `[文件: uri]` + content
/// - `ResourceLink` → file read within the workspace (size-capped, text-only)
/// - anything else degrades to an explanatory text part
fn prompt_parts(cwd: &Path, blocks: &[acp::ContentBlock]) -> Vec<ContentPart> {
    let mut parts = Vec::new();
    for block in blocks {
        match block {
            acp::ContentBlock::Text(t) => parts.push(ContentPart::text(t.text.clone())),
            acp::ContentBlock::Image(img) => {
                let url = if img.data.starts_with("data:") {
                    img.data.clone()
                } else {
                    format!("data:{};base64,{}", img.mime_type, img.data)
                };
                parts.push(ContentPart::image(url));
            }
            acp::ContentBlock::Resource(res) => match &res.resource {
                acp::EmbeddedResourceResource::TextResourceContents(t) => {
                    parts.push(ContentPart::text(format!("[文件: {}]\n{}", t.uri, t.text)));
                }
                acp::EmbeddedResourceResource::BlobResourceContents(b) => {
                    parts.push(ContentPart::text(format!(
                        "[文件: {}] 二进制资源（{}），内容未注入",
                        b.uri,
                        b.mime_type.as_deref().unwrap_or("未知类型")
                    )))
                }
            },
            acp::ContentBlock::ResourceLink(link) => parts.push(resource_link_part(cwd, link)),
            acp::ContentBlock::Audio(_) => {
                parts.push(ContentPart::text(
                    "[音频块：当前模型不支持音频输入]".to_string(),
                ));
            }
        }
    }
    parts
}

/// Resolves a `file://` resource link inside the workspace and injects the
/// file text (256 KiB cap, text only). Every failure mode degrades to an
/// explanatory text part rather than failing the whole turn.
fn resource_link_part(cwd: &Path, link: &acp::ResourceLink) -> ContentPart {
    let name = if link.name.is_empty() {
        link.uri.clone()
    } else {
        link.name.clone()
    };
    let Some(path_str) = link.uri.strip_prefix("file://") else {
        return ContentPart::text(format!("[文件 {name} 无法注入: 非 file:// URI]"));
    };
    let Ok(path) = tools::resolve_within(cwd, path_str) else {
        return ContentPart::text(format!("[文件 {name} 无法注入: 超出工作区范围]"));
    };
    let Ok(meta) = std::fs::metadata(&path) else {
        return ContentPart::text(format!("[文件 {name} 无法注入: 读取失败]"));
    };
    if meta.len() > RESOURCE_INJECT_LIMIT {
        return ContentPart::text(format!(
            "[文件 {name} 无法注入: 大小 {} 字节超过上限]",
            meta.len()
        ));
    }
    let Ok(bytes) = std::fs::read(&path) else {
        return ContentPart::text(format!("[文件 {name} 无法注入: 读取失败]"));
    };
    if !matches!(
        content_inspector::inspect(&bytes),
        content_inspector::ContentType::UTF_8 | content_inspector::ContentType::UTF_8_BOM
    ) {
        return ContentPart::text(format!("[文件 {name} 无法注入: 二进制内容]"));
    }
    match String::from_utf8(bytes) {
        Ok(s) => ContentPart::text(format!("[文件: {}]\n{}", link.uri, s)),
        Err(_) => ContentPart::text(format!("[文件 {name} 无法注入: 非 UTF-8 文本]")),
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
        /// Summaries of every session update variant (`agent_message_chunk:…`,
        /// `available_commands_update:name=desc`, …) for notification tests.
        updates: Rc<RefCell<Vec<String>>>,
    }

    #[async_trait::async_trait(?Send)]
    impl acp::Client for TestClient {
        async fn session_notification(&self, args: acp::SessionNotification) -> acp::Result<()> {
            match &args.update {
                acp::SessionUpdate::AgentMessageChunk(chunk) => {
                    if let acp::ContentBlock::Text(t) = &chunk.content {
                        self.chunks.borrow_mut().push(t.text.clone());
                    }
                }
                acp::SessionUpdate::AvailableCommandsUpdate(cmds) => {
                    let summary: Vec<String> = cmds
                        .available_commands
                        .iter()
                        .map(|c| format!("{}={}", c.name, c.description))
                        .collect();
                    self.updates
                        .borrow_mut()
                        .push(format!("available_commands_update:{}", summary.join(",")));
                }
                other => {
                    self.updates.borrow_mut().push(format!("update:{other:?}"));
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
                    TestClient {
                        chunks: chunks.clone(),
                        updates: Rc::new(RefCell::new(Vec::new())),
                    },
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
        let tmp = tempfile::tempdir().unwrap();
        let mut cfg = NativeAgentConfig::default();
        cfg.providers[0].models = vec![crate::agent::native::capabilities::detect(
            "deepseek-reasoner",
        )];
        cfg.default_model = Some("deepseek/deepseek-reasoner".into());
        cfg.save(tmp.path()).unwrap();
        let agent = NexNativeAgent::new(tmp.path().to_path_buf());
        let session = agent
            .new_session(acp::NewSessionRequest {
                cwd: std::env::temp_dir(),
                mcp_servers: vec![],
                meta: None,
            })
            .await
            .expect("new_session failed");

        let models = session.models.expect("models");
        assert_eq!(
            models.current_model_id.0.as_ref(),
            "deepseek/deepseek-reasoner"
        );
        assert_eq!(models.available_models[0].name, "deepseek-reasoner");
        assert_eq!(
            models.available_models[0].description.as_deref(),
            Some("DeepSeek")
        );

        let meta = session.meta.as_ref().expect("_meta");
        let options = meta.get("configOptions").expect("configOptions");
        assert_eq!(options[0]["id"], "reasoning");
        // deepseek-reasoner ladder is off/low/high/max (no medium) → clamp prefers high.
        assert_eq!(options[0]["currentValueId"], "high");
        assert!(options[0]["options"].as_array().expect("options").len() >= 4);

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
        assert_eq!(s.handles.reasoning.get(), ReasoningControl::High);

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

    /// `prompt` checks the session out of the map for the whole turn. Mode
    /// changes must still land on the shared handles so Auto takes effect
    /// (and so the UI isn't lying about the current mode).
    #[tokio::test(flavor = "current_thread")]
    async fn set_session_mode_works_while_session_checked_out() {
        let agent = NexNativeAgent::new(std::env::temp_dir());
        let session = agent
            .new_session(acp::NewSessionRequest {
                cwd: std::env::temp_dir(),
                mcp_servers: vec![],
                meta: None,
            })
            .await
            .expect("new_session");
        let sid = session.session_id.0.to_string();

        // Simulate prompt checkout.
        let checked_out = agent
            .inner
            .sessions
            .borrow_mut()
            .remove(&sid)
            .expect("session present");
        assert!(agent.inner.sessions.borrow().get(&sid).is_none());

        agent
            .set_session_mode(acp::SetSessionModeRequest {
                session_id: session.session_id.clone(),
                mode_id: acp::SessionModeId(Arc::from("auto")),
                meta: None,
            })
            .await
            .expect("set_session_mode during checkout");

        assert_eq!(checked_out.handles.mode_id.borrow().as_str(), "auto");
        assert_eq!(
            agent
                .inner
                .handles
                .borrow()
                .get(&sid)
                .expect("handles survive checkout")
                .mode_id
                .borrow()
                .as_str(),
            "auto"
        );

        agent.inner.sessions.borrow_mut().insert(sid, checked_out);
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

    /// Wire-level round trip through the duplex pipe: the decode layer routes
    /// both `session/set_config_option` (standard ACP name, what external
    /// agents like Claude Code register) and the legacy `_`-prefixed spelling
    /// into `ext_method`. Guards the regression where the unprefixed form was
    /// rejected over the wire with `Method not found` while direct
    /// `ext_method` unit calls still passed.
    #[tokio::test(flavor = "current_thread")]
    async fn set_config_option_round_trips_through_rpc_pipe() {
        // The in-process pipe spawns its IO tasks via `spawn_local`, so the
        // whole wire interaction must run inside a task::LocalSet.
        tokio::task::LocalSet::new()
            .run_until(async {
                let tmp = tempfile::tempdir().unwrap();
                let mut cfg = NativeAgentConfig::default();
                cfg.providers[0].models = vec![crate::agent::native::capabilities::detect(
                    "deepseek-reasoner",
                )];
                cfg.default_model = Some("deepseek/deepseek-reasoner".into());
                cfg.save(tmp.path()).unwrap();
                let agent = NexNativeAgent::new(tmp.path().to_path_buf());

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
                let session_id = new_resp["sessionId"]
                    .as_str()
                    .expect("sessionId")
                    .to_string();

                // Unprefixed `session/set_config_option` (the standard ACP name external
                // agents like Claude Code register) reaches ext_method and updates the
                // session.
                let raw = client_conn
                    .request_raw(
                        "session/set_config_option",
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
                assert_eq!(s.handles.reasoning.get(), ReasoningControl::High);
                drop(sessions);

                // The legacy `_`-prefixed spelling still routes through ext_method so
                // older clients (and the historic `_session/...` wire form) keep working.
                let raw = client_conn
                    .request_raw(
                        "_session/set_config_option",
                        serde_json::json!({
                            "sessionId": session_id,
                            "configId": "reasoning",
                            "value": "low"
                        }),
                    )
                    .await
                    .expect("prefixed set_config_option over pipe");
                assert_eq!(raw["configOptions"][0]["currentValueId"], "low");

                let sessions = agent.inner.sessions.borrow();
                let s = sessions.get(&session_id).expect("session");
                assert_eq!(s.handles.reasoning.get(), ReasoningControl::Low);
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

        let captured: Arc<std::sync::Mutex<Option<String>>> = Arc::new(std::sync::Mutex::new(None));

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
                            l.strip_prefix("content-length:")
                                .map(|v| v.trim().parse().unwrap_or(0))
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
                    TestClient {
                        chunks: chunks.clone(),
                        updates: Rc::new(RefCell::new(Vec::new())),
                    },
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

    /// Wires an agent + recording client over a duplex pipe (same wiring as
    /// `run_session_native`) and returns both sides plus the recorded chunks
    /// and session-update summaries.
    fn duplex_pair(
        config_path: PathBuf,
    ) -> (
        NexNativeAgent,
        acp::ClientSideConnection,
        Rc<RefCell<Vec<String>>>,
        Rc<RefCell<Vec<String>>>,
    ) {
        let (client_end, agent_end) = tokio::io::duplex(64 * 1024);
        let agent = NexNativeAgent::new(config_path);
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
        let updates: Rc<RefCell<Vec<String>>> = Rc::new(RefCell::new(Vec::new()));
        let (client_read, client_write) = tokio::io::split(client_end);
        let (conn, client_io) = acp::ClientSideConnection::new(
            TestClient {
                chunks: chunks.clone(),
                updates: updates.clone(),
            },
            client_write.compat_write(),
            client_read.compat(),
            |fut| {
                tokio::task::spawn_local(fut);
            },
        );
        tokio::task::spawn_local(client_io);
        (agent, conn, chunks, updates)
    }

    /// Writes a config whose provider points at `addr` and returns its dir.
    fn provider_config(addr: std::net::SocketAddr) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("nex-native-{}", uuid::Uuid::new_v4()));
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
        dir
    }

    /// Spawns a TCP server that captures the first request body, answers 400
    /// (the turn then completes with the error streamed), and returns the
    /// address + captured body.
    async fn capture_server() -> (
        std::net::SocketAddr,
        Arc<std::sync::Mutex<Option<String>>>,
        tokio::task::JoinHandle<()>,
    ) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let captured: Arc<std::sync::Mutex<Option<String>>> = Arc::new(std::sync::Mutex::new(None));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let cap = captured.clone();
        let server = tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut buf = [0u8; 64 * 1024];
            let mut acc = String::new();
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
                            l.strip_prefix("content-length:")
                                .map(|v| v.trim().parse().unwrap_or(0))
                        })
                        .unwrap_or(0);
                    let body_start = pos + 4;
                    if acc.len() - body_start >= cl {
                        *cap.lock().unwrap() = Some(acc[body_start..body_start + cl].to_string());
                        break;
                    }
                }
            }
            let _ = sock
                .write_all(b"HTTP/1.1 400 Bad Request\r\nContent-Length: 2\r\n\r\nno")
                .await;
        });
        (addr, captured, server)
    }

    /// Images and embedded resources reach the provider as OpenAI multimodal
    /// parts (`image_url` data URI + `[文件: …]` text), and the transcript
    /// stores the user turn as `Content::Parts`.
    #[tokio::test(flavor = "current_thread")]
    async fn prompt_sends_multimodal_parts_to_provider() {
        let (addr, captured, server) = capture_server().await;
        let dir = provider_config(addr);
        // `deepseek-chat` has no vision; use a vision-capable id so images are
        // forwarded (non-vision models strip image parts before the provider).
        {
            let path = dir.join("nex-agent.json");
            let mut cfg: serde_json::Value =
                serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
            cfg["providers"][0]["models"][0]["id"] = serde_json::json!("gpt-4o");
            std::fs::write(&path, cfg.to_string()).unwrap();
        }
        tokio::task::LocalSet::new()
            .run_until(async {
                let (agent, conn, _, _) = duplex_pair(dir.clone());
                let session = conn
                    .new_session(acp::NewSessionRequest {
                        cwd: dir.clone(),
                        mcp_servers: vec![],
                        meta: None,
                    })
                    .await
                    .expect("new_session");
                let _ = conn
                    .prompt(acp::PromptRequest {
                        session_id: session.session_id.clone(),
                        prompt: vec![
                            acp::ContentBlock::Text(acp::TextContent {
                                annotations: None,
                                text: "看图".to_string(),
                                meta: None,
                            }),
                            acp::ContentBlock::Image(acp::ImageContent {
                                annotations: None,
                                data: "iVBORw0KGgo".to_string(),
                                mime_type: "image/png".to_string(),
                                uri: None,
                                meta: None,
                            }),
                            acp::ContentBlock::Resource(acp::EmbeddedResource {
                                annotations: None,
                                resource: acp::EmbeddedResourceResource::TextResourceContents(
                                    acp::TextResourceContents {
                                        mime_type: Some("text/plain".to_string()),
                                        text: "文件内容在这里".to_string(),
                                        uri: "file:///tmp/seed.txt".to_string(),
                                        meta: None,
                                    },
                                ),
                                meta: None,
                            }),
                        ],
                        meta: None,
                    })
                    .await
                    .expect("prompt");

                let body = captured.lock().unwrap().clone().expect("request body");
                assert!(body.contains("image_url"), "body: {body}");
                assert!(
                    body.contains("data:image/png;base64,iVBORw0KGgo"),
                    "body: {body}"
                );
                assert!(
                    body.contains("[文件: file:///tmp/seed.txt]"),
                    "body: {body}"
                );
                assert!(body.contains("文件内容在这里"), "body: {body}");

                let sessions = agent.inner.sessions.borrow();
                let s = sessions
                    .get(session.session_id.0.as_ref())
                    .expect("session");
                let Some(Content::Parts(parts)) = &s.history[1].content else {
                    panic!("user turn must be stored as parts");
                };
                assert_eq!(parts.len(), 3);
                assert_eq!(parts[0].text.as_deref(), Some("看图"));
                assert!(parts[1].image_url.is_some());
                assert!(parts[2].text.as_deref().unwrap().contains("文件内容在这里"));
            })
            .await;
        tokio::time::timeout(std::time::Duration::from_secs(5), server)
            .await
            .expect("server timed out")
            .unwrap();
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// `/name args` in the user text expands to the command template body
    /// (`$ARGUMENTS` substituted) before it reaches the provider; unknown
    /// commands pass through untouched.
    #[tokio::test(flavor = "current_thread")]
    async fn slash_command_expands_before_provider() {
        let (addr, _, server) = capture_server().await;
        let dir = provider_config(addr);
        let cmds = dir.join(".nex/commands");
        std::fs::create_dir_all(&cmds).unwrap();
        std::fs::write(
            cmds.join("review.md"),
            "---\ndescription: Review code.\nargument-hint: scope\n---\nReview $ARGUMENTS carefully, focusing on correctness.\n",
        )
        .unwrap();

        tokio::task::LocalSet::new()
            .run_until(async {
                let (agent, conn, _, _) = duplex_pair(dir.clone());
                let session = conn
                    .new_session(acp::NewSessionRequest {
                        cwd: dir.clone(),
                        mcp_servers: vec![],
                        meta: None,
                    })
                    .await
                    .expect("new_session");
                let prompt_text = |text: &str| acp::PromptRequest {
                    session_id: session.session_id.clone(),
                    prompt: vec![acp::ContentBlock::from(text)],
                    meta: None,
                };

                let _ = conn
                    .prompt(prompt_text("/review src/main.rs"))
                    .await
                    .expect("prompt");
                let _ = conn.prompt(prompt_text("/nope hi")).await.expect("prompt");

                let sessions = agent.inner.sessions.borrow();
                let s = sessions
                    .get(session.session_id.0.as_ref())
                    .expect("session");
                let users: Vec<&str> = s
                    .history
                    .iter()
                    .filter(|m| m.role == "user")
                    .map(|m| {
                        m.content
                            .as_ref()
                            .and_then(Content::as_text)
                            .unwrap_or_default()
                    })
                    .collect();
                assert_eq!(users.len(), 2);
                assert!(
                    users[0].contains("Review src/main.rs carefully"),
                    "expansion missing: {}",
                    users[0]
                );
                assert_eq!(users[1], "/nope hi", "unknown commands pass through");
            })
            .await;
        tokio::time::timeout(std::time::Duration::from_secs(5), server)
            .await
            .expect("server timed out")
            .unwrap();
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// `new_session` publishes the slash-command catalog over the wire so the
    /// Composer popover can render it (`AvailableCommandsUpdate`), and also
    /// embeds it in `_meta.availableCommands` for create-session race safety.
    #[tokio::test(flavor = "current_thread")]
    async fn new_session_publishes_available_commands() {
        let dir = std::env::temp_dir().join(format!("nex-cmds-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join(".nex/commands")).unwrap();
        std::fs::write(
            dir.join(".nex/commands/review.md"),
            "---\ndescription: Review code.\n---\nReview $ARGUMENTS\n",
        )
        .unwrap();
        tokio::task::LocalSet::new()
            .run_until(async {
                let (_, conn, _, updates) = duplex_pair(std::env::temp_dir());
                let resp = conn
                    .new_session(acp::NewSessionRequest {
                        cwd: dir.clone(),
                        mcp_servers: vec![],
                        meta: None,
                    })
                    .await
                    .expect("new_session");

                let meta_cmds = resp
                    .meta
                    .as_ref()
                    .and_then(|m| m.get("availableCommands"))
                    .and_then(|v| v.as_array())
                    .cloned()
                    .unwrap_or_default();
                assert!(
                    meta_cmds.iter().any(|c| c.get("name").and_then(|n| n.as_str()) == Some("review")),
                    "missing availableCommands in _meta: {:?}",
                    resp.meta
                );

                // Notifications travel over the duplex pipe asynchronously;
                // poll until the catalog arrives.
                let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(3);
                let found = loop {
                    if updates.borrow().iter().any(|u| {
                        u.starts_with("available_commands_update:")
                            && u.contains("review=Review code.")
                    }) {
                        break true;
                    }
                    if tokio::time::Instant::now() > deadline {
                        break false;
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
                };
                assert!(
                    found,
                    "catalog not published: {:?}",
                    updates.borrow().clone()
                );
            })
            .await;
        let _ = std::fs::remove_dir_all(&dir);
    }
}
