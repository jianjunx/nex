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
