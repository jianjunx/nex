// Event name constants - must match Rust emit() calls
export const EVENTS = {
  AGENT_NOTIFICATION: "agent-notification",
  AGENT_PERMISSION_REQUEST: "agent-permission-request",
  AGENT_PLAN_APPROVAL_REQUEST: "agent-plan-approval-request",
  AGENT_ASK_QUESTION_REQUEST: "agent-ask-question-request",
  AGENT_SESSION_TERMINATED: "agent-session-terminated",
  GIT_STATUS_CHANGED: "git-status-changed",
  TERMINAL_OUTPUT: "terminal-output",
  TERMINAL_EXITED: "terminal-exited",
  FS_CHANGED: "fs-changed",
  GIT_CREDENTIAL_REQUEST: "git-credential-request",
  UPDATE_DOWNLOAD_PROGRESS: "update-download-progress",
  APP_EXIT_REQUESTED: "app-exit-requested",
} as const;

export interface AgentNotificationPayload {
  sessionId: string;
  /** Backend prompt generation; late events with an older seq stay in that turn. */
  promptSeq?: number;
  update: unknown; // SessionUpdate (ACP)
}

export interface AgentPermissionRequestPayload {
  sessionId: string;
  requestId: string;
  toolCallId?: string | null;
  toolTitle?: string | null;
  toolKind?: string | null;
  /** Serialized ACP ToolCallContent[] */
  toolContent?: unknown;
  toolRawInput?: unknown;
  options: { optionId: string; label: string; kind?: string | null }[];
}

export interface CursorTodoPayload {
  id: string;
  content: string;
  status: string;
}

/** Cursor `cursor/create_plan` — blocks the agent until the user responds. */
export interface AgentPlanApprovalRequestPayload {
  sessionId: string;
  requestId: string;
  name?: string | null;
  overview?: string | null;
  plan: string;
  todos: CursorTodoPayload[];
}

export interface AskQuestionOptionPayload {
  id: string;
  label: string;
}

export interface AskQuestionItemPayload {
  id: string;
  prompt: string;
  options: AskQuestionOptionPayload[];
  allowMultiple: boolean;
}

export interface AskQuestionAnswerPayload {
  questionId: string;
  selectedOptionIds: string[];
}

/** Cursor `cursor/ask_question` — blocks until the user answers or skips. */
export interface AgentAskQuestionRequestPayload {
  sessionId: string;
  requestId: string;
  title?: string | null;
  questions: AskQuestionItemPayload[];
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

export interface UpdateDownloadProgressPayload {
  downloaded: number;
  total: number | null;
  /** 0..=100; null when the server sent no Content-Length. */
  percent: number | null;
}
