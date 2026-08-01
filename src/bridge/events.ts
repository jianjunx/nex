// Event name constants - must match Rust emit() calls
export const EVENTS = {
  AGENT_NOTIFICATION: "agent-notification",
  AGENT_PERMISSION_REQUEST: "agent-permission-request",
  AGENT_SESSION_TERMINATED: "agent-session-terminated",
  GIT_STATUS_CHANGED: "git-status-changed",
  TERMINAL_OUTPUT: "terminal-output",
  TERMINAL_EXITED: "terminal-exited",
  FS_CHANGED: "fs-changed",
  GIT_CREDENTIAL_REQUEST: "git-credential-request",
} as const;

export interface AgentNotificationPayload {
  sessionId: string;
  update: unknown; // SessionUpdate (ACP)
}

export interface AgentPermissionRequestPayload {
  sessionId: string;
  requestId: string;
  toolCallId?: string | null;
  options: { optionId: string; label: string; kind?: string | null }[];
}

export interface GitStatusChangedPayload {
  projectPath: string;
}

export interface GitCredentialRequestPayload {
  requestId: string;
  url: string;
  usernameHint: string | null;
  kind: "https" | "ssh-passphrase";
}

export interface TerminalOutputPayload {
  terminalId: string;
  data: string;
}

export interface TerminalExitedPayload {
  terminalId: string;
}

export interface FsChangedPayload {
  projectPath: string;
  paths: string[];
}
