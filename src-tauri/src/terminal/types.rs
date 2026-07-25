use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct TerminalInfo {
    pub id: String,
    pub title: String,
}

/// Payload of the `terminal-output` event emitted to the frontend.
/// Field names must stay camelCase to match `TerminalOutputPayload` in
/// `src/bridge/events.ts`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalOutputPayload {
    pub terminal_id: String,
    pub data: String,
}

/// Payload of the `terminal-exited` event emitted when a shell exits
/// (EOF / read error in the reader thread). Field names must stay
/// camelCase to match the frontend `TerminalExitedPayload`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalExitedPayload {
    pub terminal_id: String,
}
