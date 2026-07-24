// Event name constants - must match Rust emit() calls
export const EVENTS = {
  ACP_NOTIFICATION: "acp-notification",
  ACP_PERMISSION_REQUEST: "acp-permission-request",
  ACP_SESSION_TERMINATED: "acp-session-terminated",
  GIT_STATUS_CHANGED: "git-status-changed",
  TERMINAL_OUTPUT: "terminal-output",
  FS_CHANGED: "fs-changed",
} as const;

export interface AcpNotificationPayload {
  sessionId: string;
  update: unknown; // SessionUpdate from ACP
}

export interface AcpPermissionRequestPayload {
  sessionId: string;
  requestId: string;
  options: { optionId: string; label: string }[];
}

export interface GitStatusChangedPayload {
  projectPath: string;
}

export interface TerminalOutputPayload {
  terminalId: string;
  data: string;
}

export interface FsChangedPayload {
  projectPath: string;
  paths: string[];
}
