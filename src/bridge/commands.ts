// Command names - must match Rust #[tauri::command] function names
export const COMMANDS = {
  // Projects
  PROJECT_OPEN: "project_open",
  PROJECT_LIST: "project_list",
  // Conversations
  CONVERSATION_CREATE: "conversation_create",
  CONVERSATION_LIST: "conversation_list",
  CONVERSATION_GET_MESSAGES: "conversation_get_messages",
  CONVERSATION_UPDATE_TITLE: "conversation_update_title",
  // Agent (open ACP registry + custom servers)
  AGENT_LIST_SERVERS: "agent_list_servers",
  AGENT_LIST_ALL_SERVERS: "agent_list_all_servers",
  AGENT_REFRESH_REGISTRY: "agent_refresh_registry",
  AGENT_CREATE_SESSION: "agent_create_session",
  AGENT_SEND_PROMPT: "agent_send_prompt",
  AGENT_SET_SESSION_MODE: "agent_set_session_mode",
  AGENT_SET_SESSION_MODEL: "agent_set_session_model",
  AGENT_CANCEL: "agent_cancel",
  AGENT_RESPOND_PERMISSION: "agent_respond_permission",
  AGENT_CLOSE_SESSION: "agent_close_session",
  AGENT_CUSTOM_UPSERT: "agent_custom_upsert",
  AGENT_CUSTOM_DELETE: "agent_custom_delete",
  // Git
  GIT_STATUS: "git_status",
  GIT_DIFF: "git_diff",
  GIT_LOG: "git_log",
  GIT_STAGE: "git_stage",
  GIT_UNSTAGE: "git_unstage",
  GIT_COMMIT: "git_commit",
  // Terminal
  TERMINAL_CREATE: "terminal_create",
  TERMINAL_WRITE: "terminal_write",
  TERMINAL_RESIZE: "terminal_resize",
  TERMINAL_KILL: "terminal_kill",
  // FS
  FS_READ_TREE: "fs_read_tree",
  FS_EXPAND_DIR: "fs_expand_dir",
  FS_READ_FILE: "fs_read_file",
  FS_WRITE_FILE: "fs_write_file",
  FS_WATCH_START: "fs_watch_start",
  FS_SEARCH: "fs_search",
  FS_CREATE_FILE: "fs_create_file",
  FS_CREATE_DIR: "fs_create_dir",
  // Appearance
  APPEARANCE_SET_THEME: "appearance_set_theme",
} as const;
