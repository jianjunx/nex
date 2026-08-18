//! Event payloads shared between the agent backend and the frontend.
//!
//! Field names stay camelCase to match the payload interfaces in
//! `src/bridge/events.ts`. The event *names* are method-agnostic
//! (`agent-*`, not `acp-*`) so non-ACP agent transports can reuse them later.

use serde::{Deserialize, Serialize};

/// Payload of the `agent-notification` event.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentNotification {
    /// Nex-side session key (the id returned by `agent_create_session`), not
    /// the agent-internal session id.
    pub session_id: String,
    /// Monotonic per-session prompt generation. Frontend uses this to keep
    /// late `session/update` events inside the turn that produced them, even
    /// when a newer user message is already on the thread.
    pub prompt_seq: u64,
    /// Serialized session update (e.g. an ACP `SessionUpdate`).
    pub update: serde_json::Value,
}

/// Payload of the `agent-permission-request` event.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentPermissionRequest {
    pub session_id: String,
    /// Nex-generated correlation id; the frontend passes it back to
    /// `agent_respond_permission`.
    pub request_id: String,
    /// ACP tool call id when the permission is tied to a tool invocation.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    /// Human-readable tool title from the permission's `toolCall` update.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_title: Option<String>,
    /// ACP `ToolKind` as snake_case when present on the update.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_kind: Option<String>,
    /// Serialized `ToolCallContent[]` from the update (AskUserQuestion text, diffs, …).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_content: Option<serde_json::Value>,
    /// Raw tool input (often holds structured question payloads).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_raw_input: Option<serde_json::Value>,
    pub options: Vec<PermissionOption>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionOption {
    pub option_id: String,
    pub label: String,
    /// ACP `PermissionOptionKind` as snake_case (`allow_once`, `allow_always`, …).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
}

/// Payload of the `agent-plan-approval-request` event (Cursor `cursor/create_plan`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentPlanApprovalRequest {
    pub session_id: String,
    /// Nex-generated correlation id; the frontend passes it back to
    /// `agent_respond_plan`.
    pub request_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub overview: Option<String>,
    /// Markdown plan body from Cursor.
    pub plan: String,
    pub todos: Vec<CursorTodoDto>,
}

/// One todo item from Cursor `create_plan` / `update_todos`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CursorTodoDto {
    pub id: String,
    pub content: String,
    pub status: String,
}

/// Payload of the `agent-ask-question-request` event (Cursor `cursor/ask_question`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentAskQuestionRequest {
    pub session_id: String,
    /// Nex-generated correlation id; the frontend passes it back to
    /// `agent_respond_ask_question`.
    pub request_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub questions: Vec<AskQuestionItemDto>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AskQuestionItemDto {
    pub id: String,
    pub prompt: String,
    pub options: Vec<AskQuestionOptionDto>,
    #[serde(default)]
    pub allow_multiple: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AskQuestionOptionDto {
    pub id: String,
    pub label: String,
}

/// One answered question returned by the UI for `cursor/ask_question`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AskQuestionAnswerDto {
    pub question_id: String,
    pub selected_option_ids: Vec<String>,
}

/// Payload of the `agent-session-terminated` event, emitted when the agent
/// process exits or the connection drops.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionTerminated {
    pub session_id: String,
}

/// One content block in a prompt turn (mirrors ACP `ContentBlock` for the wire).
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum PromptBlock {
    Text { text: String },
    Image {
        data: String,
        mime_type: String,
        #[serde(default)]
        uri: Option<String>,
    },
    Resource {
        uri: String,
        #[serde(default)]
        mime_type: Option<String>,
        text: String,
    },
    ResourceLink {
        uri: String,
        name: String,
        #[serde(default)]
        mime_type: Option<String>,
    },
}

/// Result of `agent_create_session`, including initial mode/model/config state.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateSessionResult {
    pub session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modes: Option<SessionModesDto>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub models: Option<SessionModelsDto>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub config_options: Option<Vec<SessionConfigOptionDto>>,
    /// Slash-command catalog from `_meta.availableCommands` (NexAgent).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub available_commands: Option<Vec<AvailableCommandDto>>,
}

/// One slash command advertised to the Composer.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AvailableCommandDto {
    pub name: String,
    pub description: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_hint: Option<String>,
}

/// Result of `agent_send_prompt` — enough for post-turn client hooks.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptResultDto {
    /// True when the native agent successfully wrote/edited a workspace file
    /// this turn (`write_file` / `edit_file` / `multi_edit`). Used to gate
    /// auto-`/review`; bash-only turns stay false.
    pub had_mutations: bool,
    /// ACP stop reason (`end_turn` / `max_tokens` / `cancelled` / …).
    /// The prompt RPC itself succeeds on cancel; the client must not treat
    /// `cancelled` as a completed turn.
    pub stop_reason: String,
    /// Per-turn context-engine telemetry. Present for the native agent;
    /// omitted for external ACP agents that do not populate `_meta.contextStats`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_stats: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionModesDto {
    pub current_mode_id: String,
    pub available_modes: Vec<SessionModeDto>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionModeDto {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionModelsDto {
    pub current_model_id: String,
    pub available_models: Vec<SessionModelDto>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionModelDto {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// When known (NexAgent), whether the model accepts image inputs.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vision: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionConfigOptionDto {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    pub current_value_id: String,
    pub options: Vec<SessionConfigValueDto>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionConfigValueDto {
    pub id: String,
    pub name: String,
}
