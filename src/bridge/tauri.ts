import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { COMMANDS } from "./commands";
import { EVENTS, type AgentNotificationPayload, type AgentPermissionRequestPayload, type TerminalOutputPayload, type TerminalExitedPayload, type FsChangedPayload, type GitStatusChangedPayload } from "./events";

// --- Projects ---
export interface Project {
  id: string;
  name: string;
  path: string;
  created_at: number;
  last_opened: number;
}

export async function projectOpen(path: string): Promise<Project> {
  return invoke(COMMANDS.PROJECT_OPEN, { path });
}

export async function projectList(): Promise<Project[]> {
  return invoke(COMMANDS.PROJECT_LIST);
}

// --- Conversations ---
export interface Conversation {
  id: string;
  project_id: string;
  title: string;
  agent_type: string;
  status: string;
  created_at: number;
  updated_at: number;
}

export interface Message {
  id: string;
  conversation_id: string;
  role: string;
  content: string;
  tool_summary: string | null;
  timestamp: number;
  sequence: number;
}

export interface ThreadEntryPayloadDto {
  kind: string;
  sequence: number;
  timestamp: number;
  /** Full ThreadEntry payload serialized as JSON. */
  payload: unknown;
}

export async function conversationCreate(projectId: string, agentType: string): Promise<Conversation> {
  return invoke(COMMANDS.CONVERSATION_CREATE, { projectId, agentType });
}

export async function conversationList(projectId: string): Promise<Conversation[]> {
  return invoke(COMMANDS.CONVERSATION_LIST, { projectId });
}

export async function conversationGetMessages(conversationId: string, limit = 50, offset = 0): Promise<Message[]> {
  return invoke(COMMANDS.CONVERSATION_GET_MESSAGES, { conversationId, limit, offset });
}

export async function conversationUpdateTitle(conversationId: string, title: string): Promise<void> {
  return invoke(COMMANDS.CONVERSATION_UPDATE_TITLE, { conversationId, title });
}

export async function conversationGetThreadEntries(conversationId: string): Promise<ThreadEntryPayloadDto[]> {
  return invoke(COMMANDS.CONVERSATION_GET_THREAD_ENTRIES, { conversationId });
}

export async function conversationReplaceThreadEntries(
  conversationId: string,
  entries: ThreadEntryPayloadDto[],
): Promise<void> {
  return invoke(COMMANDS.CONVERSATION_REPLACE_THREAD_ENTRIES, {
    conversationId,
    entries,
  });
}

export async function conversationAppendMessage(
  conversationId: string,
  role: string,
  content: string,
  toolSummary?: string | null,
): Promise<Message> {
  return invoke(COMMANDS.CONVERSATION_APPEND_MESSAGE, {
    conversationId,
    role,
    content,
    toolSummary: toolSummary ?? null,
  });
}

// --- Agent (open ACP registry + custom servers) ---
/** One row in the New-Conversation agent dropdown. */
export interface ServerDescriptor {
  id: string;
  name: string;
  version: string;
  description: string;
  icon: string | null;
  kind: "registry" | "custom";
}

/** A user-defined ACP server (persisted on the Rust side). */
export interface CustomServer {
  id: string;
  name: string;
  command: string;
  env: Record<string, string>;
}

/** Which agent to start a session against; serialized to Rust's `SessionTarget`. */
export type SessionTarget =
  | { type: "registry"; id: string }
  | { type: "custom"; id: string };

export async function agentListServers(): Promise<ServerDescriptor[]> {
  return invoke(COMMANDS.AGENT_LIST_SERVERS);
}

export async function agentListAllServers(): Promise<ServerDescriptor[]> {
  return invoke(COMMANDS.AGENT_LIST_ALL_SERVERS);
}

export async function agentRefreshRegistry(): Promise<void> {
  return invoke(COMMANDS.AGENT_REFRESH_REGISTRY);
}

export interface SessionModeDto {
  id: string;
  name: string;
  description?: string | null;
}

export interface SessionModesDto {
  currentModeId: string;
  availableModes: SessionModeDto[];
}

export interface SessionModelDto {
  id: string;
  name: string;
  description?: string | null;
}

export interface SessionModelsDto {
  currentModelId: string;
  availableModels: SessionModelDto[];
}

export interface CreateSessionResult {
  sessionId: string;
  modes?: SessionModesDto | null;
  models?: SessionModelsDto | null;
}

export type PromptBlock =
  | { type: "text"; text: string }
  | { type: "resource"; uri: string; mime_type?: string | null; text: string }
  | { type: "resource_link"; uri: string; name: string; mime_type?: string | null };

export async function agentCreateSession(
  conversationId: string,
  target: SessionTarget,
  cwd: string,
): Promise<CreateSessionResult> {
  return invoke(COMMANDS.AGENT_CREATE_SESSION, { conversationId, target, cwd });
}

export async function agentSendPrompt(sessionId: string, blocks: PromptBlock[]): Promise<void> {
  return invoke(COMMANDS.AGENT_SEND_PROMPT, { sessionId, blocks });
}

export async function agentSetSessionMode(sessionId: string, modeId: string): Promise<void> {
  return invoke(COMMANDS.AGENT_SET_SESSION_MODE, { sessionId, modeId });
}

export async function agentSetSessionModel(sessionId: string, modelId: string): Promise<void> {
  return invoke(COMMANDS.AGENT_SET_SESSION_MODEL, { sessionId, modelId });
}

export async function agentCancel(sessionId: string): Promise<void> {
  return invoke(COMMANDS.AGENT_CANCEL, { sessionId });
}

export async function agentRespondPermission(requestId: string, optionId: string | null): Promise<void> {
  return invoke(COMMANDS.AGENT_RESPOND_PERMISSION, { requestId, optionId });
}

export async function agentCloseSession(sessionId: string): Promise<void> {
  return invoke(COMMANDS.AGENT_CLOSE_SESSION, { sessionId });
}

export async function agentCustomUpsert(server: CustomServer): Promise<void> {
  return invoke(COMMANDS.AGENT_CUSTOM_UPSERT, { server });
}

export async function agentCustomDelete(id: string): Promise<void> {
  return invoke(COMMANDS.AGENT_CUSTOM_DELETE, { id });
}

// --- Git ---
export interface GitFileChange {
  path: string;
  status: "modified" | "added" | "deleted" | "untracked";
  staged: boolean;
}

export interface GitStatus {
  branch: string;
  ahead: number;
  behind: number;
  files: GitFileChange[];
}

export async function gitStatus(projectPath: string): Promise<GitStatus> {
  return invoke(COMMANDS.GIT_STATUS, { projectPath });
}

export async function gitDiff(projectPath: string, file: string, staged: boolean): Promise<string> {
  return invoke(COMMANDS.GIT_DIFF, { projectPath, file, staged });
}

export async function gitStage(projectPath: string, files: string[]): Promise<void> {
  return invoke(COMMANDS.GIT_STAGE, { projectPath, files });
}

export async function gitUnstage(projectPath: string, files: string[]): Promise<void> {
  return invoke(COMMANDS.GIT_UNSTAGE, { projectPath, files });
}

export async function gitCommit(projectPath: string, message: string): Promise<string> {
  return invoke(COMMANDS.GIT_COMMIT, { projectPath, message });
}

// --- Terminal ---
export async function terminalCreate(projectPath: string, shell?: string): Promise<string> {
  return invoke(COMMANDS.TERMINAL_CREATE, { projectPath, shell });
}

export async function terminalWrite(terminalId: string, data: string): Promise<void> {
  return invoke(COMMANDS.TERMINAL_WRITE, { terminalId, data });
}

export async function terminalResize(terminalId: string, cols: number, rows: number): Promise<void> {
  return invoke(COMMANDS.TERMINAL_RESIZE, { terminalId, cols, rows });
}

export async function terminalKill(terminalId: string): Promise<void> {
  return invoke(COMMANDS.TERMINAL_KILL, { terminalId });
}

// --- FS ---
export interface FsNode {
  name: string;
  path: string;
  is_dir: boolean;
  size?: number;
}

export async function fsReadTree(projectPath: string): Promise<FsNode[]> {
  return invoke(COMMANDS.FS_READ_TREE, { projectPath });
}

export async function fsExpandDir(dirPath: string): Promise<FsNode[]> {
  return invoke(COMMANDS.FS_EXPAND_DIR, { dirPath });
}

export async function fsReadFile(filePath: string): Promise<{ is_text: boolean; content?: string; size: number }> {
  return invoke(COMMANDS.FS_READ_FILE, { filePath });
}

export async function fsWriteFile(filePath: string, content: string): Promise<void> {
  return invoke(COMMANDS.FS_WRITE_FILE, { filePath, content });
}

export async function appearanceSetTheme(theme: string): Promise<void> {
  return invoke(COMMANDS.APPEARANCE_SET_THEME, { theme });
}

export interface SearchMatch {
  path: string;
  name: string;
  line: number | null;
  text: string;
}

export async function fsSearch(projectPath: string, query: string): Promise<SearchMatch[]> {
  return invoke(COMMANDS.FS_SEARCH, { projectPath, query });
}

export async function fsWatchStart(projectPath: string): Promise<void> {
  return invoke(COMMANDS.FS_WATCH_START, { projectPath });
}

export async function fsCreateFile(parentDir: string, name: string): Promise<void> {
  return invoke(COMMANDS.FS_CREATE_FILE, { parentDir, name });
}

export async function fsCreateDir(parentDir: string, name: string): Promise<void> {
  return invoke(COMMANDS.FS_CREATE_DIR, { parentDir, name });
}

// --- Event Listeners ---
export function onAgentNotification(cb: (payload: AgentNotificationPayload) => void): Promise<UnlistenFn> {
  return listen(EVENTS.AGENT_NOTIFICATION, (e) => cb(e.payload as AgentNotificationPayload));
}

export function onAgentPermissionRequest(cb: (payload: AgentPermissionRequestPayload) => void): Promise<UnlistenFn> {
  return listen(EVENTS.AGENT_PERMISSION_REQUEST, (e) => cb(e.payload as AgentPermissionRequestPayload));
}

export function onAgentSessionTerminated(cb: (payload: { sessionId: string }) => void): Promise<UnlistenFn> {
  return listen(EVENTS.AGENT_SESSION_TERMINATED, (e) => cb(e.payload as { sessionId: string }));
}

export function onTerminalOutput(cb: (payload: TerminalOutputPayload) => void): Promise<UnlistenFn> {
  return listen(EVENTS.TERMINAL_OUTPUT, (e) => cb(e.payload as TerminalOutputPayload));
}

export function onTerminalExited(cb: (payload: TerminalExitedPayload) => void): Promise<UnlistenFn> {
  return listen(EVENTS.TERMINAL_EXITED, (e) => cb(e.payload as TerminalExitedPayload));
}

export function onFsChanged(cb: (payload: FsChangedPayload) => void): Promise<UnlistenFn> {
  return listen(EVENTS.FS_CHANGED, (e) => cb(e.payload as FsChangedPayload));
}

export function onGitStatusChanged(cb: (payload: GitStatusChangedPayload) => void): Promise<UnlistenFn> {
  return listen(EVENTS.GIT_STATUS_CHANGED, (e) => cb(e.payload as GitStatusChangedPayload));
}
