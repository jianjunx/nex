//! Event payloads shared between the agent backend and the frontend.
//!
//! Field names stay camelCase to match the payload interfaces in
//! `src/bridge/events.ts`. The event *names* are method-agnostic
//! (`agent-*`, not `acp-*`) so non-ACP agent transports can reuse them later.

use serde::Serialize;

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
    pub options: Vec<PermissionOption>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionOption {
    pub option_id: String,
    pub label: String,
}

/// Payload of the `agent-session-terminated` event, emitted when the agent
/// process exits or the connection drops.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionTerminated {
    pub session_id: String,
}
