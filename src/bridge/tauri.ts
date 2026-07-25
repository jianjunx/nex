import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { COMMANDS } from "./commands";
import { EVENTS, type AcpNotificationPayload, type AcpPermissionRequestPayload, type TerminalOutputPayload, type FsChangedPayload } from "./events";

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

export async function conversationCreate(projectId: string, agentType: string): Promise<Conversation> {
  return invoke(COMMANDS.CONVERSATION_CREATE, { projectId, agentType });
}

export async function conversationList(projectId: string): Promise<Conversation[]> {
  return invoke(COMMANDS.CONVERSATION_LIST, { projectId });
}

export async function conversationGetMessages(conversationId: string, limit = 50, offset = 0): Promise<Message[]> {
  return invoke(COMMANDS.CONVERSATION_GET_MESSAGES, { conversationId, limit, offset });
}

// --- ACP ---
export async function acpCreateSession(conversationId: string, agentCommand: string, cwd: string): Promise<string> {
  return invoke(COMMANDS.ACP_CREATE_SESSION, { conversationId, agentCommand, cwd });
}

export async function acpSendPrompt(sessionId: string, content: string): Promise<void> {
  return invoke(COMMANDS.ACP_SEND_PROMPT, { sessionId, content });
}

export async function acpCancel(sessionId: string): Promise<void> {
  return invoke(COMMANDS.ACP_CANCEL, { sessionId });
}

export async function acpRespondPermission(requestId: string, optionId: string | null): Promise<void> {
  return invoke(COMMANDS.ACP_RESPOND_PERMISSION, { requestId, optionId });
}

export async function acpCloseSession(sessionId: string): Promise<void> {
  return invoke(COMMANDS.ACP_CLOSE_SESSION, { sessionId });
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

// --- Event Listeners ---
export function onAcpNotification(cb: (payload: AcpNotificationPayload) => void): Promise<UnlistenFn> {
  return listen(EVENTS.ACP_NOTIFICATION, (e) => cb(e.payload as AcpNotificationPayload));
}

export function onAcpPermissionRequest(cb: (payload: AcpPermissionRequestPayload) => void): Promise<UnlistenFn> {
  return listen(EVENTS.ACP_PERMISSION_REQUEST, (e) => cb(e.payload as AcpPermissionRequestPayload));
}

export function onAcpSessionTerminated(cb: (payload: { sessionId: string }) => void): Promise<UnlistenFn> {
  return listen(EVENTS.ACP_SESSION_TERMINATED, (e) => cb(e.payload as { sessionId: string }));
}

export function onTerminalOutput(cb: (payload: TerminalOutputPayload) => void): Promise<UnlistenFn> {
  return listen(EVENTS.TERMINAL_OUTPUT, (e) => cb(e.payload as TerminalOutputPayload));
}

export function onFsChanged(cb: (payload: FsChangedPayload) => void): Promise<UnlistenFn> {
  return listen(EVENTS.FS_CHANGED, (e) => cb(e.payload as FsChangedPayload));
}
