// Command names - must match Rust #[tauri::command] function names
export const COMMANDS = {
  // Projects
  PROJECT_OPEN: "project_open",
  PROJECT_LIST: "project_list",
  // Conversations
  CONVERSATION_CREATE: "conversation_create",
  CONVERSATION_LIST: "conversation_list",
  CONVERSATION_GET_MESSAGES: "conversation_get_messages",
  // ACP
  ACP_CREATE_SESSION: "acp_create_session",
  ACP_SEND_PROMPT: "acp_send_prompt",
  ACP_CANCEL: "acp_cancel",
  ACP_RESPOND_PERMISSION: "acp_respond_permission",
  ACP_CLOSE_SESSION: "acp_close_session",
  // Git
  GIT_STATUS: "git_status",
  GIT_DIFF: "git_diff",
  GIT_LOG: "git_log",
  GIT_STAGE: "git_stage",
  GIT_UNSTAGE: "git_unstage",
  GIT_COMMIT: "git_commit",
  GIT_BRANCH_LIST: "git_branch_list",
  GIT_CHECKOUT: "git_checkout",
  // Terminal
  TERMINAL_CREATE: "terminal_create",
  TERMINAL_WRITE: "terminal_write",
  TERMINAL_RESIZE: "terminal_resize",
  TERMINAL_KILL: "terminal_kill",
  // FS
  FS_READ_TREE: "fs_read_tree",
  FS_EXPAND_DIR: "fs_expand_dir",
  FS_READ_FILE: "fs_read_file",
} as const;
