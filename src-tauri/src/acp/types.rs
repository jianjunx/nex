use serde::Serialize;

/// Payload of the `acp-notification` event emitted to the frontend.
/// Field names must stay camelCase to match `AcpNotificationPayload` in
/// `src/bridge/events.ts`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpNotification {
    /// Nex-side session key (the id returned by `acp_create_session`), not the
    /// agent-internal ACP session id.
    pub session_id: String,
    /// Serialized `agent_client_protocol::SessionUpdate`.
    pub update: serde_json::Value,
}

/// Payload of the `acp-permission-request` event emitted to the frontend.
/// Field names must stay camelCase to match `AcpPermissionRequestPayload` in
/// `src/bridge/events.ts`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpPermissionRequest {
    pub session_id: String,
    /// Nex-generated correlation id; the frontend passes it back to
    /// `acp_respond_permission`.
    pub request_id: String,
    pub options: Vec<PermissionOption>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionOption {
    pub option_id: String,
    pub label: String,
}

/// Payload of the `acp-session-terminated` event emitted when the agent
/// process exits or the connection drops. Matches
/// `EVENTS.ACP_SESSION_TERMINATED` in `src/bridge/events.ts`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpSessionTerminated {
    pub session_id: String,
}
